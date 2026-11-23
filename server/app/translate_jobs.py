"""Background translation jobs: one worker thread, one episode at a time (the CPU is slow)."""

import json
import logging
import queue
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import Engine
from sqlmodel import Session, select

from app.llm import LLM, LLMError, name_candidates, translate_batch
from app.models import SubtitleLine

log = logging.getLogger("sensei.llm")
BATCH = 12
CONTEXT = 2


@dataclass
class JobState:
    episode_id: int
    queued: bool = True
    running: bool = False
    error: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    failed_lines: int = 0
    _cancel: bool = field(default=False, repr=False)


class Translator:
    def __init__(self, engine: Engine, llm: LLM, synchronous: bool = False):
        self.engine = engine
        self.llm = llm
        self.synchronous = synchronous  # tests: run jobs inline
        self.jobs: dict[int, JobState] = {}
        self._queue: queue.Queue[int] = queue.Queue()
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None

    def cancel(self, episode_id: int) -> None:
        """Stop a queued or running job (its lines are being replaced or deleted)."""
        with self._lock:
            if job := self.jobs.get(episode_id):
                job._cancel = True

    def enqueue(self, episode_id: int) -> JobState:
        with self._lock:
            job = self.jobs.get(episode_id)
            if job and (job.queued or job.running) and not job._cancel:
                return job
            job = self.jobs[episode_id] = JobState(episode_id=episode_id)
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
        except LLMError as e:
            job.error = str(e)
            log.warning("translation of episode %s stopped: %s", job.episode_id, e)
        except Exception as e:  # never kill the worker thread
            job.error = f"internal error: {e}"
            log.exception("translation of episode %s failed", job.episode_id)
        finally:
            job.running, job.finished_at = False, datetime.now(UTC)
