"""Database tables (SQLModel / SQLite).

Conventions:
- Times in subtitles are integer milliseconds.
- User-scoped tables carry `user_id` (single user = 1 for now).
- Token lists are stored as JSON text on `SubtitleLine.tokens_json` (computed once at ingest).
"""

from datetime import UTC, date, datetime
from enum import StrEnum

from sqlmodel import Field, SQLModel, UniqueConstraint


def utcnow() -> datetime:
    return datetime.now(UTC)


class WordStatus(StrEnum):
    new = "new"  # never seen / no decision yet (implicit when no UserWord row exists)
    learning = "learning"  # has a card / being studied
    known = "known"
    ignored = "ignored"  # names, noise — counts as "understood"


class MediaKind(StrEnum):
    screenshot = "screenshot"
    audio = "audio"
    clip = "clip"


class Anime(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    title: str = Field(index=True)
    title_jp: str | None = None
    anilist_id: int | None = Field(default=None, index=True)
    jimaku_entry_id: int | None = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utcnow)


class Episode(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    anime_id: int | None = Field(default=None, foreign_key="anime.id", index=True)
    number: float | None = None
    title: str | None = None
    source: str = "upload"  # upload | jimaku | stt
    source_filename: str | None = None
    # Shift applied by clients: display line when video_time_ms == start_ms + sub_offset_ms.
    sub_offset_ms: int = 0
    created_at: datetime = Field(default_factory=utcnow)


class SubtitleLine(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    episode_id: int = Field(foreign_key="episode.id", index=True)
    idx: int
    start_ms: int
    end_ms: int
    text: str
    tokens_json: str = "[]"
    translation_en: str | None = None  # filled later by LLM batch jobs
    translation_de: str | None = None


class Word(SQLModel, table=True):
    """A dictionary-form vocabulary item (lemma + reading)."""

    __table_args__ = (UniqueConstraint("lemma", "reading"),)

    id: int | None = Field(default=None, primary_key=True)
    lemma: str = Field(index=True)
    reading: str  # hiragana
    pos: str = ""
    jmdict_id: str | None = Field(default=None, index=True)
    common: bool = False  # JMdict "common" flag
    # wordfreq Zipf frequency (0–8, ~log10 per billion words; 0 = unknown, None = not computed).
    # Main signal for which unknown words are worth learning first.
    zipf: float | None = None


class UserWord(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("user_id", "word_id"),)

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)
    word_id: int = Field(foreign_key="word.id", index=True)
    status: WordStatus = WordStatus.new
    updated_at: datetime = Field(default_factory=utcnow)


class Card(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)
    word_id: int = Field(foreign_key="word.id", index=True)
    line_id: int | None = Field(default=None, foreign_key="subtitleline.id")
    sentence: str = ""
    fsrs_json: str = "{}"  # serialized FSRS card state (Phase 1)
    due: datetime = Field(default_factory=utcnow, index=True)
    created_at: datetime = Field(default_factory=utcnow)


class ReviewLog(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    card_id: int = Field(foreign_key="card.id", index=True)
    rating: int  # 1 again, 2 hard, 3 good, 4 easy
    reviewed_at: datetime = Field(default_factory=utcnow)
    duration_ms: int | None = None


class Media(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    card_id: int | None = Field(default=None, foreign_key="card.id", index=True)
    kind: MediaKind
    path: str  # relative to settings.media_dir
    mime: str
    bytes: int = 0
    created_at: datetime = Field(default_factory=utcnow)


class ActivityDay(SQLModel, table=True):
    """One row per user per day — feeds the GitHub-style heatmap."""

    user_id: int = Field(primary_key=True)
    day: date = Field(primary_key=True)
    minutes_watched: int = 0  # unused: watch time lives in WatchDay (seconds, per episode)
    reviews: int = 0
    words_added: int = 0
    words_known: int = 0


class WatchDay(SQLModel, table=True):
    """Seconds watched with the overlay active, per user, day and episode (heartbeats)."""

    user_id: int = Field(primary_key=True)
    day: date = Field(primary_key=True)
    episode_id: int = Field(primary_key=True, foreign_key="episode.id")
    seconds: int = 0


class UnderstandingSnapshot(SQLModel, table=True):
    """Daily "% understood" of a whole anime (all its episodes' words), for the trend chart.
    Overwritten during the day, so each day keeps its latest value."""

    user_id: int = Field(primary_key=True)
    anime_id: int = Field(primary_key=True, foreign_key="anime.id")
    day: date = Field(primary_key=True)
    token_pct: float = 0
    unique_pct: float = 0
    unique_words: int = 0
    known_unique: int = 0


class LineNote(SQLModel, table=True):
    """Cached LLM grammar explanation of a subtitle line, per language."""

    line_id: int = Field(primary_key=True, foreign_key="subtitleline.id")
    lang: str = Field(primary_key=True)  # en | de
    text: str
    model: str
    created_at: datetime = Field(default_factory=utcnow)
