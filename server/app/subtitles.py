"""Subtitle file parsing (.srt / .ass / .ssa / .vtt) into clean Japanese lines."""

import re
from dataclasses import dataclass

import pysubs2

from app.nlp.kana import has_japanese

ENCODINGS = ("utf-8-sig", "cp932", "euc_jp")
_WS_RE = re.compile(r"[ \t　]+")
_DRAWING_RE = re.compile(r"\\p[1-9]")


@dataclass
class ParsedLine:
    start_ms: int
    end_ms: int
    text: str


def decode(raw: bytes) -> str:
    """Decode subtitle bytes; Japanese fansubs are often Shift-JIS (cp932)."""
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16")
    for enc in ENCODINGS:
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def parse(text: str) -> list[ParsedLine]:
    """Parse subtitle text, keeping only dialogue lines that contain Japanese.

    Drops comments, vector drawings, override tags, and duplicate layered events.
    Multi-line events are joined with a single space.
    """
    subs = pysubs2.SSAFile.from_string(text)
    seen: set[tuple[int, int, str]] = set()
    out: list[ParsedLine] = []
    for ev in subs:
        if ev.is_comment or _DRAWING_RE.search(ev.text):
            continue
        clean = " ".join(
            _WS_RE.sub(" ", part).strip() for part in ev.plaintext.splitlines() if part.strip()
        )
        if not clean or not has_japanese(clean):
            continue
        key = (ev.start, ev.end, clean)
        if key in seen:
            continue
        seen.add(key)
        out.append(ParsedLine(start_ms=int(ev.start), end_ms=int(ev.end), text=clean))
    out.sort(key=lambda line: (line.start_ms, line.end_ms))
    return out


def parse_bytes(raw: bytes) -> list[ParsedLine]:
    return parse(decode(raw))
