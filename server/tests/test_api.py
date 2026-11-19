from .conftest import FIXTURES


def upload(client, name="sample.ass", **form):
    data = {"anime_title": "Test Anime", "episode_number": "1", **form}
    with open(FIXTURES / name, "rb") as f:
        return client.post("/episodes", data=data, files={"subtitle": (name, f, "text/plain")})


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["dictionary"] is True
    assert r.json()["auth"] is False


def test_episode_flow(client):
    r = upload(client)
    assert r.status_code == 201, r.text
    ep = r.json()
    assert ep["anime_title"] == "Test Anime"
    assert ep["line_count"] == 2
    assert ep["understanding"]["token_pct"] == 0.0
    assert ep["understanding"]["unique_words"] > 0

    lines = client.get(f"/episodes/{ep['id']}/lines").json()
    assert [line["text"] for line in lines][0] == "俺は海賊王になる男だ！"
    toks = {t["surface"]: t for line in lines for t in line["tokens"]}
    tabe = toks["食べ"]
    assert tabe["lemma"] == "食べる"
    assert tabe["status"] == "new"
    assert tabe["common"] is True  # linked to JMdict fixture entry
    assert tabe["furigana"][0] == {"text": "食", "ruby": "た"}
    assert toks["は"]["word_id"] is None and toks["は"]["status"] is None

    # marking a word known raises understanding and is reflected in lines
    r = client.post(f"/words/{tabe['word_id']}/status", json={"status": "known"})
    assert r.status_code == 200 and r.json()["status"] == "known"
    u = client.get(f"/episodes/{ep['id']}/understanding").json()
    assert u["known_unique"] == 1 and u["token_pct"] > 0
    lines = client.get(f"/episodes/{ep['id']}/lines").json()
    assert {t["status"] for line in lines for t in line["tokens"] if t["surface"] == "食べ"} == {
        "known"
    }

    # same word in a second episode is shared vocabulary
    ep2 = upload(client, episode_number="2").json()
    assert ep2["understanding"]["known_unique"] == 1

    # subtitle offset is persisted
    r = client.patch(f"/episodes/{ep['id']}", json={"sub_offset_ms": -350})
    assert r.json()["sub_offset_ms"] == -350
    assert len(client.get("/episodes").json()) == 2

    assert client.delete(f"/episodes/{ep['id']}").status_code == 204
    assert client.get(f"/episodes/{ep['id']}").status_code == 404


def test_lookup_endpoint(client):
    r = client.get("/dictionary/lookup", params={"q": "海賊"})
    assert r.status_code == 200
    e = r.json()["entries"][0]
    assert e["senses"]["eng"][0]["glosses"] == ["pirate"]
    assert e["senses"]["ger"][0]["glosses"] == ["Pirat"]


def test_rejects_non_japanese_subtitles(client, tmp_path):
    p = tmp_path / "en.srt"
    p.write_text("1\n00:00:01,000 --> 00:00:02,000\nHello\n")
    with open(p, "rb") as f:
        r = client.post("/episodes", data={"anime_title": "x"}, files={"subtitle": ("en.srt", f)})
    assert r.status_code == 422


def test_auth(make_client):
    c = make_client(token="s3cret-s3cret-s3cret")
    assert c.get("/health").status_code == 200  # public
    assert c.get("/episodes").status_code == 401
    assert c.get("/episodes", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert (
        c.get("/episodes", headers={"Authorization": "Bearer s3cret-s3cret-s3cret"}).status_code
        == 200
    )
    assert c.get("/episodes", headers={"X-Sensei-Token": "s3cret-s3cret-s3cret"}).status_code == 200


def test_line_romaji_and_proper_nouns_in_lines(client):
    ep = upload(client).json()
    lines = client.get(f"/episodes/{ep['id']}/lines").json()
    assert lines[1]["romaji"].startswith("onaka suita")
    assert all("is_proper_noun" in t for line in lines for t in line["tokens"])


def test_words_list_and_bulk_status(client):
    ep = upload(client).json()
    page = client.get("/words", params={"episode_id": ep["id"]}).json()
    assert page["total"] == ep["understanding"]["unique_words"]
    assert all(w["status"] == "new" and w["occurrences"] >= 1 for w in page["items"])
    ids = [w["id"] for w in page["items"]]

    r = client.post("/words/bulk-status", json={"word_ids": [*ids[:2], 99999], "status": "known"})
    assert r.json() == {"updated": 2, "missing": [99999]}
    assert client.get("/words", params={"status": "known"}).json()["total"] == 2
    assert (
        client.get("/words", params={"status": "new", "anime_id": ep["anime_id"]}).json()["total"]
        == len(ids) - 2
    )
    assert client.get(f"/episodes/{ep['id']}/understanding").json()["known_unique"] == 2

    hit = client.get("/words", params={"q": "たべ"}).json()
    assert [w["lemma"] for w in hit["items"]] == ["食べる"] and hit["items"][0][
        "occurrences"
    ] is None
    newest_first = [w["id"] for w in client.get("/words", params={"limit": 500}).json()["items"]]
    assert newest_first == sorted(newest_first, reverse=True)
    second = client.get("/words", params={"limit": 1, "offset": 1}).json()
    assert [w["id"] for w in second["items"]] == newest_first[1:2]
    assert (
        client.post("/words/bulk-status", json={"word_ids": [], "status": "known"}).status_code
        == 422
    )


def test_reprocess_keeps_line_ids_and_statuses(client):
    import json

    from sqlmodel import Session, select

    from app.models import SubtitleLine

    ep = upload(client).json()
    before = client.get(f"/episodes/{ep['id']}/lines").json()
    wid = next(t["word_id"] for t in before[1]["tokens"] if t["surface"] == "食べ")
    client.post(f"/words/{wid}/status", json={"status": "known"})

    # simulate tokens stored by an older tokenizer
    engine = client.app.state.engine
    with Session(engine) as s:
        for line in s.exec(select(SubtitleLine)).all():
            line.tokens_json = json.dumps([{"surface": line.text, "pos": "名詞", "romaji": "x"}])
            s.add(line)
        s.commit()

    r = client.post(f"/episodes/{ep['id']}/reprocess")
    assert r.status_code == 200 and r.json()["understanding"]["known_unique"] == 1
    after = client.get(f"/episodes/{ep['id']}/lines").json()
    assert [line["id"] for line in after] == [line["id"] for line in before]
    assert after == before[:1] + [
        {
            **before[1],
            "tokens": [
                {**t, "status": "known" if t["word_id"] == wid else t["status"]}
                for t in before[1]["tokens"]
            ],
        }
    ]
    assert client.post("/episodes/9999/reprocess").status_code == 404


def test_refuses_to_start_without_token(tmp_path):
    import pytest

    from app.config import Settings
    from app.main import create_app

    with pytest.raises(RuntimeError, match="SENSEI_API_TOKEN is not set"):
        create_app(Settings(data_dir=tmp_path))
    with pytest.raises(RuntimeError, match="too short"):
        create_app(Settings(data_dir=tmp_path, api_token="short"))
    app = create_app(Settings(data_dir=tmp_path, allow_no_auth=True))  # explicit dev opt-out
    assert app.state.settings.allow_no_auth
