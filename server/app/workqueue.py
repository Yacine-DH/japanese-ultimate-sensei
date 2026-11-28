"""A queue with one background worker thread: started on first use, never exits.

Shared by translation and speech-to-text jobs. The old copies let an idle worker end after 60 s
and started a new one on the next job; a job put while the old worker was exiting could sit
"queued" until another job arrived (#188).
"""

import logging
import queue
import threading
from collections.abc import Callable

log = logging.getLogger("sensei.jobs")


class SerialWorker[T]:
    def __init__(self, name: str, handle: Callable[[T], None]):
        self.name = name
        self.handle = handle
        self._queue: queue.Queue[T] = queue.Queue()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def put(self, item: T) -> None:
        self._queue.put(item)
        with self._lock:
            if self._thread is None:
                self._thread = threading.Thread(target=self._loop, name=self.name, daemon=True)
                self._thread.start()

    def join(self) -> None:
        """Wait until every queued item has been handled (tests)."""
        self._queue.join()

    def _loop(self) -> None:
        while True:
            item = self._queue.get()
            try:
                self.handle(item)
            except Exception:  # never kill the worker thread
                log.exception("%s job %r failed", self.name, item)
            finally:
                self._queue.task_done()
