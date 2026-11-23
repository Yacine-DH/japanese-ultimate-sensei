"""Auto-sync by recognizing the Japanese speech (S-22, #147).

The VAD correlation in `app.sync` only knows *when* someone talks, so music, effects and long
stretches of similar dialogue rhythm fool it. Here a small Japanese ASR model turns the sample
into text, and each subtitle line that is clearly *heard* in the sample becomes an anchor:
"line N starts at sample time T", so offset = video time of T - line.start_ms.

Pipeline (the recognizer is pluggable so this module stays pure and testable):
1. `speech_chunks`: cut the sample at pauses (webrtcvad frames from `app.sync`).
2. The recognizer turns each chunk into text, optionally with a time per character.
3. `to_kana`: recognized text and subtitle lines → hiragana via Sudachi readings, so 十二人,
   12人 and じゅうににん compare equal and kanji choice doesn't matter.
4. `find_anchors`: for each line near the current offset, find where it is heard best;
   lines heard clearly (most of their kana in order) and unambiguously become anchors.
5. `asr_offset`: the biggest group of anchors that agree (± AGREE_MS) gives the offset
   (median). Fewer than MIN_ANCHORS agreeing → None, and the caller falls back to VAD.
"""

import array
import logging
import statistics
import sys
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

from app.nlp.kana import kata_to_hira

log = logging.getLogger(__name__)

# ReazonSpeech k2 v2 (Zipformer, ~0.16B params, trained on ~35k h of Japanese TV), int8 ONNX for
# sherpa-onnx. `python -m app.asr_setup` downloads it into <data_dir>/models/.
MODEL_NAME = "sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01"
MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/" + MODEL_NAME + ".tar.bz2"
)

Recognize = Callable[[bytes], tuple[str, list[int] | None]]

SAMPLE_RATE = 16_000
FRAME_MS = 10
# Chunking: a pause this long ends a chunk; chunks are kept short for the recognizer.
CHUNK_GAP_MS = 400
MIN_CHUNK_MS = 500
MAX_CHUNK_MS = 12_000
# Matching: a line is "heard" when this share of its kana appears in order in one chunk.
MIN_LINE_KANA = 5  # shorter lines (はい, えっ…) are too generic to anchor anything
MIN_MATCHED_KANA = 5
MIN_LINE_SCORE = 0.6
MIN_SCORE_GAP = 0.15  # the best place must beat the line's second-best chunk by this much
# Aggregation
AGREE_MS = 1500  # anchors within this of each other describe the same offset
MIN_ANCHORS = 3
MIN_AGREE_SHARE = 0.5  # the winning group must hold at least half of all anchors


@dataclass
class Segment:
    """Recognized speech; times are ms from the start of the sample."""

    start_ms: int
    end_ms: int
    text: str
    char_ms: list[int] | None = None  # time of each character of `text`, when the model has it


@dataclass
class Anchor:
    line_index: int  # index into the `lines` given to find_anchors
    line_start_ms: int
    heard_ms: int  # sample time where the line starts being heard
    offset_ms: int  # video time - subtitle time
    score: float


@dataclass
class AsrResult:
    offset_ms: int
    confident: bool
    anchors: list[Anchor] = field(default_factory=list)
    agreeing: int = 0  # anchors in the winning group
    runner_up: int = 0  # anchors in the best group with a clearly different offset
    detail: str = ""


# ---- chunking -----------------------------------------------------------------------------


def speech_chunks(vad: Sequence[bool]) -> list[tuple[int, int]]:
    """(start_ms, end_ms) of speech stretches: gaps < CHUNK_GAP_MS are bridged, chunks shorter
    than MIN_CHUNK_MS dropped, longer than MAX_CHUNK_MS split."""
    gap = CHUNK_GAP_MS // FRAME_MS
    out: list[tuple[int, int]] = []
    start = last = None
    for i, on in enumerate(vad):
        if not on:
            continue
        if start is None:
            start = last = i
        elif i - last > gap:
            out.append((start, last + 1))
            start = i
        last = i
    if start is not None:
        out.append((start, last + 1))
    chunks: list[tuple[int, int]] = []
    step = MAX_CHUNK_MS // FRAME_MS
    for s, e in out:
        for cs in range(s, e, step):
            ce = min(e, cs + step)
            if (ce - cs) * FRAME_MS >= MIN_CHUNK_MS:
                chunks.append((cs * FRAME_MS, ce * FRAME_MS))
    return chunks


