"""Pure-Python kana helpers and furigana alignment (no heavy dependencies)."""

import re
from functools import lru_cache

_KANJI_RE = re.compile(r"[㐀-䶿一-鿿豈-﫿々〆ヶ]")  # + 々 〆 ヶ
_JAPANESE_RE = re.compile(r"[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]")


def is_kanji(ch: str) -> bool:
    return bool(_KANJI_RE.match(ch))


def has_kanji(text: str) -> bool:
    return bool(_KANJI_RE.search(text))


def has_japanese(text: str) -> bool:
    return bool(_JAPANESE_RE.search(text))


def kata_to_hira(text: str) -> str:
    """Convert katakana to hiragana (ァ..ヶ → ぁ..ゖ). ー and other chars are kept."""
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in text)


def furigana(surface: str, reading: str) -> list[dict]:
    """Split `surface` into segments, attaching a reading (`ruby`) only over kanji runs.

    >>> furigana("食べる", "たべる")
    [{'text': '食', 'ruby': 'た'}, {'text': 'べる', 'ruby': None}]

    Falls back to a single segment when the reading can't be aligned with the kana parts.
    """
    reading = kata_to_hira(reading)
    if not surface:
        return []
    if not has_kanji(surface):
        return [{"text": surface, "ruby": None}]

    # Split into alternating kanji / non-kanji runs.
    runs: list[tuple[str, bool]] = []
    for ch in surface:
        k = is_kanji(ch)
        if runs and runs[-1][1] == k:
            runs[-1] = (runs[-1][0] + ch, k)
        else:
            runs.append((ch, k))

    pattern = "".join("(.+?)" if k else f"({re.escape(kata_to_hira(t))})" for t, k in runs)
    m = re.fullmatch(pattern, reading) if reading else None
    if not m:
        return [{"text": surface, "ruby": reading or None}]

    return [
        {"text": text, "ruby": m.group(i + 1) if k else None} for i, (text, k) in enumerate(runs)
    ]


@lru_cache(maxsize=1)
def _kakasi():
    import pykakasi

    return pykakasi.kakasi()


@lru_cache(maxsize=50_000)
def to_romaji(kana: str) -> str:
    """Hepburn romaji for a kana string."""
    if not kana:
        return ""
    return "".join(part["hepburn"] for part in _kakasi().convert(kana))
