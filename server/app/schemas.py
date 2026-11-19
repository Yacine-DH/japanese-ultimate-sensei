"""API request/response models. This is the contract with the extension and web app —
change it deliberately and regenerate docs/openapi.json (see AGENTS.md)."""

from datetime import datetime

from pydantic import BaseModel, Field

from app.models import WordStatus


class Health(BaseModel):
    status: str = "ok"
    version: str
    dictionary: bool = Field(description="True when data/jmdict.sqlite is available")
    auth: bool = Field(description="True when an API token is required")


class FuriganaSegment(BaseModel):
    text: str
    ruby: str | None = Field(description="Hiragana reading shown above `text`; null for kana")


class TokenOut(BaseModel):
    surface: str
    lemma: str
    reading: str
    lemma_reading: str
    pos: str
    pos_detail: list[str]
    furigana: list[FuriganaSegment]
    romaji: str
    is_content: bool = Field(
        description="True for vocabulary worth learning (not particles, numbers or names)"
    )
    is_proper_noun: bool = Field(
        default=False,
        description="Character/place name. Not counted in understanding; don't highlight as unknown",
    )
    word_id: int | None
    status: WordStatus | None = Field(description="User's status for word_id; null if no word")
    common: bool = Field(default=False, description="JMdict common word — highlight priority")


class LineOut(BaseModel):
    id: int
    idx: int
    start_ms: int
    end_ms: int
    text: str
    tokens: list[TokenOut]
    romaji: str = Field(
        default="", description="Whole-line romaji, words grouped ('tabi wa owatta')"
    )
    translation_en: str | None = None
    translation_de: str | None = None


class Understanding(BaseModel):
    episode_id: int
    total_tokens: int
    unique_words: int
    known_tokens: int
    known_unique: int
    learning_tokens: int
    learning_unique: int
    token_pct: float = Field(description="% of spoken content words you understand")
    unique_pct: float = Field(description="% of distinct content words you understand")


class EpisodeOut(BaseModel):
    id: int
    anime_id: int | None
    anime_title: str | None
    number: float | None
    title: str | None
    source: str
    source_filename: str | None
    sub_offset_ms: int
    line_count: int
    created_at: datetime


class EpisodeCreated(EpisodeOut):
    understanding: Understanding


class EpisodePatch(BaseModel):
    sub_offset_ms: int | None = None
    title: str | None = None
    number: float | None = None


class WordOut(BaseModel):
    id: int
    lemma: str
    reading: str
    pos: str
    jmdict_id: str | None
    common: bool
    status: WordStatus


class WordListItem(WordOut):
    occurrences: int | None = Field(
        default=None,
        description="How often the word is spoken in the filtered anime/episode (null without one)",
    )


class WordPage(BaseModel):
    items: list[WordListItem]
    total: int = Field(description="Matches before limit/offset")


class WordStatusIn(BaseModel):
    status: WordStatus


class BulkStatusIn(BaseModel):
    word_ids: list[int] = Field(min_length=1, max_length=5000)
    status: WordStatus


class BulkStatusOut(BaseModel):
    updated: int
    missing: list[int] = Field(description="Requested ids that don't exist")


class Sense(BaseModel):
    pos: list[str]
    misc: list[str]
    glosses: list[str]


class DictEntry(BaseModel):
    id: str
    common: bool
    kanji: list[str]
    kana: list[str]
    senses: dict[str, list[Sense]] = Field(description="Keyed by language: 'eng', 'ger'")


class LookupResult(BaseModel):
    query: str
    reading: str | None
    entries: list[DictEntry]