def recognize_chunks(
    pcm: bytes, vad: Sequence[bool], recognize: Callable[[bytes], tuple[str, list[int] | None]]
) -> list[Segment]:
    """Run `recognize(pcm_chunk) -> (text, char_ms relative to the chunk or None)` per chunk."""
    bytes_per_ms = SAMPLE_RATE * 2 // 1000
    out = []
    for s, e in speech_chunks(vad):
        text, char_ms = recognize(pcm[s * bytes_per_ms : e * bytes_per_ms])
        if text.strip():
            out.append(Segment(s, e, text, [s + t for t in char_ms] if char_ms else None))
    return out


# ---- kana normalization -------------------------------------------------------------------


def _keep(ch: str) -> bool:
    return "ぁ" <= ch <= "ゖ"


def to_kana(text: str, char_ms: Sequence[int] | None = None) -> tuple[str, list[int] | None]:
    """Hiragana reading of `text` without punctuation/long-vowel marks, and (when `char_ms`
    gives a time per character of `text`) a time per kana: each morpheme's kana get the time
    of its first character."""
    from app.nlp.tokenizer import _reading_of, _sudachi

    tok, mode = _sudachi()
    kana: list[str] = []
    times: list[int] = []
    for m in tok.tokenize(text, mode):
        reading = kata_to_hira(_reading_of(m))
        t = char_ms[min(m.begin(), len(char_ms) - 1)] if char_ms else 0
        for ch in reading:
            if _keep(ch):
                kana.append(ch)
                times.append(t)
    return "".join(kana), (times if char_ms else None)


# ---- matching -----------------------------------------------------------------------------


@dataclass
class _Heard:
    kana: str
    times: list[int]  # sample ms per kana (interpolated over the chunk when the model has none)


