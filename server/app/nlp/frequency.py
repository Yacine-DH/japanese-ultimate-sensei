"""General word frequency (wordfreq, CC BY-SA 4.0; Japanese data includes subtitles + web).

Zipf scale: ~log10(occurrences per billion words). 7+ = particles, 5–6 = everyday words,
3–4 = less common, < 2 = rare, 0 = unknown to wordfreq.
"""

import math
from collections.abc import Iterable
from functools import lru_cache

from sqlmodel import Session

from app.models import Word


@lru_cache(maxsize=100_000)
def zipf(lemma: str) -> float:
    from wordfreq import zipf_frequency

    try:
        return round(zipf_frequency(lemma, "ja"), 2)
    except Exception:  # tokenizer edge cases: treat as unknown
        return 0.0


def fill_zipf(session: Session, words: Iterable[Word]) -> None:
    """Compute missing frequencies (words created before the column existed)."""
    for w in words:
        if w.zipf is None:
            w.zipf = zipf(w.lemma)
            session.add(w)


def usefulness(zipf_value: float | None, in_episode: int, in_anime: int) -> float:
    """Rank unknown words: general frequency + how much this episode / anime uses them."""
    return round(
        (zipf_value or 0.0) + 1.5 * math.log2(1 + in_episode) + 0.5 * math.log2(1 + in_anime), 3
    )
