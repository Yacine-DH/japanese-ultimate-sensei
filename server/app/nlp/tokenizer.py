"""Japanese tokenization with SudachiPy (mode B) → learner-friendly tokens."""

from dataclasses import asdict, dataclass, field
from functools import lru_cache

from app.nlp.kana import furigana, has_japanese, kata_to_hira, to_romaji

# Top-level Sudachi (UniDic-style) POS tags we treat as "real vocabulary".
CONTENT_POS = {"名詞", "動詞", "形容詞", "形状詞", "副詞", "連体詞", "感動詞", "代名詞", "接続詞"}
# Sub-categories that are not worth learning as words.
SKIP_SUBPOS = {"数詞"}


@dataclass
class Token:
    surface: str
    lemma: str
    reading: str  # hiragana reading of the surface form
    lemma_reading: str  # hiragana reading of the dictionary form
    normalized: str  # Sudachi normalized form (spelling variants unified)
    pos: str  # top-level POS (Japanese tag)
    pos_detail: list[str] = field(default_factory=list)
    furigana: list[dict] = field(default_factory=list)
    romaji: str = ""
    is_content: bool = False
    word_id: int | None = None  # filled in by ingest

    def to_dict(self) -> dict:
        return asdict(self)


@lru_cache(maxsize=1)
def _sudachi():
    from sudachipy import dictionary
    from sudachipy import tokenizer as sudachi_tokenizer

    d = dictionary.Dictionary(dict="core")
    tok = d.tokenizer() if hasattr(d, "tokenizer") else d.create()
    return tok, sudachi_tokenizer.Tokenizer.SplitMode.B


def _reading_of(m) -> str:
    r = kata_to_hira(m.reading_form() or "")
    return r if r else kata_to_hira(m.surface())


@lru_cache(maxsize=50_000)
def lemma_reading(lemma: str) -> str:
    """Reading of a dictionary form, obtained by tokenizing the lemma itself."""
    tok, mode = _sudachi()
    return "".join(_reading_of(m) for m in tok.tokenize(lemma, mode))


def tokenize(text: str) -> list[Token]:
    tok, mode = _sudachi()
    out: list[Token] = []
    for m in tok.tokenize(text, mode):
        surface = m.surface()
        pos = list(m.part_of_speech())
        reading = _reading_of(m)
        lemma = m.dictionary_form() or surface
        is_content = pos[0] in CONTENT_POS and pos[1] not in SKIP_SUBPOS and has_japanese(surface)
        out.append(
            Token(
                surface=surface,
                lemma=lemma,
                reading=reading,
                lemma_reading=lemma_reading(lemma) if is_content else reading,
                normalized=m.normalized_form(),
                pos=pos[0],
                pos_detail=[p for p in pos[1:] if p != "*"],
                furigana=furigana(surface, reading),
                romaji=_romaji(surface, reading, pos[0]),
                is_content=is_content,
            )
        )
    _fix_trailing_sokuon(out)
    return out


# Particles are pronounced differently from how they're written.
_PARTICLE_ROMAJI = {"は": "wa", "へ": "e", "を": "o"}


def _romaji(surface: str, reading: str, pos: str) -> str:
    if not has_japanese(surface):
        return surface
    if pos == "助詞" and surface in _PARTICLE_ROMAJI:
        return _PARTICLE_ROMAJI[surface]
    if reading.endswith("っ"):
        return to_romaji(reading[:-1]) + "っ"  # placeholder, resolved by _fix_trailing_sokuon
    return to_romaji(reading)


def _fix_trailing_sokuon(tokens: list[Token]) -> None:
    """A token ending in small っ (e.g. 終わっ|た) doubles the next token's first consonant."""
    for i, t in enumerate(tokens):
        if not t.romaji.endswith("っ"):
            continue
        nxt = tokens[i + 1].romaji if i + 1 < len(tokens) else ""
        double = nxt[0] if nxt[:1].isalpha() and nxt[0] not in "aeiouy" else ""
        if nxt.startswith("ch"):
            double = "t"  # Hepburn: っち → tchi
        t.romaji = t.romaji[:-1] + double
