"""Background translation jobs: one worker thread, one episode at a time (the CPU is slow)."""

import json
import logging
import queue
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import Engine
from sqlmodel import Session, func, select

from app.llm import LLM, LLMError, name_candidates, translate_batch
from app.models import Episode, SubtitleLine

log = logging.getLogger("sensei.llm")
BATCH = 12
CONTEXT = 2
# The LLM laptop sleeps: retry an unreachable LLM after 1, 2, 4 … min, at most every 30 min.
RETRY_FIRST_S = 60
RETRY_MAX_S = 30 * 60


def _timer(delay_s: float, fn: Callable[[], None]) -> None:
    t = threading.Timer(delay_s, fn)
    t.daemon = True
    t.start()


@dataclass
class JobState:
    episode_id: int
    queued: bool = True
    running: bool = False
    error: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    failed_lines: int = 0
    attempts: int = 0  # consecutive runs that found the LLM unreachable
    retry_at: datetime | None = None
    _cancel: bool = field(default=False, repr=False)


class Translator:
    def __init__(
        self,
        engine: Engine,
        llm: LLM,
        synchronous: bool = False,
        schedule: Callable[[float, Callable[[], None]], None] = _timer,
    ):
        self.engine = engine
        self.llm = llm
        self.synchronous = synchronous  # tests: run jobs inline
        self.schedule = schedule  # retry timer (tests replace it)
        self.jobs: dict[int, JobState] = {}
        self._queue: queue.Queue[int] = queue.Queue()
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None

    def cancel(self, episode_id: int) -> None:
        """Stop a queued or running job (its lines are being replaced or deleted)."""
        with self._lock:
            if job := self.jobs.get(episode_id):
                job._cancel = True

    def pending_episodes(self) -> list[int]:
        """Episodes with untranslated lines, oldest first."""
        with Session(self.engine) as session:
            rows = session.exec(
                select(SubtitleLine.episode_id)
                .join(Episode, Episode.id == SubtitleLine.episode_id)  # type: ignore[arg-type]
                .where(SubtitleLine.translation_en.is_(None))  # type: ignore[union-attr]
                .group_by(SubtitleLine.episode_id)
                .order_by(func.min(Episode.created_at), SubtitleLine.episode_id)
            ).all()
        return list(rows)

    def resume(self) -> list[int]:
        """At startup: queue every episode that still has untranslated lines."""
        ids = self.pending_episodes()
        for episode_id in ids:
            self.enqueue(episode_id)
        if ids:
            log.info("resuming translation of %d episode(s): %s", len(ids), ids)
        return ids

    def enqueue(self, episode_id: int, _retry: JobState | None = None) -> JobState:
        with self._lock:
            job = self.jobs.get(episode_id)
            if _retry is not None:
                if job is not _retry or job._cancel:
                    return job or _retry  # replaced, cancelled or restarted meanwhile
                job.retry_at = None
            elif job and not job._cancel and (job.running or (job.queued and not job.retry_at)):
                return job  # already waiting in the queue or running (a retry wait runs now)
            else:
                job = self.jobs[episode_id] = JobState(episode_id=episode_id)
            job.queued = True
        if self.synchronous:
            self._run(job)
            return job
        self._queue.put(episode_id)
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._loop, name="translator", daemon=True)
            self._worker.start()
        return job

    def _loop(self) -> None:
        while True:
            try:
                episode_id = self._queue.get(timeout=60)
            except queue.Empty:
                return  # idle: let the thread end; enqueue starts a new one
            job = self.jobs.get(episode_id)
            if job and not job._cancel:
                self._run(job)

    def _run(self, job: JobState) -> None:
        job.queued, job.running, job.started_at = False, True, datetime.now(UTC)
        job.error = None
        unreachable = False
        try:
            with Session(self.engine) as session:
                lines = list(
                    session.exec(
                        select(SubtitleLine)
                        .where(SubtitleLine.episode_id == job.episode_id)
                        .order_by(SubtitleLine.idx)  # type: ignore[arg-type]
                    ).all()
                )
                todo = [i for i, line in enumerate(lines) if not line.translation_en]
                names = name_candidates([json.loads(line.tokens_json) for line in lines])
                for start in range(0, len(todo), BATCH):
                    if job._cancel:
                        return
                    idxs = todo[start : start + BATCH]
                    batch = [lines[i] for i in idxs]
                    first = idxs[0]
                    context = [line.text for line in lines[max(0, first - CONTEXT) : first]]
                    result = translate_batch(
                        self.llm, [line.text for line in batch], context, names
                    )
                    for k, line in enumerate(batch):
                        if k in result:
                            line.translation_en, line.translation_de = result[k]
                            session.add(line)
                        else:
                            job.failed_lines += 1
                    session.commit()
            job.attempts = 0
        except LLMError as e:
            job.error = str(e)
            unreachable = "unreachable" in str(e)
            log.warning("translation of episode %s stopped: %s", job.episode_id, e)
        except Exception as e:  # never kill the worker thread
            job.error = f"internal error: {e}"
            log.exception("translation of episode %s failed", job.episode_id)
        finally:
            job.running, job.finished_at = False, datetime.now(UTC)
        if unreachable and not job._cancel:
            delay = min(RETRY_FIRST_S * 2**job.attempts, RETRY_MAX_S)
            job.attempts += 1
            job.queued, job.retry_at = True, datetime.now(UTC) + timedelta(seconds=delay)
            self.schedule(delay, lambda: self.enqueue(job.episode_id, _retry=job))
