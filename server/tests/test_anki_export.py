import io
import json
import sqlite3
import zipfile

import pytest

from app.anki_export import FIELDS, furigana_sentence
from app.media import ffmpeg_available

from .test_cards import tabe_token
from .test_media import samples  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not ffmpeg_available(), reason="ffmpeg not installed")


def make_card(client, samples):  # noqa: F811
    _, line, tok = tabe_token(client)
    ids = []
    for kind, name in (("screenshot", "shot.png"), ("audio", "line.webm")):
        with open(samples / name, "rb") as f:
            ids.append(
                client.post("/media", data={"kind": kind}, files={"file": (name, f)}).json()["id"]
            )
    card = client.post(
        "/cards", json={"word_id": tok["word_id"], "line_id": line["id"], "media_ids": ids}
    ).json()
    return card, ids


def read_apkg(data: bytes, tmp_path):
    zf = zipfile.ZipFile(io.BytesIO(data))
    path = tmp_path / "collection.anki2"
    path.write_bytes(zf.read("collection.anki2"))
    con = sqlite3.connect(path)
    rows = con.execute("SELECT guid, flds, tags FROM notes").fetchall()
    con.close()
    notes = [(guid, flds.split("\x1f"), tags) for guid, flds, tags in rows]
    media = json.loads(zf.read("media"))
    return notes, {name: zf.read(idx) for idx, name in media.items()}


def test_furigana_sentence():
    toks = [
        {"surface": "魔王", "furigana": [{"text": "魔王", "ruby": "まおう"}], "word_id": 1},
        {"surface": "を", "furigana": [{"text": "を", "ruby": None}]},
        {
            "surface": "倒し",
            "furigana": [{"text": "倒", "ruby": "たお"}, {"text": "し", "ruby": None}],
            "word_id": 2,
        },
    ]
    assert furigana_sentence(toks, 2) == "魔王[まおう]を<b>倒[たお]し</b>"


def test_export_apkg(client, samples, tmp_path):  # noqa: F811
    assert client.get("/export/anki.apkg").status_code == 404  # nothing yet
    card, (shot_id, audio_id) = make_card(client, samples)
    r = client.get("/export/anki.apkg", params={"deck": "Sensei::Frieren"})
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    notes, files = read_apkg(r.content, tmp_path)
    assert len(notes) == 1
    guid, values, tags = notes[0]
    f = dict(zip(FIELDS, values, strict=True))
    assert f["Word"] == "食べる" and f["Reading"] == "たべる"
    assert "<b>食[た]べ</b>" in f["Sentence"] and f["SentenceRomaji"]
    assert f["MeaningEN"] and f["MeaningDE"]
    assert f["Screenshot"] == f'<img src="sensei-{shot_id}.webp">'
    assert f["Audio"] == f"[sound:sensei-{audio_id}.mp3]"
    assert f["Source"].startswith("Test Anime · Ep 1 · 0:0") and f["SenseiId"] == str(card["id"])
    assert "sensei" in tags.split()
    assert set(files) == {f"sensei-{shot_id}.webp", f"sensei-{audio_id}.mp3"}
    assert files[f"sensei-{audio_id}.mp3"][:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3")
    # stable GUID → re-import updates instead of duplicating
    assert read_apkg(client.get("/export/anki.apkg").content, tmp_path)[0][0][0] == guid
    assert (
        client.get("/export/anki.apkg", params={"since": "2999-01-01T00:00:00Z"}).status_code == 404
    )


def test_ankiconnect_payload(client, samples):  # noqa: F811
    card, (shot_id, audio_id) = make_card(client, samples)
    p = client.get(f"/cards/{card['id']}/anki-note", params={"deck": "Japanese::Sensei"}).json()
    note = p["note"]
    assert note["deckName"] == "Japanese::Sensei" and note["modelName"] == "Sensei Japanese"
    assert set(note["fields"]) == set(FIELDS)
    assert note["options"] == {"allowDuplicate": False, "duplicateScope": "deck"}
    urls = {m["filename"]: m["url"] for m in p["media"]}
    assert set(urls) == {f"sensei-{shot_id}.webp", f"sensei-{audio_id}.mp3"}
    assert all(u.startswith("http://testserver/media/") for u in urls.values())
    mp3 = client.get(urls[f"sensei-{audio_id}.mp3"].removeprefix("http://testserver"))
    assert mp3.status_code == 200 and mp3.headers["content-type"] == "audio/mpeg"

    model = client.get("/anki/model").json()
    assert model["modelName"] == "Sensei Japanese" and model["inOrderFields"] == FIELDS
    assert "{{furigana:Sentence}}" in model["cardTemplates"][0]["Back"]
    assert client.get("/cards/999/anki-note").status_code == 404
