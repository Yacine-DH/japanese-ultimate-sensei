import io
import sqlite3
import zipfile

import genanki
import zstandard

from app.anki_import import clean_expression

from .test_api import upload

MODEL = genanki.Model(
    1607392319,
    "Japanese vocab",
    fields=[{"name": "Meaning"}, {"name": "Vocab"}, {"name": "Reading"}],
    templates=[{"name": "c1", "qfmt": "{{Vocab}}", "afmt": "{{Meaning}}"}],
)
# (word field, interval days, card type: 0 new, 1 learning, 2 review)
NOTES = [
    ("食[た]べる", 40, 2),  # mature → known (Anki furigana syntax)
    ("<b>海賊</b>", 5, 2),  # young → learning (HTML)
    ("勉強する", 30, 2),  # suru-verb → 勉強
    ("男", 0, 0),  # never studied → skipped
    ("ありがとうございます、どうも", 100, 2),  # phrase → unmatched
]


def classic_apkg(tmp_path) -> bytes:
    """Schema-11 deck as older Anki / genanki write it, with real intervals."""
    deck = genanki.Deck(2059400110, "Japanese::Core")
    for word, _, _ in NOTES:
        deck.add_note(genanki.Note(model=MODEL, fields=["meaning", word, ""]))
    path = tmp_path / "deck.apkg"
    genanki.Package(deck).write_to_file(path)
    zf = zipfile.ZipFile(path)
    coll = tmp_path / "c.anki2"
    coll.write_bytes(zf.read("collection.anki2"))
    con = sqlite3.connect(coll)
    nids = [r[0] for r in con.execute("SELECT id FROM notes ORDER BY id")]
    for nid, (_, ivl, ctype) in zip(nids, NOTES, strict=True):
        con.execute("UPDATE cards SET ivl=?, type=? WHERE nid=?", (ivl, ctype, nid))
    con.commit()
    con.close()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        out.writestr("collection.anki2", coll.read_bytes())
        out.writestr("media", "{}")
    return buf.getvalue()


def modern_apkg(tmp_path) -> bytes:
    """Schema-18 collection, zstd-compressed as collection.anki21b (Anki ≥ 2.1.50)."""
    coll = tmp_path / "c18.anki2"
    con = sqlite3.connect(coll)
    con.executescript("""
        CREATE TABLE notetypes (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE fields (ntid INTEGER, ord INTEGER, name TEXT);
        CREATE TABLE decks (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE notes (id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT);
        CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ivl INTEGER, type INTEGER);
        INSERT INTO notetypes VALUES (7, 'Core 2k');
        INSERT INTO fields VALUES (7, 0, 'Sentence'), (7, 1, 'Front'), (7, 2, 'Back');
        INSERT INTO decks VALUES (1, 'Default'), (2, 'Mining'), (3, 'Mining' || char(31) || 'Frieren');
        INSERT INTO notes VALUES (10, 7, '文' || char(31) || '食べる' || char(31) || 'eat'),
                                 (11, 7, '文' || char(31) || '海賊' || char(31) || 'pirate');
        INSERT INTO cards VALUES (100, 10, 2, 50, 2), (101, 11, 1, 50, 2);
        INSERT INTO notes VALUES (12, 7, '文' || char(31) || '男' || char(31) || 'man');
        INSERT INTO cards VALUES (102, 12, 3, 50, 2);
    """)
    con.commit()
    con.close()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        out.writestr("collection.anki21b", zstandard.ZstdCompressor().compress(coll.read_bytes()))
        out.writestr("collection.anki2", b"")  # dummy, like real exports
    return buf.getvalue()


def post_apkg(client, data, **form):
    return client.post("/import/anki", data=form, files={"file": ("deck.apkg", data)})


def test_clean_expression():
    assert clean_expression(" 食[た]べる") == "食べる"
    assert clean_expression("<div>海賊</div><br>pirate") == "海賊"
    assert clean_expression("見る、観る") == "見る"
    assert clean_expression("～ながら") == "ながら"
    assert clean_expression("勉強 (べんきょう)[sound:x.mp3]") == "勉強"


def test_import_classic_apkg(client, tmp_path):
    data = classic_apkg(tmp_path)
    preview = post_apkg(client, data, dry_run="true").json()
    assert preview["dry_run"] and preview["note_types"][0]["field_used"] == "Vocab"
    assert client.get("/words").json()["total"] == 0  # dry run saved nothing

    r = post_apkg(client, data).json()
    assert (r["total"], r["matched"], r["updated"], r["skipped_new"]) == (4, 3, 3, 1)
    assert r["unmatched"] == ["ありがとうございます"] and r["decks"] == [
        "Default",
        "Japanese::Core",
    ]
    status = {w["lemma"]: w["status"] for w in client.get("/words").json()["items"]}
    assert status == {"食べる": "known", "海賊": "learning", "勉強": "known"}

    # an episode uploaded afterwards already counts the imported words
    ep = upload(client).json()
    assert ep["understanding"]["known_unique"] >= 1
    # re-import is idempotent; never downgrades
    again = post_apkg(client, data).json()
    assert again["updated"] == 0 and again["already"] == 3


def test_import_modern_apkg_with_field_and_deck(client, tmp_path):
    data = modern_apkg(tmp_path)
    r = post_apkg(client, data, deck="mining").json()
    assert r["note_types"][0]["field_used"] == "Front"
    assert r["matched"] == 2  # 食べる in Mining + 男 in the Mining::Frieren subdeck
    assert r["decks"] == ["Default", "Mining", "Mining::Frieren"]
    wrong = post_apkg(client, data, field="Back", dry_run="true").json()
    assert wrong["unmatched_count"] == 3  # English field → nothing matches
    assert post_apkg(client, b"not a zip").status_code == 422
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("collection.anki21b", b"not zstd")
    assert post_apkg(client, buf.getvalue()).status_code == 422


def test_import_word_list_and_ankiconnect_cards(client):
    r = client.post("/import/words", json={"text": "食べる\n\n海賊\n 食べる \nxyz"}).json()
    assert (r["total"], r["matched"], r["updated"], r["unmatched"]) == (3, 2, 2, ["xyz"])
    r = client.post(
        "/import/anki/cards",
        json={"cards": [
            {"expression": "男", "interval_days": 3},
            {"expression": "海賊", "interval_days": 1},  # already known → no downgrade
            {"expression": "女", "interval_days": 0, "studied": False},
        ]},
    ).json()  # fmt: skip
    assert (r["updated"], r["already"], r["skipped_new"]) == (1, 1, 1)
    status = {w["lemma"]: w["status"] for w in client.get("/words").json()["items"]}
    assert status["男"] == "learning" and status["海賊"] == "known"
