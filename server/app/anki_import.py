"""Import known words: Anki decks (.apkg or AnkiConnect card data) and plain word lists.

Words are keyed exactly like at subtitle ingest (Sudachi lemma + lemma reading), so an imported
word is recognised in every future episode. Statuses only go up (new < learning < known);
`ignored` words are left alone.
"""

import html
import io
import json
import re
import sqlite3
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from sqlmodel import Session, select

from app.dictionary import Dictionary
from app.ingest import WordResolver
from app.models import UserWord, WordStatus
from app.nlp.tokenizer import tokenize
from app.srs import utcnow

MATURE_DAYS = 21  # Anki's own definition of a mature card
RANK = {WordStatus.new: 0, WordStatus.learning: 1, WordStatus.known: 2}
# Light words that ride along in vocab entries: 勉強する → 勉強, 静かだ → 静か
_LIGHT = {"する", "為る", "だ", "です", "ある", "有る", "いる", "居る", "なる", "成る", "な", "の"}
_FIELD_HINT = re.compile(
    r"expression|vocab|word|kanji|term|japanese|front|単語|語彙|表現|日本語", re.I
)
MAX_UNMATCHED_LISTED = 200


class AnkiFormatError(Exception):
    pass


def clean_expression(raw: str) -> str:
    """Anki field → bare Japanese word: drop HTML, sound tags, furigana brackets, alternatives."""
    s = re.sub(r"\[sound:[^\]]*\]", "", raw)
    s = re.sub(r"<br\s*/?>|<div>|</div>", "\n", s, flags=re.I)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    s = re.sub(r"\[[^\]]*\]", "", s)  # 食[た]べる → 食べる (Anki furigana syntax)
    s = re.split(r"[、,;；/／\n|（(]", s.strip())[0]  # first of "A、B" / "A (note)"
    s = re.sub(r"[\s　]+", "", s)
    return s.strip("～〜~・…。！？!?「」『』")


@dataclass
class ImportReport:
    total: int = 0
    matched: int = 0
    updated: int = 0
    already: int = 0
    unmatched: list[str] = field(default_factory=list)
    unmatched_count: int = 0
    skipped_new: int = 0
    dry_run: bool = False
    note_types: list[dict] = field(default_factory=list)
    decks: list[str] = field(default_factory=list)


def apply_words(
    session: Session,
    user_id: int,
    items: list[tuple[str, WordStatus]],
    dictionary: Dictionary | None,
    dry_run: bool = False,
    report: ImportReport | None = None,
) -> ImportReport:
    """Mark (expression, status) pairs. Duplicates keep the highest status."""
    report = report or ImportReport()
    report.dry_run = dry_run
    wanted: dict[str, WordStatus] = {}
    for raw, status in items:
        expr = clean_expression(raw)
        if expr and RANK[status] >= RANK[wanted.get(expr, WordStatus.new)]:
            wanted[expr] = status
    report.total = len(wanted)
    resolver = WordResolver(session, dictionary)
    existing: dict[int, UserWord] = {}
    for expr, status in wanted.items():
        tok = _single_word(expr)
        if tok is None:
            report.unmatched_count += 1
            if len(report.unmatched) < MAX_UNMATCHED_LISTED:
                report.unmatched.append(expr)
            continue
        report.matched += 1
        word = resolver.resolve(tok)
        uw = (
            existing.get(word.id)
            or session.exec(
                select(UserWord).where(UserWord.user_id == user_id, UserWord.word_id == word.id)
            ).first()
        )
        current = uw.status if uw else WordStatus.new
        if current == WordStatus.ignored or RANK[status] <= RANK.get(current, 0):
            report.already += 1
            continue
        report.updated += 1
        uw = uw or UserWord(user_id=user_id, word_id=word.id)
        uw.status, uw.updated_at = status, utcnow()
        existing[word.id] = uw
        session.add(uw)
    if dry_run:
        session.rollback()
    else:
        session.commit()
    return report


def _single_word(expr: str):
    """The one vocabulary token an expression stands for, or None (phrases, particles…)."""
    tokens = [t for t in tokenize(expr) if t.pos not in ("補助記号", "空白")]
    words = [t for t in tokens if t.is_content or t.is_proper_noun]
    if len(words) > 1:
        words = [t for t in words if t.lemma not in _LIGHT] or words[:1]
    if len(words) != 1:
        return None
    return words[0]


# ---- .apkg reading -----------------------------------------------------------------------


@dataclass
class Apkg:
    notetypes: dict[int, dict]  # id → {"name", "fields": [names]}
    decks: dict[int, str]
    notes: list[tuple[int, int, list[str]]]  # (note id, notetype id, field values)
    cards: list[tuple[int, int, int, int]]  # (note id, deck id, interval days, type 0=new)


