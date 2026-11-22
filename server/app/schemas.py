"""API request/response models. This is the contract with the extension and web app —
change it deliberately and regenerate docs/openapi.json (see AGENTS.md)."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models import MediaKind, WordStatus


class Health(BaseModel):
    status: str = "ok"
    version: str
    dictionary: bool = Field(description="True when data/jmdict.sqlite is available")
    auth: bool = Field(description="True when an API token is required")
    ffmpeg: bool = Field(default=False, description="True when media uploads can be transcoded")
    media_bytes: int = Field(default=0, description="Total size of stored media")


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
    common: bool = Field(default=False, description="JMdict common word")
    zipf: float | None = Field(
        default=None,
        description="General frequency (Zipf 0–8; 5+ everyday, <3 rare, 0 unknown). Rank "
        "unknown words to highlight by this, highest first",
    )


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


class SyncOut(BaseModel):
    offset_ms: int = Field(description="Best sub_offset_ms found (a guess when not confident)")
    previous_offset_ms: int
    applied: bool = Field(description="True when the episode's sub_offset_ms was set to offset_ms")
    confident: bool = Field(description="confidence >= 4.5 and >= runner_up + 1")
    confidence: float = Field(
        description="How far the best offset stands out (std devs above all others; noise ≈ 2-4)"
    )
    runner_up: float = Field(description="The same for the best offset ≥ 1.5 s away")
    correlation: float = Field(description="Speech/subtitle correlation at the best offset")
    speech_ms: int = Field(description="Speech detected in the sample")
    sample_ms: int
    lines_in_window: int
    detail: str = Field(description="'ok', or why the result isn't confident")


class WordOut(BaseModel):
    id: int
    lemma: str
    reading: str
    pos: str
    jmdict_id: str | None
    common: bool
    zipf: float | None = Field(default=None, description="General frequency (Zipf 0–8)")
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


# ---- cards + reviews (S-3) -------------------------------------------------------------


class MediaOut(BaseModel):
    id: int
    kind: MediaKind
    mime: str
    url: str = Field(
        description="Relative to the server base URL, already signed (/media/12?sig=…): usable "
        "directly in <img>/<audio>/<video> without an auth header"
    )
    bytes: int = 0
    ready: bool = Field(
        default=True,
        description="False while a clip is still being transcoded (url serves the original)",
    )


class CardCreate(BaseModel):
    word_id: int
    line_id: int | None = Field(default=None, description="Subtitle line the word was seen in")
    media_ids: list[int] = Field(default=[], description="From POST /media (screenshot/audio/clip)")
    sentence: str | None = Field(default=None, description="Defaults to the line's text")


class CardOut(BaseModel):
    id: int
    word_id: int
    line_id: int | None
    sentence: str
    state: Literal["learning", "review", "relearning"]
    due: datetime
    stability: float | None = Field(description="FSRS stability in days; null before 1st review")
    difficulty: float | None
    reps: int
    created_at: datetime


class CardCreated(CardOut):
    created: bool = Field(description="False when the word already had a card (returned as is)")


class EpisodeRef(BaseModel):
    id: int
    anime_title: str | None
    number: float | None


class ReviewCard(BaseModel):
    card: CardOut
    word: WordOut
    line: LineOut | None = Field(description="Sentence with tokens + furigana (null if no line)")
    episode: EpisodeRef | None
    entry: DictEntry | None = Field(description="Best JMdict entry (EN + DE glosses)")
    media: list[MediaOut]
    next_due: dict[str, datetime] = Field(
        description="Due date per rating '1'..'4' (Again/Hard/Good/Easy) for button labels"
    )


class ReviewQueue(BaseModel):
    due_total: int = Field(description="All cards due now (the queue may be limited)")
    cards: list[ReviewCard]


class ReviewIn(BaseModel):
    card_id: int
    rating: int = Field(ge=1, le=4, description="1 Again · 2 Hard · 3 Good · 4 Easy")
    duration_ms: int | None = Field(default=None, ge=0)


class ReviewOut(BaseModel):
    card: CardOut
    word_status: WordStatus
    graduated: bool = Field(description="True when this review made the word 'known'")


# ---- Jimaku subtitle search (S-1) ----------------------------------------------------


class JimakuEntry(BaseModel):
    id: int
    name: str = Field(description="Romaji title")
    english_name: str | None = None
    japanese_name: str | None = None
    anilist_id: int | None = None
    movie: bool = False


class JimakuFile(BaseModel):
    name: str = Field(description="Pass this as file_name to POST /episodes/from-jimaku")
    size: int
    last_modified: str
    format: str = Field(description="srt | ass | ssa | vtt | zip | 7z | rar | sup | other")
    supported: bool = Field(description="Importable (text subtitles, or a zip of them)")
    episode: int | None = Field(description="Episode number guessed from the file name")
    multi_episode: bool = Field(
        description="Several episodes in one file (e.g. 01-04): can't import"
    )
    web_source: bool = Field(description="Web release: timing likely matches streaming sites")
    dual_language: bool = Field(
        default=False, description="Also has English/Chinese lines (ja-en, CHS/JPN): avoid"
    )
    recommended: bool = Field(description="Best pick (at most one per list)")


class AutoImport(BaseModel):
    query: str | None = Field(
        default=None, description="Anime title guessed from the page (needed without anime_id)"
    )
    episode_number: float
    anime_id: int | None = Field(
        default=None, description="A library anime (e.g. remembered for this site): skips search"
    )


class AutoImportOut(BaseModel):
    episode: EpisodeCreated
    existing: bool = Field(description="True: the episode was already in the library")
    entry: JimakuEntry
    file_name: str | None = Field(
        default=None, description="The Jimaku file imported (None if existing)"
    )


class JimakuImport(BaseModel):
    entry_id: int
    file_name: str
    episode_number: float | None = Field(
        default=None, description="Defaults to the number guessed from the file name"
    )
    anime_title: str | None = Field(
        default=None, description="Defaults to the entry's English title (else romaji)"
    )


# ---- activity + progress (S-6) ---------------------------------------------------------


class WatchIn(BaseModel):
    episode_id: int
    seconds: int = Field(ge=1, le=600, description="Seconds watched since the last heartbeat")


class WatchOut(BaseModel):
    day: date
    seconds_today: int = Field(description="All episodes, today")


class ActivityDayOut(BaseModel):
    day: date
    minutes: int = Field(description="Watched with the overlay active")
    reviews: int
    words_added: int = Field(description="Cards created")
    words_known: int = Field(description="Words that became known (marked or graduated)")


class ActivityTotals(BaseModel):
    minutes: int
    reviews: int
    words_added: int
    words_known: int


class ActivityOut(BaseModel):
    from_day: date
    to_day: date
    days: list[ActivityDayOut] = Field(description="Only days with activity, oldest first")
    active_days: int
    current_streak: int = Field(description="Consecutive active days up to today (or yesterday)")
    longest_streak: int
    totals: ActivityTotals


class AnimeOut(BaseModel):
    id: int
    title: str
    title_jp: str | None
    anilist_id: int | None
    episode_count: int
    unique_words: int = Field(description="Distinct content words across its episodes")
    known_unique: int
    token_pct: float = Field(description="% understood across all its episodes (weighted)")
    unique_pct: float


class ProgressPoint(BaseModel):
    day: date
    token_pct: float
    unique_pct: float
    unique_words: int
    known_unique: int


class EpisodeProgress(BaseModel):
    episode_id: int
    number: float | None
    title: str | None
    token_pct: float
    unique_pct: float
    minutes_watched: int


class AnimeProgress(BaseModel):
    anime: AnimeOut
    series: list[ProgressPoint] = Field(description="Daily anime-level % understood, oldest first")
    episodes: list[EpisodeProgress]


# ---- known-word import (S-4) -----------------------------------------------------------


class AnkiNoteType(BaseModel):
    name: str
    fields: list[str]
    field_used: str = Field(description="Field read as the Japanese word (pass `field` to change)")
    notes: int


class ImportReport(BaseModel):
    total: int = Field(description="Distinct words in the input")
    matched: int = Field(description="Recognised as a single vocabulary word")
    updated: int = Field(description="Status raised (new→learning/known, learning→known)")
    already: int = Field(description="Matched but unchanged (already at that level, or ignored)")
    unmatched_count: int
    unmatched: list[str] = Field(description="First 200 entries that aren't a single word")
    skipped_new: int = Field(default=0, description="Anki notes never studied (not imported)")
    dry_run: bool
    note_types: list[AnkiNoteType] = []
    decks: list[str] = []


class WordListImport(BaseModel):
    text: str = Field(max_length=1_000_000, description="One word per line (Anki furigana/HTML ok)")
    status: Literal[WordStatus.known, WordStatus.learning] = WordStatus.known
    dry_run: bool = False


class AnkiCardIn(BaseModel):
    expression: str
    interval_days: int = Field(ge=0, description="AnkiConnect cardsInfo `interval`")
    studied: bool = Field(default=True, description="False for new (type 0) cards")


class AnkiCardsImport(BaseModel):
    cards: list[AnkiCardIn] = Field(max_length=100_000)
    mature_days: int = Field(default=21, ge=1, le=365)
    dry_run: bool = False


# ---- Anki export (S-5) -----------------------------------------------------------------


class AnkiConnectNote(BaseModel):
    deckName: str
    modelName: str
    fields: dict[str, str]
    tags: list[str]
    options: dict = Field(default={"allowDuplicate": False, "duplicateScope": "deck"})


class AnkiMediaFile(BaseModel):
    filename: str
    url: str = Field(
        description="Absolute, signed: pass to AnkiConnect storeMediaFile {filename, url}"
    )


class AnkiNotePayload(BaseModel):
    note: AnkiConnectNote = Field(description="Pass as AnkiConnect addNote {note}")
    media: list[AnkiMediaFile] = Field(description="storeMediaFile each one before addNote")


class AnkiCardTemplate(BaseModel):
    Name: str
    Front: str
    Back: str


class AnkiModel(BaseModel):
    """AnkiConnect createModel params for the 'Sensei Japanese' note type."""

    modelName: str
    inOrderFields: list[str]
    css: str
    isCloze: bool
    cardTemplates: list[AnkiCardTemplate]


# ---- missed words (S-8) ----------------------------------------------------------------


class ExampleLine(BaseModel):
    line_id: int
    text: str
    start_ms: int


class MissedWord(BaseModel):
    word: WordListItem = Field(description="`occurrences` = times spoken in this episode")
    score: float = Field(description="Usefulness: general frequency + use in this episode/anime")
    anime_occurrences: int = Field(description="Times spoken across the whole anime")
    example: ExampleLine | None = Field(description="First line of the episode with the word")
    gloss_en: str | None = Field(description="First meaning (short), for a quick list")
    gloss_de: str | None


# ---- LLM translations + grammar notes (S-9) -------------------------------------------


class LLMStatus(BaseModel):
    configured: bool
    reachable: bool
    model: str | None
    base_url: str | None
    detail: str


class TranslationJob(BaseModel):
    episode_id: int
    total_lines: int
    translated_lines: int = Field(description="Lines with an English translation")
    queued: bool
    running: bool
    error: str | None = Field(description="Why the last run stopped (LLM unreachable, …)")
    failed_lines: int = Field(description="Lines the model skipped in the last run (retry later)")


class SttStatus(BaseModel):
    configured: bool
    reachable: bool
    base_url: str | None
    model: str | None
    detail: str


class SttJobOut(BaseModel):
    id: int
    status: Literal["queued", "extracting", "transcribing", "importing", "done", "error"]
    anime_title: str
    episode_number: float | None
    title: str | None
    filename: str
    duration_ms: int | None = Field(description="Audio length, known once extracted")
    episode_id: int | None = Field(description="The new episode, once done")
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class LineExplanation(BaseModel):
    line_id: int
    lang: Literal["en", "de"]
    text: str = Field(description="Markdown: translation, word breakdown, grammar points")
    model: str
    cached: bool
