"""JMdict lookup backed by a read-only SQLite file built from jmdict-simplified JSON.

Build it with:  uv run python -m app.dictionary_setup
JMdict © EDRDG, CC BY-SA 4.0 — https://www.edrdg.org/edrdg/licence.html
"""

import json
import sqlite3
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, common INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS forms (
  entry_id TEXT NOT NULL, text TEXT NOT NULL, is_kanji INTEGER NOT NULL, common INTEGER NOT NULL,
  ord INTEGER NOT NULL, UNIQUE(entry_id, text, is_kanji)
);
CREATE INDEX IF NOT EXISTS forms_text ON forms(text);
CREATE TABLE IF NOT EXISTS senses (
  entry_id TEXT NOT NULL, lang TEXT NOT NULL, idx INTEGER NOT NULL,
  pos TEXT NOT NULL, misc TEXT NOT NULL, glosses TEXT NOT NULL,
  UNIQUE(entry_id, lang, idx)
);
CREATE INDEX IF NOT EXISTS senses_entry ON senses(entry_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def build(json_paths: Iterable[Path], out_path: Path) -> int:
    """(Re)build the dictionary DB from one or more jmdict-simplified JSON files.

    Each file holds the same entries (same ids) with glosses in one or more languages,
    so forms are de-duplicated and senses are stored per language.
    Returns the number of entries.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".building")
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)
    versions = []
    for path in json_paths:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        versions.append(f"{Path(path).name}:{data.get('dictDate', '?')}")
        _insert_words(con, data["words"])
        del data
    con.execute("INSERT OR REPLACE INTO meta VALUES ('sources', ?)", (json.dumps(versions),))
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
    con.execute("VACUUM")
    con.close()
    tmp.replace(out_path)
    return n


def _insert_words(con: sqlite3.Connection, words: list[dict]) -> None:
    for w in words:
        eid = w["id"]
        common = any(k.get("common") for k in w.get("kanji", []) + w.get("kana", []))
        con.execute(
            "INSERT INTO entries VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET common=excluded.common",
            (eid, int(common)),
        )
        for is_kanji, key in ((1, "kanji"), (0, "kana")):
            for i, form in enumerate(w.get(key, [])):
                con.execute(
                    "INSERT OR IGNORE INTO forms VALUES (?, ?, ?, ?, ?)",
                    (eid, form["text"], is_kanji, int(bool(form.get("common"))), i),
                )
        per_lang: dict[str, int] = {}
        for sense in w.get("sense", []):
            by_lang: dict[str, list[str]] = {}
            for g in sense.get("gloss", []):
                by_lang.setdefault(g["lang"], []).append(g["text"])
            for lang, glosses in by_lang.items():
                idx = per_lang.get(lang, 0)
                per_lang[lang] = idx + 1
                con.execute(
                    "INSERT OR REPLACE INTO senses VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        eid,
                        lang,
                        idx,
                        json.dumps(sense.get("partOfSpeech", [])),
                        json.dumps(sense.get("misc", [])),
                        json.dumps(glosses, ensure_ascii=False),
                    ),
                )


def _is_kanji(c: str) -> bool:
    return "\u4e00" <= c <= "\u9fff" or "\u3400" <= c <= "\u4dbf" or c in "々〆"


# Sudachi top-level POS → LIKE pattern on a JMdict sense's pos JSON list.
JMDICT_POS = {
    "動詞": '%"v%',
    "形容詞": '%"adj-i%',
    "形状詞": '%"adj-na"%',
    "副詞": '%"adv%',
    "連体詞": '%"adj-pn"%',
    "名詞": '%"n"%',
    "代名詞": '%"pn"%',
    "感動詞": '%"int"%',
    "接続詞": '%"conj"%',
}


class Dictionary:
    """Thread-safe-enough read-only lookups (one connection per call)."""

    LANGS = ("eng", "ger")

    def __init__(self, path: Path):
        if not path.exists():
            raise FileNotFoundError(path)
        self.path = path

    @contextmanager
    def _con(self) -> Iterator[sqlite3.Connection]:
        con = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            yield con
        finally:
            con.close()

    def find_ids(
        self, text: str, reading: str | None = None, limit: int = 5, pos: str | None = None
    ) -> list[str]:
        """Entry ids whose kanji or kana form equals `text`, best match first.

        Ranking: entries that also have `reading` as a kana form; common entries; entries
        whose part of speech matches `pos` (a Sudachi top-level tag: 副詞 そう → 然う "in that
        way", not the auxiliary "seeming"; 動詞 ある → 有る, not 或る); for kana-only queries, entries normally written in kana (first sense tagged `uk`, or no
        kanji form: こと → 事, not 琴); then entries where `text` is a primary form (low `ord`).
        Kana homophones stay ambiguous (いる: 居る/要る); pass the word's link where known.
        """
        kana_query = not any(_is_kanji(c) for c in text)
        with self._con() as con:
            rows = con.execute(
                """
                SELECT f.entry_id AS id, e.common AS common, MIN(f.ord) AS ord,
                  EXISTS(SELECT 1 FROM forms r WHERE r.entry_id = f.entry_id
                         AND r.is_kanji = 0 AND r.text = ?) AS reading_match,
                  (? AND (
                    NOT EXISTS(SELECT 1 FROM forms k WHERE k.entry_id = f.entry_id AND k.is_kanji = 1)
                    OR EXISTS(SELECT 1 FROM senses s WHERE s.entry_id = f.entry_id
                              AND s.lang = 'eng' AND s.idx = 0 AND s.misc LIKE '%"uk"%')
                  )) AS kana_word,
                  EXISTS(SELECT 1 FROM senses p WHERE p.entry_id = f.entry_id
                         AND p.lang = 'eng' AND p.pos LIKE ?) AS pos_match
                FROM forms f JOIN entries e ON e.id = f.entry_id
                WHERE f.text = ?
                GROUP BY f.entry_id
                ORDER BY reading_match DESC, common DESC, pos_match DESC, kana_word DESC,
                         ord ASC, CAST(f.entry_id AS INTEGER)
                LIMIT ?
                """,
                (reading or "", int(kana_query), JMDICT_POS.get(pos or "", ""), text, limit),
            ).fetchall()
        return [r["id"] for r in rows]

    def entry(self, entry_id: str) -> dict | None:
        with self._con() as con:
            e = con.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
            if not e:
                return None
            forms = con.execute(
                "SELECT text, is_kanji, common FROM forms WHERE entry_id = ? ORDER BY is_kanji DESC, ord",
                (entry_id,),
            ).fetchall()
            senses = con.execute(
                "SELECT lang, pos, misc, glosses FROM senses WHERE entry_id = ? ORDER BY lang, idx",
                (entry_id,),
            ).fetchall()
        out: dict = {
            "id": entry_id,
            "common": bool(e["common"]),
            "kanji": [f["text"] for f in forms if f["is_kanji"]],
            "kana": [f["text"] for f in forms if not f["is_kanji"]],
            "senses": {lang: [] for lang in self.LANGS},
        }
        for s in senses:
            out["senses"].setdefault(s["lang"], []).append(
                {
                    "pos": json.loads(s["pos"]),
                    "misc": json.loads(s["misc"]),
                    "glosses": json.loads(s["glosses"]),
                }
            )
        return out

    def lookup(
        self, text: str, reading: str | None = None, limit: int = 5, first: str | None = None
    ) -> list[dict]:
        """Entries for `text`; `first` (a known entry id, e.g. the word's link) goes first."""
        ids = self.find_ids(text, reading, limit + 1)
        if first:
            ids = [first, *[i for i in ids if i != first]]
        # resolve before trimming: a stale `first` (entry gone after a JMdict update) is skipped
        return [e for eid in ids if (e := self.entry(eid))][:limit]

    def best(
        self, text: str, reading: str | None = None, pos: str | None = None
    ) -> tuple[str, bool] | None:
        """(entry_id, common) of the best entry, or None."""
        ids = self.find_ids(text, reading, limit=1, pos=pos)
        if not ids:
            return None
        with self._con() as con:
            common = con.execute("SELECT common FROM entries WHERE id = ?", (ids[0],)).fetchone()[0]
        return ids[0], bool(common)


def load_dictionary(path: Path) -> Dictionary | None:
    try:
        return Dictionary(path)
    except FileNotFoundError:
        return None
