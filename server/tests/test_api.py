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


def test_nani_is_one_word_across_contexts(client, tmp_path):
    p = tmp_path / "nani.srt"
    p.write_text(
        "1\n00:00:01,000 --> 00:00:02,000\n何を食べる？\n\n2\n00:00:03,000 --> 00:00:04,000\n何の話？\n",
        encoding="utf-8",
    )
    with open(p, "rb") as f:
        ep = client.post(
            "/episodes", data={"anime_title": "x"}, files={"subtitle": ("n.srt", f)}
        ).json()
    lines = client.get(f"/episodes/{ep['id']}/lines").json()
    nani = [next(t for t in line["tokens"] if t["surface"] == "何") for line in lines]
    assert [t["reading"] for t in nani] == ["なに", "なん"]
    assert nani[0]["word_id"] == nani[1]["word_id"]


def test_reprocess_merges_old_reading_keys(client):
    from sqlmodel import Session, select

    from app.models import Card, UserWord, Word

    with open(FIXTURES / "sample.srt", "rb") as f:
        ep = client.post(
            "/episodes", data={"anime_title": "x"}, files={"subtitle": ("s.srt", f)}
        ).json()
    engine = client.app.state.engine
    with Session(engine) as s:  # rows as an older version stored them
        old = Word(lemma="私", reading="わたくし")
        s.add(old)
        s.flush()
        s.add(UserWord(user_id=1, word_id=old.id, status="known"))
        s.add(Card(user_id=1, word_id=old.id, sentence="私だ"))
        s.commit()
        old_id = old.id
    assert client.post(f"/episodes/{ep['id']}/reprocess").status_code == 200
    with Session(engine) as s:
        words = s.exec(select(Word).where(Word.lemma == "私")).all()
        assert [(w.id, w.reading) for w in words] == [(old_id, "わたし")]  # re-keyed in place
        assert s.exec(select(UserWord).where(UserWord.word_id == old_id)).one().status == "known"
        assert s.exec(select(Card).where(Card.word_id == old_id)).one()


def test_merge_reading_fixes_when_both_rows_exist(client):
    from sqlmodel import Session, select

    from app.ingest import merge_reading_fixes
    from app.models import Card, UserWord, Word

    with Session(client.app.state.engine) as s:
        old, new = Word(lemma="明日", reading="あす"), Word(lemma="明日", reading="あした")
        s.add_all([old, new])
        s.flush()
        s.add_all([
            UserWord(user_id=1, word_id=old.id, status="known"),
            UserWord(user_id=1, word_id=new.id, status="learning"),
            Card(user_id=1, word_id=old.id, sentence="明日だ"),
        ])  # fmt: skip
        s.commit()
        new_id = new.id
        assert merge_reading_fixes(s) == 1
        s.commit()
        assert [w.reading for w in s.exec(select(Word).where(Word.lemma == "明日")).all()] == [
            "あした"
        ]
        assert s.exec(select(UserWord).where(UserWord.word_id == new_id)).one().status == "known"
        assert s.exec(select(Card).where(Card.word_id == new_id)).one()


def test_reprocess_cleans_old_line_text(client):
    """Lines stored before the #90 cleanup: markers stripped, sound-cue lines dropped unless
    a card uses them."""
    from sqlmodel import Session, select

    from app.models import Card, LineNote, SubtitleLine

    srt = "".join(
        f"{n}\n00:00:0{n},000 --> 00:00:0{n},900\n魔法を使う{n}\n\n" for n in range(1, 5)
    ).encode()
    ep = client.post(
        "/episodes", data={"anime_title": "x"}, files={"subtitle": ("s.srt", srt)}
    ).json()
    lines = client.get(f"/episodes/{ep['id']}/lines").json()
    word_id = next(t["word_id"] for t in lines[0]["tokens"] if t["word_id"])
    assert len(lines) == 4
    engine = client.app.state.engine
    with Session(engine) as s:
        rows = s.exec(select(SubtitleLine).order_by(SubtitleLine.idx)).all()
        rows[0].text, rows[1].text, rows[2].text = "（足音）", "（ノック）", rows[2].text + "➡"
        s.add(LineNote(line_id=rows[0].id, lang="en", text="footsteps", model="m"))
        s.add(Card(user_id=1, word_id=word_id, line_id=rows[1].id, sentence="（ノック）"))
        s.add_all(rows[:3])
        s.commit()
        ids = [r.id for r in rows[:3]]
    assert client.post(f"/episodes/{ep['id']}/reprocess").status_code == 200
    after = {line["id"]: line["text"] for line in client.get(f"/episodes/{ep['id']}/lines").json()}
    assert ids[0] not in after  # dropped, with its note
    assert after[ids[1]] == "（ノック）"  # kept: a card points at it
    assert not after[ids[2]].endswith("➡")
    assert len(after) == len(lines) - 1
    with Session(engine) as s:
        assert not s.exec(select(LineNote).where(LineNote.line_id == ids[0])).all()


def test_reimport_same_episode_replaces_in_place(client):
    """#128: same anime + number → same id, new lines, offset reset, cards relinked."""
    first = upload(client).json()
    ep_id = first["id"]
    client.patch(f"/episodes/{ep_id}", json={"sub_offset_ms": 1500})
    line = client.get(f"/episodes/{ep_id}/lines").json()[0]
    tok = next(t for t in line["tokens"] if t["word_id"])
    card = client.post("/cards", json={"word_id": tok["word_id"], "line_id": line["id"]}).json()

    r = upload(client)  # same file again: cards find their sentence again
    assert r.status_code == 200, r.text
    again = r.json()
    assert again["id"] == ep_id and again["replaced"] is True
    assert again["sub_offset_ms"] == 0 and again["line_count"] == 2
    assert len(client.get("/episodes").json()) == 1
    new_line_ids = {ln["id"] for ln in client.get(f"/episodes/{ep_id}/lines").json()}
    relinked = client.get(f"/cards/{card['id']}").json()["card"]
    assert relinked["line_id"] in new_line_ids

    r = upload(client, name="sample.srt")  # different file: card keeps its sentence, no line
    assert r.status_code == 200 and r.json()["line_count"] == 2
    assert r.json()["source_filename"] == "sample.srt"
    detached = client.get(f"/cards/{card['id']}").json()["card"]
    assert detached["line_id"] is None and detached["sentence"] == card["sentence"]


def test_other_episode_number_is_a_new_episode(client):
    a = upload(client).json()
    r = upload(client, episode_number="2")
    assert r.status_code == 201 and r.json()["id"] != a["id"] and r.json()["replaced"] is False


def test_reprocess_extracts_and_keeps_given_readings(client):
    """Old episodes stored 岩鷲(ガンジュ) in the text: reprocess turns it into furigana, and a
    second reprocess keeps it although the text no longer has the parentheses."""
    from sqlmodel import Session, select

    from app.models import SubtitleLine

    ep = upload(client).json()
    with Session(client.app.state.engine) as session:
        line = session.exec(select(SubtitleLine).where(SubtitleLine.episode_id == ep["id"])).first()
        line.text = "岩鷲(ガンジュ)が来た"
        session.add(line)
        session.commit()
    for _ in range(2):
        assert client.post(f"/episodes/{ep['id']}/reprocess").status_code == 200
        first = client.get(f"/episodes/{ep['id']}/lines").json()[0]
        assert first["text"] == "岩鷲が来た"
        assert first["tokens"][0]["furigana"] == [{"text": "岩鷲", "ruby": "ガンジュ"}]
