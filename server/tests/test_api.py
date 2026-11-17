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
    c = make_client(token="s3cret")
    assert c.get("/health").status_code == 200  # public
    assert c.get("/episodes").status_code == 401
    assert c.get("/episodes", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert c.get("/episodes", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    assert c.get("/episodes", headers={"X-Sensei-Token": "s3cret"}).status_code == 200