def _heard(seg: Segment) -> _Heard | None:
    kana, times = to_kana(seg.text, seg.char_ms)
    if not kana:
        return None
    if times is None:
        n = len(kana)
        times = [seg.start_ms + (seg.end_ms - seg.start_ms) * i // n for i in range(n)]
    return _Heard(kana, times)


def _match(line: str, heard: _Heard) -> tuple[float, int] | None:
    """(share of the line's kana heard in order, sample ms where the line starts) or None."""
    sm = SequenceMatcher(None, heard.kana, line, autojunk=False)
    blocks = [b for b in sm.get_matching_blocks() if b.size >= 2]
    matched = sum(b.size for b in blocks)
    if matched < MIN_MATCHED_KANA:
        return None
    first = blocks[0]
    # The line's first kana sits `first.b` kana before the first match: step back at the
    # chunk's speaking rate (the start may lie before the chunk when VAD cut it late).
    n = len(heard.kana)
    rate = (heard.times[-1] - heard.times[0]) / (n - 1) if n > 1 else 0
    start = heard.times[first.a] - round(first.b * rate)
    return matched / len(line), start


def find_anchors(
    lines: Sequence[tuple[int, int, str]],
    segments: Sequence[Segment],
    video_start_ms: int,
    lo_ms: int,
    hi_ms: int,
) -> list[Anchor]:
    """Anchors for subtitle `lines` (start_ms, end_ms, text) heard in `segments`, considering
    only offsets in [lo_ms, hi_ms]. Lines that share their kana with another candidate line
    (repeated phrases) are skipped: they can't tell where we are."""
    heard = [h for h in (_heard(s) for s in segments) if h]
    if not heard:
        return []
    sample_end = max(h.times[-1] for h in heard)
    cands: list[tuple[int, int, str]] = []
    for i, (s, _e, text) in enumerate(lines):
        # the line must be able to start inside the sample for some allowed offset
        if s + lo_ms > video_start_ms + sample_end + 1000 or s + hi_ms < video_start_ms - 1000:
            continue
        kana, _ = to_kana(text)
        if len(kana) >= MIN_LINE_KANA:
            cands.append((i, s, kana))
    counts: dict[str, int] = {}
    for _, _, k in cands:
        counts[k] = counts.get(k, 0) + 1
    anchors = []
    for i, s, kana in cands:
        if counts[kana] > 1:
            continue
        scored = sorted(
            (m for m in (_match(kana, h) for h in heard) if m), key=lambda m: m[0], reverse=True
        )
        if not scored or scored[0][0] < MIN_LINE_SCORE:
            continue
        if len(scored) > 1 and scored[0][0] - scored[1][0] < MIN_SCORE_GAP:
            continue
        score, at = scored[0]
        offset = video_start_ms + at - s
        if lo_ms <= offset <= hi_ms:
            anchors.append(Anchor(i, s, at, offset, round(score, 3)))
    return anchors


def asr_offset(anchors: Sequence[Anchor]) -> AsrResult:
    """The offset most anchors agree on (median of the winning group)."""
    if not anchors:
        return AsrResult(0, False, [], 0, 0, "no subtitle line recognized in the sample")

    def group(center: int) -> list[Anchor]:
        return [a for a in anchors if abs(a.offset_ms - center) <= AGREE_MS]

    best = max((group(a.offset_ms) for a in anchors), key=len)
    offset = round(statistics.median(a.offset_ms for a in best))
    others = [a for a in anchors if abs(a.offset_ms - offset) > 2 * AGREE_MS]
    runner_up = max((len(group(a.offset_ms)) for a in others), default=0)
    confident = (
        len(best) >= MIN_ANCHORS
        and len(best) >= MIN_AGREE_SHARE * len(anchors)
        and len(best) > runner_up
    )
    detail = (
        "ok"
        if confident
        else f"only {len(best)} of {len(anchors)} recognized lines agree (need {MIN_ANCHORS})"
    )
    return AsrResult(offset, confident, list(anchors), len(best), runner_up, detail)


# ---- the recognizer (sherpa-onnx, optional) ------------------------------------------------


def _model_file(model_dir: Path, prefix: str) -> Path | None:
    """encoder/decoder/joiner: prefer the int8 file."""
    files = sorted(model_dir.glob(f"{prefix}*.onnx"))
    return next((f for f in files if ".int8." in f.name), files[0] if files else None)


def load_recognizer(model_dir: Path, threads: int = 2) -> Recognize | None:
    """A `Recognize` backed by sherpa-onnx, or None when the library or the model is missing
    (auto-sync then uses voice activity only)."""
    try:
        import sherpa_onnx
    except ImportError:
        log.info("sherpa-onnx is not installed: auto-sync uses voice activity only")
        return None
    parts = {p: _model_file(model_dir, p) for p in ("encoder", "decoder", "joiner")}
    tokens = model_dir / "tokens.txt"
    if not all(parts.values()) or not tokens.exists():
        log.info("ASR model not found in %s: auto-sync uses voice activity only", model_dir)
        return None
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(parts["encoder"]),
        decoder=str(parts["decoder"]),
        joiner=str(parts["joiner"]),
        tokens=str(tokens),
        num_threads=threads,
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        decoding_method="greedy_search",
    )
    lock = threading.Lock()  # one decode at a time: the server has 4 slow cores

    def recognize(pcm: bytes) -> tuple[str, list[int] | None]:
        samples = array.array("h")
        samples.frombytes(pcm[: len(pcm) // 2 * 2])
        if sys.byteorder == "big":
            samples.byteswap()
        with lock:
            stream = rec.create_stream()
            stream.accept_waveform(SAMPLE_RATE, [x / 32768 for x in samples])
            rec.decode_stream(stream)
            res = stream.result
        text = res.text or ""
        # one timestamp (s) per token; a token can be several characters
        char_ms: list[int] = []
        for tok, ts in zip(res.tokens or [], res.timestamps or [], strict=False):
            char_ms += [round(ts * 1000)] * len(tok)
        return text, char_ms if len(char_ms) == len(text) else None

    return recognize


# ---- the whole ASR path --------------------------------------------------------------------


def sync_pcm(
    pcm: bytes,
    vad: Sequence[bool],
    lines: Sequence[tuple[int, int, str]],
    video_start_ms: int,
    lo_ms: int,
    hi_ms: int,
    recognize: Recognize,
) -> AsrResult:
    """Recognize the sample's speech chunks and turn the lines heard into an offset."""
    segments = recognize_chunks(pcm, vad, recognize)
    return asr_offset(find_anchors(lines, segments, video_start_ms, lo_ms, hi_ms))
