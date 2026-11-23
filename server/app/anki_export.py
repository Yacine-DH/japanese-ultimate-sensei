"""Anki export: a "Sensei Japanese" note per card, as an .apkg (genanki) or an AnkiConnect
payload. Both use the same fields, so notes look identical however they got into Anki.

Media file names are stable (`sensei-<media id>.<ext>`) and note GUIDs derive from the card
id, so re-importing a newer export updates notes instead of duplicating them.
"""

import hashlib
import json
import shutil
import tempfile
from html import escape
from pathlib import Path

import genanki
from sqlmodel import Session, select

from app import media as media_lib
from app.dictionary import Dictionary
from app.models import Anime, Card, Episode, Media, MediaKind, SubtitleLine, Word
from app.nlp.tokenizer import line_romaji

MODEL_ID = 1_781_130_277  # never change: Anki identifies the note type by it
MODEL_NAME = "Sensei Japanese"
# New fields go at the END (Anki merges a note type with appended fields; reordering would not).
FIELDS = [
    "Word", "Reading", "MeaningEN", "MeaningDE", "Sentence", "SentenceRomaji",
    "Screenshot", "Audio", "Clip", "Source", "SenseiId",
    "SentenceEN", "SentenceDE",  # the line's LLM translation (#130)
]  # fmt: skip
FRONT = """<div class="shot">{{Screenshot}}</div>
<div class="word">{{Word}}</div>
<div class="sentence">{{kanji:Sentence}}</div>"""
BACK = """<div class="shot">{{Screenshot}}</div>
<div class="word">{{Word}}</div>
<div class="reading">{{Reading}}</div>
<hr id="answer">
<div class="sentence">{{furigana:Sentence}}</div>
<div class="romaji">{{SentenceRomaji}}</div>
{{#SentenceEN}}<div class="translation">{{SentenceEN}}</div>{{/SentenceEN}}
{{#SentenceDE}}<div class="translation de">{{SentenceDE}}</div>{{/SentenceDE}}
<div class="meaning">{{MeaningEN}}</div>
<div class="meaning de">{{MeaningDE}}</div>
<div class="audio">{{Audio}}</div>
<div class="clip">{{Clip}}</div>
<div class="source">{{Source}}</div>"""
CSS = """.card { font-family: "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif;
  font-size: 20px; text-align: center; color: #1f2937; background: #fafafa; }
.nightMode.card, .night_mode .card { color: #e5e7eb; background: #111827; }
.shot img, .clip video { max-width: 100%; max-height: 40vh; border-radius: 8px; }
.word { font-size: 2.2em; margin: .3em 0; }
.reading { font-size: 1.2em; opacity: .8; }
.sentence { font-size: 1.3em; margin: .6em 0; } .sentence b { color: #ef4444; }
.romaji, .source { font-size: .8em; opacity: .6; }
.meaning { margin: .3em 0; } .meaning.de { opacity: .8; font-size: .9em; }
.translation { font-size: .95em; font-style: italic; margin: .2em 0; }
.translation.de { opacity: .8; font-size: .85em; }
.meaning:first-of-type { margin-top: .6em; }"""


def model() -> genanki.Model:
    return genanki.Model(
        MODEL_ID,
        MODEL_NAME,
        fields=[{"name": f} for f in FIELDS],
        templates=[{"name": "Recognition", "qfmt": FRONT, "afmt": BACK}],
        css=CSS,
    )


def create_model_params() -> dict:
    """AnkiConnect `createModel` params (run once if the note type doesn't exist yet)."""
    return {
        "modelName": MODEL_NAME,
        "inOrderFields": FIELDS,
        "css": CSS,
        "isCloze": False,
        "cardTemplates": [{"Name": "Recognition", "Front": FRONT, "Back": BACK}],
    }


def deck_id(name: str) -> int:
    return int(hashlib.sha1(f"sensei-deck:{name}".encode()).hexdigest()[:8], 16)


def meanings(entry: dict | None, lang: str, max_senses: int = 3) -> str:
    if not entry:
        return ""
    senses = [s for s in entry.get("senses", {}).get(lang, []) if s.get("glosses")][:max_senses]
    parts = ["; ".join(escape(g) for g in s["glosses"][:4]) for s in senses]
    if len(parts) == 1:
        return parts[0]
    return "<br>".join(f"{i}. {p}" for i, p in enumerate(parts, 1))


