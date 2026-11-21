"""Subtitle file parsing (.srt / .ass / .ssa / .vtt) into clean Japanese lines."""

import re
from dataclasses import dataclass

import pysubs2

from app.nlp.kana import has_japanese

ENCODINGS = ("utf-8-sig", "cp932", "euc_jp")
_WS_RE = re.compile(r"[ \t　]+")
_DRAWING_RE = re.compile(r"\\p[1-9]")
# SDH annotations (Netflix/Amazon JP subs): a short speaker label before the dialogue,
# e.g. （ヒンメル）帰ったら…, and bracketed sound cues like ［拍手］ or 〔笑い〕.
_SPEAKER_RE = re.compile(r"^[（(][^（）()。、！？!?\s]{1,12}[）)]\s*")
_CUE_RE = re.compile(r"[［\[〔][^］\]〕]{1,20}[］\]〕]")


def strip_annotations(part: str) -> str:
    """Remove SDH speaker labels and sound cues, but only when real dialogue remains:
    a whole line in （…） is usually a thought or whisper, so it's kept."""
    cleaned = _CUE_RE.sub("", part).strip()
    cleaned = _SPEAKER_RE.sub("", cleaned).strip()
    return cleaned if has_japanese(cleaned) else part.strip()


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
        parts = [strip_annotations(_WS_RE.sub(" ", p)) for p in ev.plaintext.splitlines()]
        clean = strip_annotations(" ".join(p for p in parts if p))  # label on its own line
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
