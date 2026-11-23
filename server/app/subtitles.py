"""Subtitle file parsing (.srt / .ass / .ssa / .vtt) into clean Japanese lines."""

import re
from dataclasses import dataclass, field

import pysubs2

from app.nlp.kana import has_japanese

ENCODINGS = ("utf-8-sig", "cp932", "euc_jp")
_WS_RE = re.compile(r"[ \t　]+")
_DRAWING_RE = re.compile(r"\\p[1-9]")
# SDH annotations (Netflix/Amazon JP subs): a short speaker label before the dialogue,
# e.g. （ヒンメル）帰ったら…, and bracketed sound cues like ［拍手］ or 〔笑い〕.
# A reading inside the label is allowed: （岩鷲(ガンジュ)）うっ…  （ＷＩＳＥ(ワイズ)機関員）…
_NESTED_READING = r"[（(][ぁ-ゖァ-ヺー・･]{1,20}[）)]"
_LABEL = rf"[（(](?:[^（）()。、！？!?\s]|{_NESTED_READING}){{1,24}}[）)]"
_SPEAKER_RE = re.compile(rf"^(?:[-－‐]\s*)?{_LABEL}\s*")
# Two speakers in one event: -（モモ）ふっ！ -（彼氏）わぷっ！ (Netflix/Erai .ass)
_DASH_SPEAKER_RE = re.compile(rf"(?<=\s)[-－‐]\s*{_LABEL}\s*")
_CUE_RE = re.compile(r"[［\[〔][^］\]〕]{1,20}[］\]〕]")
# TV subs mark "continues on the next line" with arrows (長距離魔法は➡) or ｠.
_MARKS_RE = re.compile(r"[➡➜➞→⇒｠]")
# Netflix-style readings after a kanji word: 蒼月草(そうげつそう).
_INLINE_READING_RE = re.compile(r"(?<=[\u4e00-\u9fff々〆ヶ])[（(][ぁ-ゖー]{1,20}[）)]")
# The official reading of a word, given right after it (#139): kanji 綾瀬川弓親(あやせがわ ゆみちか),
# 尸魂界(ソウル・ソサエティ), 東国(オスタニア), or Latin/digits ＷＩＳＥ(ワイズ), ００７(ゼロゼロセブン).
_READING_BASE = r"[\u4e00-\u9fff々〆ヶ]+|[A-Za-zＡ-Ｚａ-ｚ0-9０-９]+"
_GIVEN_READING_RE = re.compile(
    rf"({_READING_BASE})[（(]([ぁ-ゖァ-ヺー][ぁ-ゖァ-ヺー・･ 　]{{0,29}})[）)]"
)
# A whole line in （…） is a thought or whisper unless it names a sound: （足音） （鐘の音）
# （人々の逃げ惑う声） （寝息） （ノック）.
_PAREN_LINE_RE = re.compile(r"^[（(]([^（）()。、！？!?…\s]{1,30})[）)]$")
_SOUND_TAILS = (
    "音", "声", "息", "笑い", "ノック", "拍手", "悲鳴", "いびき", "咳", "せき", "チャイム",
    "ブザー", "歓声", "ざわめき", "鳴き", "うなり", "BGM", "音楽",
    # seen in the 10-episode check (2026-11-23): （あくび） （すすり泣き） （看護師のせき払い）
    # （玉犬の遠ぼえ） （せき込み）
    "あくび", "泣き", "払い", "ぼえ", "吠え", "込み", "舌打ち", "うめき", "叫び", "鼻歌",
    "歌う", "笑う", "泣く", "叫ぶ",
)  # fmt: skip


_HIRAGANA_RE = re.compile(r"[ぁ-ゖ]")
# A cue after the dialogue: ハッ！ (気合)  カモーン！ (クラクション)  (One Piece TV subs)
_TRAILING_CUE_RE = re.compile(r"\s+[（(]([^（）()ぁ-ゖ。、！？!?…\s]{1,12})[）)]$")


def is_sound_cue(part: str) -> bool:
    """A whole line in （…） naming a sound. Without hiragana it is never speech or a thought:
    （鼓動） (咆哮) (クラクション); with it, the ending decides: （小声で歌う） （足音）."""
    m = _PAREN_LINE_RE.match(part.strip())
    if not m:
        return False
    inner = m.group(1)
    return not _HIRAGANA_RE.search(inner) or inner.endswith(_SOUND_TAILS)


def strip_annotations(part: str, keep_readings: bool = False) -> str:
    """Remove SDH speaker labels, sound cues, continuation marks and inline readings. Speaker
    labels only go when real dialogue remains: a whole line in （…） is usually a thought or
    whisper, so it's kept, unless it is a sound cue. `keep_readings` leaves 漢字(よみ) in
    place for `extract_readings`."""
    part = _MARKS_RE.sub("", part).strip()
    if not keep_readings:
        part = _INLINE_READING_RE.sub("", part).strip()
    part = _CUE_RE.sub("", part).strip()  # ［拍手］ 〔笑い声〕: always cues
    part = _TRAILING_CUE_RE.sub("", part).strip()
    if not part or is_sound_cue(_GIVEN_READING_RE.sub(r"\1", part)):
        return ""
    cleaned = _DASH_SPEAKER_RE.sub("", _SPEAKER_RE.sub("", part)).strip()
    return cleaned if has_japanese(cleaned) else part


def extract_readings(text: str) -> tuple[str, list[tuple[int, int, str]]]:
    """Take 漢字(よみ) annotations out of the text: (text, [(start, end, reading)]) with the
    character span of the annotated word in the returned text. Spaces in the reading go."""
    out, readings, last = [], [], 0
    pos = 0  # length of the text built so far
    for m in _GIVEN_READING_RE.finditer(text):
        before = text[last : m.start()]
        out.append(before + m.group(1))
        pos += len(before)
        reading = re.sub(r"[ 　]", "", m.group(2))
        readings.append((pos, pos + len(m.group(1)), reading))
        pos += len(m.group(1))
        last = m.end()
    out.append(text[last:])
    return "".join(out), readings


def clean_line(text: str) -> tuple[str, list[tuple[int, int, str]]]:
    """Subtitle cleanup for one (joined) line → (text, given readings)."""
    return extract_readings(strip_annotations(text, keep_readings=True))


@dataclass
class ParsedLine:
    start_ms: int
    end_ms: int
    text: str
    readings: list[tuple[int, int, str]] = field(default_factory=list)  # see extract_readings


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
        parts = [
            strip_annotations(_WS_RE.sub(" ", p), keep_readings=True)
            for p in ev.plaintext.splitlines()
        ]
        clean, readings = clean_line(" ".join(p for p in parts if p))  # label on its own line
        if not clean or not has_japanese(clean):
            continue
        key = (ev.start, ev.end, clean)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            ParsedLine(start_ms=int(ev.start), end_ms=int(ev.end), text=clean, readings=readings)
        )
    out.sort(key=lambda line: (line.start_ms, line.end_ms))
    return out


def parse_bytes(raw: bytes) -> list[ParsedLine]:
    return parse(decode(raw))