def furigana_sentence(tokens: list[dict], word_id: int) -> str:
    """Anki furigana syntax (`漢字[かんじ]`), the card's word in <b>. Anki's {{furigana:}}
    applies a reading to the text back to the previous space or '>', so kanji runs get a
    leading space (hidden when rendered)."""
    out = []
    for t in tokens:
        piece = ""
        for seg in t.get("furigana") or [{"text": t.get("surface", ""), "ruby": None}]:
            text = escape(seg["text"])
            piece += f" {text}[{seg['ruby']}]" if seg.get("ruby") else text
        if word_id and t.get("word_id") == word_id:
            piece = f"<b>{piece.lstrip()}</b>"
        out.append(piece)
    return "".join(out).strip()


def timestamp(ms: int) -> str:
    s = ms // 1000
    return (
        f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"
    )


def card_media(session: Session, card: Card) -> dict[MediaKind, Media]:
    """Newest finished media of each kind."""
    rows = session.exec(
        select(Media).where(Media.card_id == card.id).order_by(Media.id)  # type: ignore[arg-type]
    ).all()
    return {m.kind: m for m in rows if not m.path.startswith("raw/")}


def media_filename(m: Media) -> str:
    ext = "mp3" if m.kind == MediaKind.audio else Path(m.path).suffix.lstrip(".")
    return f"sensei-{m.id}.{ext}"


def media_source(m: Media, media_dir: Path) -> Path:
    """File to ship to Anki (audio as MP3: AnkiMobile can't play Opus)."""
    src = media_dir / m.path
    return media_lib.ensure_mp3(src) if m.kind == MediaKind.audio else src


def note_fields(
    session: Session, card: Card, dictionary: Dictionary | None, media: dict[MediaKind, Media]
) -> dict[str, str]:
    word = session.get(Word, card.word_id)
    line = session.get(SubtitleLine, card.line_id) if card.line_id else None
    ep = session.get(Episode, line.episode_id) if line else None
    anime = session.get(Anime, ep.anime_id) if ep and ep.anime_id else None
    entry = dictionary.entry(word.jmdict_id) if dictionary and word and word.jmdict_id else None
    tokens = json.loads(line.tokens_json) if line else []

    source = []
    if anime:
        source.append(escape(anime.title))
    if ep and ep.number is not None:
        source.append(f"Ep {ep.number:g}")
    if line:
        source.append(timestamp(line.start_ms))
    names = {k: media_filename(m) for k, m in media.items()}
    return {
        "Word": escape(word.lemma) if word else "",
        "Reading": escape(word.reading) if word else "",
        "MeaningEN": meanings(entry, "eng"),
        "MeaningDE": meanings(entry, "ger"),
        "Sentence": furigana_sentence(tokens, card.word_id) if tokens else escape(card.sentence),
        "SentenceRomaji": escape(line_romaji(tokens)) if tokens else "",
        "Screenshot": f'<img src="{names[MediaKind.screenshot]}">'
        if MediaKind.screenshot in names
        else "",
        "Audio": f"[sound:{names[MediaKind.audio]}]" if MediaKind.audio in names else "",
        "Clip": f'<video src="{names[MediaKind.clip]}" autoplay loop muted playsinline></video>'
        if MediaKind.clip in names
        else "",
        "Source": " · ".join(source),
        "SenseiId": str(card.id),
        "SentenceEN": escape(line.translation_en or "") if line else "",
        "SentenceDE": escape(line.translation_de or "") if line else "",
    }


def tags_for(session: Session, card: Card) -> list[str]:
    tags = ["sensei"]
    line = session.get(SubtitleLine, card.line_id) if card.line_id else None
    ep = session.get(Episode, line.episode_id) if line else None
    anime = session.get(Anime, ep.anime_id) if ep and ep.anime_id else None
    if anime:
        slug = "".join(c if c.isalnum() else "_" for c in anime.title).strip("_")
        tags.append(f"sensei::{slug}"[:100])
    return tags


def build_apkg(
    session: Session,
    cards: list[Card],
    deck_name: str,
    dictionary: Dictionary | None,
    media_dir: Path,
) -> bytes:
    deck = genanki.Deck(deck_id(deck_name), deck_name)
    m = model()
    with tempfile.TemporaryDirectory() as tmp:
        files: list[str] = []
        for card in cards:
            media = card_media(session, card)
            for item in media.values():
                try:
                    src = media_source(item, media_dir)
                except media_lib.MediaError:
                    continue
                if src.is_file():
                    dst = Path(tmp) / media_filename(item)
                    shutil.copyfile(src, dst)
                    files.append(str(dst))
            fields = note_fields(session, card, dictionary, media)
            deck.add_note(
                genanki.Note(
                    model=m,
                    fields=[fields[f] for f in FIELDS],
                    guid=genanki.guid_for("sensei-card", card.id),
                    tags=tags_for(session, card),
                )
            )
        out = Path(tmp) / "export.apkg"
        genanki.Package(deck, media_files=files).write_to_file(out)
        return out.read_bytes()
