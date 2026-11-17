"""Episode ingestion: subtitle lines → tokens → vocabulary rows. Plus read-time helpers."""

import json
from collections.abc import Iterable

from sqlmodel import Session, select

from app.dictionary import Dictionary
from app.models import Episode, SubtitleLine, UserWord, Word, WordStatus
from app.nlp.tokenizer import Token, tokenize
from app.subtitles import ParsedLine

UNDERSTOOD = {WordStatus.known, WordStatus.ignored}


class WordResolver:
    """Finds or creates `Word` rows for tokens, linking them to JMdict when possible."""

    def __init__(self, session: Session, dictionary: Dictionary | None):
        self.session = session
        self.dictionary = dictionary
        self._cache: dict[tuple[str, str], Word] = {}

    def resolve(self, tok: Token) -> Word:
        key = (tok.lemma, tok.lemma_reading)
        if key in self._cache:
            return self._cache[key]
        word = self.session.exec(
            select(Word).where(Word.lemma == tok.lemma, Word.reading == tok.lemma_reading)
        ).first()
        if word is None:
            word = Word(lemma=tok.lemma, reading=tok.lemma_reading, pos=tok.pos)
            hit = self._jmdict(tok)
            if hit:
                word.jmdict_id, word.common = hit
            self.session.add(word)
            self.session.flush()
        self._cache[key] = word
        return word

    def _jmdict(self, tok: Token) -> tuple[str, bool] | None:
        if not self.dictionary:
            return None
        for text in dict.fromkeys([tok.lemma, tok.normalized, tok.lemma_reading]):
            if text and (hit := self.dictionary.best(text, tok.lemma_reading)):
                return hit
        return None


def ingest_lines(
    session: Session, episode: Episode, lines: Iterable[ParsedLine], dictionary: Dictionary | None
) -> int:
    resolver = WordResolver(session, dictionary)
    n = 0
    for idx, line in enumerate(lines):
        tokens = tokenize(line.text)
        for tok in tokens:
            if tok.is_content:
                tok.word_id = resolver.resolve(tok).id
        session.add(
            SubtitleLine(
                episode_id=episode.id,
                idx=idx,
                start_ms=line.start_ms,
                end_ms=line.end_ms,
                text=line.text,
                tokens_json=json.dumps([t.to_dict() for t in tokens], ensure_ascii=False),
            )
        )
        n += 1
    return n


def status_map(session: Session, user_id: int, word_ids: Iterable[int]) -> dict[int, WordStatus]:
    ids = list(set(word_ids))
    if not ids:
        return {}
    rows = session.exec(
        select(UserWord).where(UserWord.user_id == user_id, UserWord.word_id.in_(ids))  # type: ignore[attr-defined]
    ).all()
    return {r.word_id: r.status for r in rows}


def episode_lines(session: Session, episode_id: int) -> list[SubtitleLine]:
    return list(
        session.exec(
            select(SubtitleLine)
            .where(SubtitleLine.episode_id == episode_id)
            .order_by(SubtitleLine.idx)  # type: ignore[arg-type]
        ).all()
    )


def understanding(session: Session, user_id: int, episode_id: int) -> dict:
    """How much of an episode's vocabulary the user understands.

    `token_pct` weighs words by how often they're spoken (what you actually experience
    watching); `unique_pct` counts each distinct word once.
    """
    counts: dict[int, int] = {}
    for line in episode_lines(session, episode_id):
        for t in json.loads(line.tokens_json):
            if t.get("is_content") and t.get("word_id"):
                counts[t["word_id"]] = counts.get(t["word_id"], 0) + 1
    statuses = status_map(session, user_id, counts)
    total_tokens = sum(counts.values())
    known_tokens = sum(c for w, c in counts.items() if statuses.get(w) in UNDERSTOOD)
    learning_tokens = sum(c for w, c in counts.items() if statuses.get(w) == WordStatus.learning)
    known_unique = sum(1 for w in counts if statuses.get(w) in UNDERSTOOD)
    learning_unique = sum(1 for w in counts if statuses.get(w) == WordStatus.learning)

    def pct(a: int, b: int) -> float:
        return round(100 * a / b, 1) if b else 0.0

    return {
        "episode_id": episode_id,
        "total_tokens": total_tokens,
        "unique_words": len(counts),
        "known_tokens": known_tokens,
        "known_unique": known_unique,
        "learning_tokens": learning_tokens,
        "learning_unique": learning_unique,
        "token_pct": pct(known_tokens, total_tokens),
        "unique_pct": pct(known_unique, len(counts)),
    }