def read_apkg(data: bytes) -> Apkg:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise AnkiFormatError("not an .apkg file (zip expected)") from e
    names = set(zf.namelist())
    if "collection.anki21b" in names:  # Anki ≥ 2.1.50 default: zstd-compressed, schema 18
        import zstandard

        raw = zstandard.ZstdDecompressor().stream_reader(zf.read("collection.anki21b")).read()
    elif "collection.anki21" in names:
        raw = zf.read("collection.anki21")
    elif "collection.anki2" in names:
        raw = zf.read("collection.anki2")
    else:
        raise AnkiFormatError("no Anki collection inside the .apkg")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "collection.sqlite"
        path.write_bytes(raw)
        con = sqlite3.connect(path)
        try:
            return _read_collection(con)
        except sqlite3.DatabaseError as e:
            raise AnkiFormatError(f"unreadable Anki collection: {e}") from e
        finally:
            con.close()


def _read_collection(con: sqlite3.Connection) -> Apkg:
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "notetypes" in tables:  # schema 18
        notetypes = {
            ntid: {"name": name, "fields": []}
            for ntid, name in con.execute("SELECT id, name FROM notetypes")
        }
        for ntid, _ord, name in con.execute(
            "SELECT ntid, ord, name FROM fields ORDER BY ntid, ord"
        ):
            notetypes.setdefault(ntid, {"name": str(ntid), "fields": []})["fields"].append(name)
        decks = dict(con.execute("SELECT id, name FROM decks"))
    else:  # schema 11: JSON blobs in col
        models_json, decks_json = con.execute("SELECT models, decks FROM col").fetchone()
        notetypes = {
            int(mid): {
                "name": m.get("name", mid),
                "fields": [f["name"] for f in sorted(m.get("flds", []), key=lambda f: f["ord"])],
            }
            for mid, m in json.loads(models_json or "{}").items()
        }
        decks = {int(did): d.get("name", did) for did, d in json.loads(decks_json or "{}").items()}
    notes = [
        (nid, mid, (flds or "").split("\x1f"))
        for nid, mid, flds in con.execute("SELECT id, mid, flds FROM notes")
    ]
    cards = [tuple(r) for r in con.execute("SELECT nid, did, ivl, type FROM cards")]
    return Apkg(
        notetypes=notetypes,
        decks={int(k): str(v) for k, v in decks.items()},
        notes=notes,
        cards=cards,
    )  # type: ignore[arg-type]


def pick_field(fields: list[str], wanted: str | None) -> int:
    if wanted:
        for i, f in enumerate(fields):
            if f.lower() == wanted.lower():
                return i
    for i, f in enumerate(fields):
        if _FIELD_HINT.search(f):
            return i
    return 0


def apkg_items(
    apkg: Apkg, field_name: str | None, deck: str | None, mature_days: int, report: ImportReport
) -> list[tuple[str, WordStatus]]:
    """(expression, status) per studied note. Note interval = max over its cards in the decks."""
    deck_ids = None
    if deck:
        d = deck.lower()
        deck_ids = {
            did
            for did, name in apkg.decks.items()
            if name.lower() == d or name.lower().startswith(d + "::")
        }
    ivl: dict[int, int] = {}
    studied: set[int] = set()
    seen: set[int] = set()
    for nid, did, interval, ctype in apkg.cards:
        if deck_ids is not None and did not in deck_ids:
            continue
        seen.add(nid)
        if ctype != 0:
            studied.add(nid)
            ivl[nid] = max(ivl.get(nid, 0), interval)
    used: dict[int, int] = {}
    items: list[tuple[str, WordStatus]] = []
    for nid, mid, values in apkg.notes:
        if nid not in seen:
            continue
        fields = apkg.notetypes.get(mid, {"fields": []})["fields"]
        idx = pick_field(fields, field_name)
        used[mid] = used.get(mid, 0) + 1
        if nid not in studied:
            report.skipped_new += 1
            continue
        status = WordStatus.known if ivl.get(nid, 0) >= mature_days else WordStatus.learning
        if idx < len(values):
            items.append((values[idx], status))
    report.note_types = [
        {
            "name": apkg.notetypes.get(mid, {}).get("name", str(mid)),
            "fields": apkg.notetypes.get(mid, {}).get("fields", []),
            "field_used": (apkg.notetypes.get(mid, {}).get("fields") or [""])[
                pick_field(apkg.notetypes.get(mid, {}).get("fields", []), field_name)
            ]
            if apkg.notetypes.get(mid, {}).get("fields")
            else "",
            "notes": n,
        }
        for mid, n in sorted(used.items(), key=lambda kv: -kv[1])
    ]
    report.decks = sorted(apkg.decks.values())
    return items
