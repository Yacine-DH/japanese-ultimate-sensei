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
    is_content: bool = False  # learnable vocabulary (not particles, numbers or names)
    is_proper_noun: bool = False  # character/place names: never "unknown", not counted
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
        proper = is_proper_noun(pos, surface, m.is_oov())
        is_content = (
            pos[0] in CONTENT_POS
            and pos[1] not in SKIP_SUBPOS
            and has_japanese(surface)
            and not proper
        )
        out.append(
            Token(
                surface=surface,
                lemma=lemma,
                reading=reading,
                lemma_reading=lemma_reading(lemma) if is_content or proper else reading,
                normalized=m.normalized_form(),
                pos=pos[0],
                pos_detail=[p for p in pos[1:] if p != "*"],
                furigana=furigana(surface, reading),
                romaji=_romaji(surface, reading, pos[0]),
                is_content=is_content,
                is_proper_noun=proper,
            )
        )
    _fix_readings(out)
    _fix_trailing_sokuon(out)
    return out


def is_proper_noun(pos: list[str] | tuple[str, ...], surface: str, oov: bool = False) -> bool:
    """Names: Sudachi's 固有名詞, or katakana words Sudachi doesn't know (anime character
    names like フリーレン are out-of-vocabulary and get tagged as plain nouns)."""
    if pos[0] != "名詞":
        return False
    if len(pos) > 1 and pos[1] == "固有名詞":
        return True
    return oov and is_katakana_word(surface)


def is_katakana_word(s: str) -> bool:
    return bool(s) and all("\u30a0" <= c <= "\u30ff" for c in s)


# Sudachi gives dictionary-default readings with no context. Spoken (anime) Japanese mostly
# uses these instead; showing the formal one as furigana would mislead a learner. These are
# context-free, so they also change the word's key reading (old rows are merged on reprocess,
# see ingest.merge_reading_fixes).
COLLOQUIAL = {"私": "わたし", "明日": "あした", "貴方": "あなた"}
# 何 is なん before particles/auxiliaries starting with d/t/n sounds (なんで, なんの, なんだ,
# なんと, なんなの) and as a counter prefix (何冊, 何軒); otherwise なに (何を, 何が, 何飲んでるの).
_NAN_SOUNDS = ("だ", "で", "と", "の", "て", "ど", "な")


def _nan_or_nani(t: Token, nxt: Token | None) -> str:
    if "数詞" in t.pos_detail:
        return "なん"
    if nxt is not None and nxt.pos in ("助詞", "助動詞") and nxt.reading[:1] in _NAN_SOUNDS:
        return "なん"
    return "なに"


def _fix_readings(tokens: list[Token]) -> None:
    for i, t in enumerate(tokens):
        if t.surface in COLLOQUIAL and t.lemma == t.surface:
            new = COLLOQUIAL[t.surface]
            t.lemma_reading = new  # context-free: one key for the word everywhere
        elif t.surface == "何" and t.lemma == "何":
            # Display only: the word keeps Sudachi's lemma reading as its key, so 何を and
            # 何の are the same word (one status, one card).
            new = _nan_or_nani(t, tokens[i + 1] if i + 1 < len(tokens) else None)
        else:
            continue
        if new != t.reading:
            t.reading = new
            t.furigana = furigana(t.surface, new)
            t.romaji = _romaji(t.surface, new, t.pos)


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


# ---- whole-line romaji -------------------------------------------------------------------

_PUNCT = {
    "。": ".", "、": ",", "！": "!", "？": "?", "!": "!", "?": "?", "…": "...", "‥": "..",
    "・": " ", "～": "~", "〜": "~", "ー": "-", "」": "\"", "』": "\"", "）": ")", ")": ")",
}  # fmt: skip
_OPEN = {"「": '"', "『": '"', "（": "(", "(": "("}
# Conjunctive particles written together with the verb in Hepburn (食べて → tabete).
_GLUE_PARTICLES = {"て", "で", "ば", "ちゃ", "じゃ"}
# Auxiliaries glue only onto things that inflect; the copula after a noun stays a word.
_INFLECTING = {"動詞", "形容詞", "助動詞"}
_COPULA = {"だ", "です"}


def line_romaji(tokens: list[dict]) -> str:
    """Romaji for a whole line with words grouped the way learners read them.

    Inflections stick to their stem (食べ|たい → tabetai, 終わっ|た → owatta), honorific
    suffixes get a hyphen (フリーレン|様 → furiiren-sama), particles stay separate (wa, o).
    Works on stored token dicts so old episodes get it without reprocessing.
    """
    out = ""
    glue_next = True  # no space before the first word or after an opening bracket
    prev_pos = ""
    for t in tokens:
        surface, pos = t.get("surface", ""), t.get("pos", "")
        detail = t.get("pos_detail") or []
        if surface in _OPEN:
            out += ("" if glue_next else " ") + _OPEN[surface]
            glue_next = True
            continue
        if pos == "補助記号" or surface in _PUNCT:
            out += _PUNCT.get(surface, "" if has_japanese(surface) else surface)
            continue
        rom = (t.get("romaji") or "").strip()
        if not rom:
            continue
        if pos == "空白":
            glue_next = True
            continue
        glue = (pos == "助動詞" and prev_pos in _INFLECTING and t.get("lemma") not in _COPULA) or (
            pos == "助詞" and detail[:1] == ["接続助詞"] and surface in _GLUE_PARTICLES
        )
        if glue_next or not out:
            out += rom
        elif pos == "接尾辞":
            out += "-" + rom
        elif glue:
            out += rom
        else:
            out += " " + rom
        glue_next = False
        prev_pos = pos
    return out.strip()
