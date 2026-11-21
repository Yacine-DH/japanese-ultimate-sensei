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
# TV subs mark "continues on the next line" with arrows (長距離魔法は➡) or ｠.
_MARKS_RE = re.compile(r"[➡➜➞→⇒｠]")
# Netflix-style readings after a kanji word: 蒼月草(そうげつそう).
_INLINE_READING_RE = re.compile(r"(?<=[\u4e00-\u9fff々〆ヶ])[（(][ぁ-ゖー]{1,20}[）)]")
# A whole line in （…） is a thought or whisper unless it names a sound: （足音） （鐘の音）
# （人々の逃げ惑う声） （寝息） （ノック）.
_PAREN_LINE_RE = re.compile(r"^[（(]([^（）()。、！？!?…\s]{1,30})[）)]$")
_SOUND_TAILS = (
    "音", "声", "息", "笑い", "ノック", "拍手", "悲鳴", "いびき", "咳", "せき", "チャイム",
    "ブザー", "歓声", "ざわめき", "鳴き", "うなり", "BGM", "音楽",
)  # fmt: skip


def is_sound_cue(part: str) -> bool:
    m = _PAREN_LINE_RE.match(part.strip())
    return bool(m) and m.group(1).endswith(_SOUND_TAILS)


def strip_annotations(part: str) -> str:
    """Remove SDH speaker labels, sound cues, continuation marks and inline readings. Speaker
    labels only go when real dialogue remains: a whole line in （…） is usually a thought or
    whisper, so it's kept, unless it is a sound cue."""
    part = _INLINE_READING_RE.sub("", _MARKS_RE.sub("", part)).strip()
    part = _CUE_RE.sub("", part).strip()  # ［拍手］ 〔笑い声〕: always cues
    if not part or is_sound_cue(part):
        return ""
    cleaned = _SPEAKER_RE.sub("", part).strip()
    return cleaned if has_japanese(cleaned) else part


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
