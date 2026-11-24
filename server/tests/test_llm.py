import json
import re

import httpx
import pytest

from app.llm import LLM, LLMError, explain_line, parse_translations
from app.translate_jobs import Translator

from .test_api import upload

calls: list[dict] = []


def fake_llm(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/v1/models":
        return httpx.Response(200, json={"data": [{"id": "qwen2.5:3b"}]})
    body = json.loads(request.content)
    calls.append(body)
    user = body["messages"][1]["content"]
    if "Translate:" in user:
        nums = [int(n) for n in re.findall(r"^(\d+)\. ", user.split("Translate:")[1], re.M)]
        content = (
            "```json\n"
            + json.dumps({"lines": [{"i": i, "en": f"EN {i}", "de": f"DE {i}"} for i in nums]})
            + "\n```"
        )  # models love code fences
    else:
        content = "**Translation:** I'm hungry…"
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


@pytest.fixture
def llm_client(client):
    llm = LLM("http://llm.local/v1", "qwen2.5:3b", transport=httpx.MockTransport(fake_llm))
    client.app.state.llm = llm
    client.app.state.translator = Translator(client.app.state.engine, llm, synchronous=True)
    calls.clear()
    return client


def test_parse_translations_is_tolerant():
    text = 'Sure! {"lines": [{"i": 0, "en": "Hi", "de": "Hallo"}, {"i": "1", "en": "Yo"}, {"i": 9, "en": "x"}]} hope it helps'
    assert parse_translations(text, [0, 1]) == {0: ("Hi", "Hallo"), 1: ("Yo", "")}
    assert parse_translations("no json here", [0]) == {}
    assert parse_translations('{"lines": "broken"}', [0]) == {}


def test_status(llm_client, client):
    s = llm_client.get("/llm/status").json()
    assert s == {"configured": True, "reachable": True, "model": "qwen2.5:3b",
                 "base_url": "http://llm.local/v1", "detail": "ok"}  # fmt: skip


def test_unconfigured_is_503(client):
    ep = upload(client).json()
    assert client.get("/llm/status").json()["configured"] is False
    assert client.post(f"/episodes/{ep['id']}/translate").status_code == 503
    line = client.get(f"/episodes/{ep['id']}/lines").json()[0]
    assert client.post(f"/lines/{line['id']}/explain").status_code == 503


def test_translate_episode(llm_client):
    ep = upload(llm_client).json()
    r = llm_client.post(f"/episodes/{ep['id']}/translate")
    assert r.status_code == 202
    job = llm_client.get(f"/episodes/{ep['id']}/translate").json()
    assert (
        job["translated_lines"] == job["total_lines"] == 2
        and not job["running"]
        and job["error"] is None
    )
    lines = llm_client.get(f"/episodes/{ep['id']}/lines").json()
    assert [(line["translation_en"], line["translation_de"]) for line in lines] == [
        ("EN 0", "DE 0"),
        ("EN 1", "DE 1"),
    ]
    assert (
        calls[0]["response_format"] == {"type": "json_object"} and calls[0]["model"] == "qwen2.5:3b"
    )
    n = len(calls)
    llm_client.post(f"/episodes/{ep['id']}/translate")  # nothing left to do
    assert len(calls) == n


def test_translation_error_is_reported(client):
    def down(request):
        raise httpx.ConnectError("connection refused")

    llm = LLM("http://llm.local/v1", "m", transport=httpx.MockTransport(down))
    client.app.state.llm = llm
    client.app.state.translator = Translator(client.app.state.engine, llm, synchronous=True)
    ep = upload(client).json()
    client.post(f"/episodes/{ep['id']}/translate")
    job = client.get(f"/episodes/{ep['id']}/translate").json()
    assert "unreachable" in job["error"] and job["translated_lines"] == 0
    assert client.get("/llm/status").json()["reachable"] is False


def test_explain_is_cached_and_deleted_with_episode(llm_client):
    ep = upload(llm_client).json()
    line = llm_client.get(f"/episodes/{ep['id']}/lines").json()[1]
    first = llm_client.post(f"/lines/{line['id']}/explain", params={"lang": "de"}).json()
    assert first["text"].startswith("**Translation:**") and not first["cached"]
    assert "German" in calls[-1]["messages"][0]["content"]
    assert "Words of the line with their readings: " in calls[-1]["messages"][1]["content"]
    n = len(calls)
    again = llm_client.post(f"/lines/{line['id']}/explain", params={"lang": "de"}).json()
    assert again["cached"] and len(calls) == n
    assert (
        llm_client.post(
            f"/lines/{line['id']}/explain", params={"lang": "de", "refresh": True}
        ).json()["cached"]
        is False
    )
    assert llm_client.post("/lines/99999/explain").status_code == 404
    assert llm_client.delete(f"/episodes/{ep['id']}").status_code == 204  # notes don't block it


def test_name_candidates_word_hints_and_language_check():
    from app.llm import looks_german, name_candidates, word_hints

    def tok(
        surface, reading, pos="名詞", detail=("固有名詞", "人名", "一般"), lemma=None, romaji=""
    ):
        return {"surface": surface, "reading": reading, "pos": pos, "pos_detail": list(detail),
                "lemma": lemma or surface, "romaji": romaji}  # fmt: skip

    lines = [[tok("ハイター", "はいたー")], [tok("ハイター", "はいたー"), tok("フフフ", "ふふふ")],
             [tok("悪魔", "あくま")], [tok("悪魔", "あくま")]]  # fmt: skip
    assert name_candidates(lines) == ["ハイター"]  # once-only and kanji "names" left out

    hints = word_hints([
        tok("決して", "けっして", "副詞", (), romaji="kesshite"),
        tok("かなう", "かなう", "動詞", (), romaji="kanau"),
        tok("なかった", "なかった", "助動詞", (), lemma="ない", romaji="nakatta"),
        tok("！", "！", "補助記号", ()),
    ])  # fmt: skip
    assert hints == (
        "決して (けっして, kesshite) · かなう (kanau) · なかった (nakatta) [dictionary form ない]"
    )
    assert looks_german("Sie hat sich die ganze Zeit eingeschlossen")
    assert looks_german("Hey, Fern, ich bin müde")
    assert not looks_german("Is Fern's training going well?")
    assert not looks_german("Die, demon!")  # one German-looking word isn't enough


def test_import_translates_automatically(llm_client):
    """#129: an import queues the translation by itself when an LLM is configured."""
    ep = upload(llm_client).json()
    job = llm_client.get(f"/episodes/{ep['id']}/translate").json()
    assert job["translated_lines"] == job["total_lines"] == 2 and job["retry_at"] is None


def test_auto_translate_can_be_turned_off(llm_client):
    llm_client.app.state.settings.llm_auto_translate = False
    ep = upload(llm_client).json()
    assert llm_client.get(f"/episodes/{ep['id']}/translate").json()["translated_lines"] == 0
    assert calls == []


def test_resume_queues_untranslated_episodes_oldest_first(llm_client):
    llm_client.app.state.settings.llm_auto_translate = False
    a = upload(llm_client).json()
    b = upload(llm_client, episode_number="2").json()
    tr = llm_client.app.state.translator
    assert tr.pending_episodes() == [a["id"], b["id"]]
    assert tr.resume() == [a["id"], b["id"]]
    assert tr.pending_episodes() == []
    llm_client.delete(f"/episodes/{a['id']}")
    assert tr.resume() == []


def test_resume_runs_at_startup(make_client):
    client = make_client()
    client.app.state.settings.llm_auto_translate = False
    upload(client)
    llm = LLM("http://llm.local/v1", "qwen2.5:3b", transport=httpx.MockTransport(fake_llm))
    client.app.state.llm = llm
    client.app.state.translator = Translator(client.app.state.engine, llm, synchronous=True)
    client.app.state.settings.llm_auto_translate = True
    with client:  # runs the lifespan (startup)
        lines = client.get("/episodes/1/lines").json()
    assert all(line["translation_en"] for line in lines)


def test_unreachable_llm_retries_with_backoff(llm_client):
    """The laptop is asleep: the job waits and retries instead of failing for good."""
    up = {"ok": False}

    def flaky(request: httpx.Request) -> httpx.Response:
        if not up["ok"]:
            raise httpx.ConnectError("no route to host")
        return fake_llm(request)

    timers: list[tuple[float, object]] = []
    llm = LLM("http://llm.local/v1", "qwen2.5:3b", transport=httpx.MockTransport(flaky))
    llm_client.app.state.llm = llm
    tr = Translator(
        llm_client.app.state.engine, llm, synchronous=True,
        schedule=lambda delay, fn: timers.append((delay, fn)),
    )  # fmt: skip
    llm_client.app.state.translator = tr
    ep = upload(llm_client).json()
    job = llm_client.get(f"/episodes/{ep['id']}/translate").json()
    assert job["queued"] and job["retry_at"] and "unreachable" in job["error"]
    assert job["translated_lines"] == 0 and [d for d, _ in timers] == [60]

    timers.pop()[1]()  # still asleep → longer wait
    assert [d for d, _ in timers] == [120]
    up["ok"] = True
    timers.pop()[1]()
    job = llm_client.get(f"/episodes/{ep['id']}/translate").json()
    assert job["translated_lines"] == 2 and not job["queued"] and job["error"] is None
    assert timers == []


def test_retry_timer_is_ignored_after_delete(llm_client):
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    timers: list = []
    llm = LLM("http://llm.local/v1", "m", transport=httpx.MockTransport(down))
    llm_client.app.state.llm = llm
    tr = Translator(llm_client.app.state.engine, llm, synchronous=True,
                    schedule=lambda d, fn: timers.append(fn))  # fmt: skip
    llm_client.app.state.translator = tr
    ep = upload(llm_client).json()
    llm_client.delete(f"/episodes/{ep['id']}")
    timers.pop()()
    assert timers == []  # cancelled: no new attempt, no new timer


def test_explain_gives_up_before_batch_translation_does():
    seen = []

    def slow(request: httpx.Request) -> httpx.Response:
        seen.append(request.extensions["timeout"])
        raise httpx.ReadTimeout("timed out")

    llm = LLM("http://llm.local/v1", "m", timeout=900, transport=httpx.MockTransport(slow))
    with pytest.raises(LLMError) as e:
        explain_line(llm, "台詞", [], [], "en", timeout=120)
    assert e.value.status == 504 and "too long" in str(e.value)
    with pytest.raises(LLMError, match="unreachable"):  # translation jobs retry on this word
        llm.chat("s", "u")
    assert [t["read"] for t in seen] == [120, 900] and [t["connect"] for t in seen] == [10, 10]
