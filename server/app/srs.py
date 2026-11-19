"""Cards + FSRS spaced repetition (py-fsrs), plus the daily activity counters it feeds."""

import json
from datetime import UTC, datetime

from fsrs import Card as FsrsCard
from fsrs import Rating, Scheduler, State
from sqlmodel import Session, func, select

from app.models import ActivityDay, Card, ReviewLog, UserWord, WordStatus

# Stability (days) after which a word counts as known: the next review would be ~3+ weeks
# out, which is where Anki users usually call a card "mature".
GRADUATE_STABILITY_DAYS = 21.0

scheduler = Scheduler()  # defaults: 90 % desired retention, 1 m / 10 m learning steps
STATE_NAMES = {State.Learning: "learning", State.Review: "review", State.Relearning: "relearning"}


def as_utc(dt: datetime) -> datetime:
    """SQLite returns naive datetimes; everything we store is UTC."""
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def utcnow() -> datetime:
    return datetime.now(UTC)


def fsrs_of(card: Card) -> FsrsCard:
    data = json.loads(card.fsrs_json or "{}")
    if not data:
        fc = FsrsCard()
        fc.due = as_utc(card.due)
        return fc
    return FsrsCard.from_dict(data)


def store_fsrs(card: Card, fc: FsrsCard) -> None:
    card.fsrs_json = json.dumps(fc.to_dict())
    card.due = fc.due


def card_info(session: Session, card: Card) -> dict:
    fc = fsrs_of(card)
    reps = session.exec(
        select(func.count()).select_from(ReviewLog).where(ReviewLog.card_id == card.id)
    ).one()
    return {
        "id": card.id,
        "word_id": card.word_id,
        "line_id": card.line_id,
        "sentence": card.sentence,
        "state": STATE_NAMES[fc.state],
        "due": as_utc(card.due),
        "stability": fc.stability,
        "difficulty": fc.difficulty,
        "reps": reps,
        "created_at": as_utc(card.created_at),
    }


def preview(card: Card, now: datetime | None = None) -> dict[str, datetime]:
    """When the card would be due again for each rating, for the answer buttons."""
    now = now or utcnow()
    fc = fsrs_of(card)
    return {str(int(r)): scheduler.review_card(fc, r, now)[0].due for r in Rating}


def set_word_status(session: Session, user_id: int, word_id: int, status: WordStatus) -> None:
    uw = session.exec(
        select(UserWord).where(UserWord.user_id == user_id, UserWord.word_id == word_id)
    ).first() or UserWord(user_id=user_id, word_id=word_id)
    uw.status = status
    uw.updated_at = utcnow()
    session.add(uw)


def word_status(session: Session, user_id: int, word_id: int) -> WordStatus:
    uw = session.exec(
        select(UserWord).where(UserWord.user_id == user_id, UserWord.word_id == word_id)
    ).first()
    return uw.status if uw else WordStatus.new


def bump_activity(session: Session, user_id: int, **deltas: int) -> None:
    """Add to today's counters (server-local date, i.e. the owner's day)."""
    day = datetime.now().astimezone().date()
    row = session.get(ActivityDay, (user_id, day)) or ActivityDay(user_id=user_id, day=day)
    for k, v in deltas.items():
        setattr(row, k, getattr(row, k) + v)
    session.add(row)


def review(
    session: Session, user_id: int, card: Card, rating: int, duration_ms: int | None
) -> tuple[WordStatus, bool]:
    """Apply a rating. Returns (word status afterwards, whether it just graduated to known)."""
    now = utcnow()
    fc, _ = scheduler.review_card(fsrs_of(card), Rating(rating), now)
    store_fsrs(card, fc)
    session.add(card)
    session.add(ReviewLog(card_id=card.id, rating=rating, reviewed_at=now, duration_ms=duration_ms))

    before = word_status(session, user_id, card.word_id)
    after = before
    if before != WordStatus.ignored:
        mature = fc.state == State.Review and (fc.stability or 0) >= GRADUATE_STABILITY_DAYS
        after = WordStatus.known if mature else WordStatus.learning
        if after != before:
            set_word_status(session, user_id, card.word_id, after)
    graduated = after == WordStatus.known and before != WordStatus.known
    bump_activity(session, user_id, reviews=1, words_known=int(graduated))
    return after, graduated
