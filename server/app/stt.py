"""Speech-to-text (S-10): Japanese subtitles from an episode's audio, for anime that has no
Japanese subtitle file.

The model doesn't run on the home server (too little RAM for a good Japanese model): any
OpenAI-compatible `/v1/audio/transcriptions` endpoint does it, e.g. whisper.cpp's
`whisper-server` on the Precision's GPU (SENSEI_STT_BASE_URL). The server extracts 16 kHz mono
audio with ffmpeg, asks for SRT, and imports the result like a downloaded subtitle file.
Jobs run one at a time in a background thread; they live in memory (a restart forgets them).
"""

import logging
import queue
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import httpx

log = logging.getLogger("sensei.stt")


class STTError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class STT:
    def __init__(
        self,
        base_url: str,
        model: str = "",
        timeout: float = 3600,
        transport: httpx.BaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.http = httpx.Client(timeout=timeout, transport=transport)

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def status(self) -> tuple[bool, str]:
        if not self.configured:
            return False, "not configured (SENSEI_STT_BASE_URL)"
        root = httpx.URL(self.base_url).copy_with(path="/")
        try:
            r = self.http.get(root, timeout=5)
        except httpx.HTTPError as e:
            return False, f"unreachable: {e}"
        return (r.status_code < 500), f"HTTP {r.status_code}" if r.status_code >= 500 else "ok"

    def transcribe(self, wav: Path) -> bytes:
        """SRT bytes for a 16 kHz mono WAV file."""
        if not self.configured:
            raise STTError("speech-to-text is not configured (SENSEI_STT_BASE_URL)", 503)
        data = {"language": "ja", "response_format": "srt", "temperature": "0"}
        if self.model:
            data["model"] = self.model
        try:
            with wav.open("rb") as f:
                r = self.http.post(
                    f"{self.base_url}/audio/transcriptions",
                    files={"file": ("audio.wav", f, "audio/wav")},
                    data=data,
                )
        except httpx.HTTPError as e:
            raise STTError(f"speech-to-text server unreachable: {e}") from e
        if r.status_code >= 400:
            raise STTError(f"speech-to-text error {r.status_code}: {r.text[:200]}")
        return r.content


def extract_wav(src: Path, dst: Path) -> int:
    """16 kHz mono WAV of any audio/video file; returns its duration in ms."""
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(src), "-vn", "-ac", "1",
           "-ar", "16000", "-c:a", "pcm_s16le", str(dst)]  # fmt: skip
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=1800)
    except subprocess.TimeoutExpired as e:
        raise STTError("extracting the audio timed out", 422) from e
    if r.returncode != 0 or not dst.is_file() or dst.stat().st_size <= 44:
        raise STTError(
            f"can't read audio from the file: {r.stderr.decode(errors='replace')[-200:]}", 422
        )
    return (dst.stat().st_size - 44) * 1000 // (16_000 * 2)


@dataclass
class SttJob:
    id: int
    anime_title: str
    episode_number: float | None
    title: str | None
    filename: str
    path: Path = field(repr=False)
    status: str = "queued"  # queued | extracting | transcribing | importing | done | error
    duration_ms: int | None = None
    episode_id: int | None = None
    error: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    finished_at: datetime | None = None


ImportFn = Callable[[SttJob, bytes], int]  # (job, srt) → new episode id


class SttJobs:
    """One-at-a-time transcription queue."""

    def __init__(self, stt: STT, import_fn: ImportFn, synchronous: bool = False):
        self.stt = stt
        self.import_fn = import_fn
        self.synchronous = synchronous  # tests: run jobs inline
        self.jobs: dict[int, SttJob] = {}
        self._next_id = 1
        self._queue: queue.Queue[int] = queue.Queue()
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None

    def submit(
        self, path: Path, filename: str, anime_title: str, number: float | None, title: str | None
    ) -> SttJob:
        with self._lock:
            job = SttJob(self._next_id, anime_title, number, title, filename, path)
            self.jobs[job.id] = job
            self._next_id += 1
        if self.synchronous:
            self._run(job)
            return job
        self._queue.put(job.id)
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._loop, name="stt", daemon=True)
            self._worker.start()
        return job

    def _loop(self) -> None:
        while True:
            try:
                job_id = self._queue.get(timeout=60)
            except queue.Empty:
                return
            self._run(self.jobs[job_id])

    def _run(self, job: SttJob) -> None:
        job.started_at = datetime.now(UTC)
        wav = job.path.with_suffix(".16k.wav")
        t0 = time.monotonic()
        try:
            job.status = "extracting"
            job.duration_ms = extract_wav(job.path, wav)
            job.status = "transcribing"
            srt = self.stt.transcribe(wav)
            job.status = "importing"
            job.episode_id = self.import_fn(job, srt)
            job.status = "done"
            log.info("stt job %s: episode %s in %.0f s", job.id, job.episode_id,
                     time.monotonic() - t0)  # fmt: skip
        except STTError as e:
            job.status, job.error = "error", str(e)
            log.warning("stt job %s failed: %s", job.id, e)
        except Exception as e:  # never kill the worker thread
            job.status, job.error = "error", f"internal error: {e}"
            log.exception("stt job %s failed", job.id)
        finally:
            job.finished_at = datetime.now(UTC)
            job.path.unlink(missing_ok=True)
            wav.unlink(missing_ok=True)
