"""#188: shared job worker, Explain before translation batches, gzip, non-blocking upload."""

import inspect
import threading
import time

import httpx

from app.llm import LLM
from app.translate_jobs import Translator
from app.workqueue import SerialWorker

from .test_api import upload
from .test_llm import calls, fake_llm
from .test_media import samples  # noqa: F401  (fixture)


def test_worker_handles_items_in_order_and_survives_errors():
    seen: list[int] = []

    def handle(n: int) -> None:
        if n == 2:
            raise RuntimeError("boom")
        seen.append(n)

    w = SerialWorker("test", handle)
    for n in (1, 2, 3):
        w.put(n)
    w.join()
    first = w._thread
    assert seen == [1, 3] and first is not None and first.is_alive()
    w.put(4)  # later jobs reuse the same thread: it never exits, nothing can get stranded
    w.join()
    assert seen == [1, 3, 4] and w._thread is first


def _translations(c) -> list[dict]:
    return [b for b in c if "Translate:" in b["messages"][1]["content"]]


def test_no_new_translation_batch_while_someone_waits_for_explain(client):
    ep = upload(client).json()  # no LLM configured on `client`: nothing translates yet
    llm = LLM("http://llm.local/v1", "qwen2.5:3b", transport=httpx.MockTransport(fake_llm))
    tr = Translator(client.app.state.engine, llm, batch=1)
    calls.clear()
    with tr.interactive():
        tr.enqueue(ep["id"])
        time.sleep(0.3)
        assert _translations(calls) == []  # held back while the explanation runs
        assert tr.jobs[ep["id"]].running
    tr._worker.join()
    job = tr.jobs[ep["id"]]
    assert not job.running and job.error is None
    assert len(_translations(calls)) == client.get(f"/episodes/{ep['id']}").json()["line_count"]


def test_explain_route_marks_itself_interactive(client):
    llm = LLM("http://llm.local/v1", "qwen2.5:3b", transport=httpx.MockTransport(fake_llm))
    client.app.state.llm = llm
    tr = client.app.state.translator = Translator(client.app.state.engine, llm, synchronous=True)
    ep = upload(client).json()
    line = client.get(f"/episodes/{ep['id']}/lines").json()[0]
    during: list[int] = []
    real = tr.interactive

    def spy():
        cm = real()

        class Wrap:
            def __enter__(self):
                cm.__enter__()
                during.append(tr._interactive)

            def __exit__(self, *exc):
                return cm.__exit__(*exc)

        return Wrap()

    tr.interactive = spy
    assert client.post(f"/lines/{line['id']}/explain").status_code == 200
    assert during == [1] and tr._interactive == 0


def test_interactive_wait_is_released_on_error():
    tr = Translator(engine=None, llm=None, synchronous=True)  # type: ignore[arg-type]
    try:
        with tr.interactive():
            raise ValueError
    except ValueError:
        pass
    done = threading.Event()
    t = threading.Thread(target=lambda: (tr._yield_to_interactive(), done.set()))
    t.start()
    assert done.wait(1)


def test_json_is_gzipped_but_media_is_not(client, samples):  # noqa: F811
    ep = upload(client).json()
    r = client.get(f"/episodes/{ep['id']}/lines", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip"
    assert r.json()  # httpx decodes it transparently
    with open(samples / "shot.png", "rb") as f:
        shot = client.post("/media", data={"kind": "screenshot"}, files={"file": ("s.png", f)})
    got = client.get(shot.json()["url"], headers={"Accept-Encoding": "gzip"})
    assert got.status_code == 200 and "content-encoding" not in got.headers


def test_subtitle_upload_does_not_run_on_the_event_loop(client):
    route = next(r for r in client.app.routes if getattr(r, "path", "") == "/episodes"
                 and "POST" in getattr(r, "methods", ()))  # fmt: skip
    assert not inspect.iscoroutinefunction(route.endpoint)
