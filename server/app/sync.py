"""Automatic subtitle sync (S-11), ffsubsync-style.

A short audio sample of the stream (recorded by the extension from a known video time) becomes a
"someone is talking" signal: webrtcvad voice activity plus loudness relative to the last few
seconds (VAD alone mistakes background music for speech). That signal is cross-correlated with
"a subtitle line is on screen" for every candidate offset; the best match is the offset.

Pure Python + webrtcvad (no numpy): coarse search at 100 ms over ±search range, then a fine
search at 10 ms around the peak. About a second for a 60 s sample on the home server.
"""

import array
import math
import statistics
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

SAMPLE_RATE = 16_000
VAD_FRAME_MS = 10
VAD_MODE = 3  # most aggressive: anime has music and effects under the voices
MAX_SAMPLE_S = 180
COARSE_MS = 100
FINE_RADIUS_MS = 300
PLATEAU_TOLERANCE = 0.01  # fine scores this close to the top count as the same peak
PEAK_EXCLUSION_MS = 1500  # offsets this close to the best belong to the same peak
ENERGY_TREND_FRAMES = 100  # loudness is compared with the mean over ±1 s
MIN_SPEECH_MS = 4000
MIN_LINES = 3
# Confidence = how many standard deviations the best offset's score stands above the scores of
# the other offsets; runner_up = the same for the best offset ≥ 1.5 s away. Synthetic tests
# (45-60 s samples, music, bursty singing): true matches 4.2-11 with a gap ≥ 1.4 over the
# runner-up; random signals ≤ 4.4 with gaps mostly < 1.2. Revisit with real episodes.
MIN_CONFIDENCE = 4.5
MIN_GAP = 1.0
MIN_COVERAGE = 0.2  # candidate offsets must put lines over ≥ 20 % of the sample
MIN_OTHERS = 20  # off-peak offsets needed for a meaningful baseline
BASELINE_MS = 60_000


class SyncError(Exception):
    pass


@dataclass
class SyncResult:
    offset_ms: int
    confident: bool
    confidence: float  # peak height in standard deviations above all other offsets
    runner_up: float  # the same for the best offset ≥ PEAK_EXCLUSION_MS away
    correlation: float  # Pearson correlation at the best offset (100 ms bins)
    speech_ms: int
    sample_ms: int
    lines_in_window: int
    detail: str


def decode_pcm(path: Path) -> bytes:
    """16 kHz mono s16le PCM of the first MAX_SAMPLE_S seconds of any audio/video file."""
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1",
           "-ar", str(SAMPLE_RATE), "-t", str(MAX_SAMPLE_S), "-f", "s16le", "pipe:1"]  # fmt: skip
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired as e:
        raise SyncError("decoding the audio sample timed out") from e
    if r.returncode != 0 or not r.stdout:
        raise SyncError(
            f"can't decode the audio sample: {r.stderr.decode(errors='replace')[-200:]}"
        )
    return r.stdout


def speech_frames(pcm: bytes, mode: int = VAD_MODE) -> list[bool]:
    """Voice activity per 10 ms frame."""
    import webrtcvad

    vad = webrtcvad.Vad(mode)
    step = SAMPLE_RATE * VAD_FRAME_MS // 1000 * 2  # bytes per frame (16-bit)
    return [
        vad.is_speech(pcm[i : i + step], SAMPLE_RATE) for i in range(0, len(pcm) - step + 1, step)
    ]


def loudness(pcm: bytes) -> list[float]:
    """Per 10 ms frame: log energy minus its mean over the surrounding ±1 s (speech pops out of
    steady music; the absolute volume of the sample doesn't matter)."""
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) // 2 * 2])
    if sys.byteorder == "big":
        samples.byteswap()
    step = SAMPLE_RATE * VAD_FRAME_MS // 1000
    db = [
        10 * math.log10(sum(x * x for x in samples[i : i + step]) / step + 1)
        for i in range(0, len(samples) - step + 1, step)
    ]
    pre = [0.0]
    for x in db:
        pre.append(pre[-1] + x)
    w, n = ENERGY_TREND_FRAMES, len(db)
    return [x - (pre[min(n, i + w)] - pre[max(0, i - w)]) / (min(n, i + w) - max(0, i - w))
            for i, x in enumerate(db)]  # fmt: skip


def _z(xs: list[float]) -> list[float]:
    if not xs:
        return []
    m = statistics.fmean(xs)
    sd = statistics.pstdev(xs) or 1.0
    return [(x - m) / sd for x in xs]


def features(pcm: bytes) -> tuple[list[float], int]:
    """("someone is talking" signal per 10 ms frame, speech ms according to the VAD)."""
    vad = speech_frames(pcm)
    loud = loudness(pcm)
    n = min(len(vad), len(loud))
    v = _z([1.0 if x else 0.0 for x in vad[:n]])
    e = _z(loud[:n])
    return [v[i] + e[i] for i in range(n)], sum(vad) * VAD_FRAME_MS


def _bin(frames: list[float], factor: int) -> list[float]:
    """Average consecutive groups of `factor` values."""
    return [
        sum(frames[i : i + factor]) / factor for i in range(0, len(frames) - factor + 1, factor)
    ]


def _coverage(lines: list[tuple[int, int]], start_ms: int, n: int, step_ms: int) -> list[float]:
    """Fraction of each step_ms bin in [start_ms, start_ms + n·step) covered by a line."""
    cov = [0.0] * n
    end_ms = start_ms + n * step_ms
    for s, e in lines:
        s, e = max(s, start_ms), min(e, end_ms)
        if s >= e:
            continue
        i = (s - start_ms) // step_ms
        while i < n:
            b0 = start_ms + i * step_ms
            b1 = b0 + step_ms
            if b0 >= e:
                break
            cov[i] = min(1.0, cov[i] + (min(b1, e) - max(b0, s)) / step_ms)
            i += 1
    return cov


def _pearson(a: list[float], c: list[float], off: int) -> float:
    """Correlation of a[t] with c[t + off] over len(a)."""
    n = len(a)
    seg = c[off : off + n]
    sa, sc = sum(a), sum(seg)
    sac = sum(x * y for x, y in zip(a, seg, strict=True))
    saa, scc = sum(x * x for x in a), sum(y * y for y in seg)
    cov = sac - sa * sc / n
    var = (saa - sa * sa / n) * (scc - sc * sc / n)
    return cov / math.sqrt(var) if var > 1e-12 else 0.0


def _search(speech: list[float], lines: list[tuple[int, int]], video_start_ms: int,
            lo_ms: int, hi_ms: int, step_ms: int) -> list[tuple[int, float, int]]:  # fmt: skip
    """[(offset_ms, score, ms of the sample covered by lines)] for offsets lo..hi; speech is
    binned at step_ms.

    A line is shown at video time t when start_ms + offset <= t < end_ms + offset, so the
    speech at video time V + k·step lines up with subtitle time V + k·step - offset.
    """
    n = len(speech)
    k_lo, k_hi = lo_ms // step_ms, hi_ms // step_ms
    base = video_start_ms - k_hi * step_ms  # subtitle time of c[0]
    cov = _coverage(lines, base, n + (k_hi - k_lo), step_ms)
    # offset = k·step ↔ c index (k_hi - k)
    return [
        (
            k * step_ms,
            _pearson(speech, cov, k_hi - k),
            int(sum(cov[k_hi - k : k_hi - k + n]) * step_ms),
        )
        for k in range(k_lo, k_hi + 1)
    ]


def find_offset(
    signal: list[float],
    lines: list[tuple[int, int]],
    video_start_ms: int,
    search_ms: int = 120_000,
    around_ms: int = 0,
    speech_ms: int | None = None,
) -> SyncResult:
    """Best `sub_offset_ms` for a sample recorded from video time `video_start_ms`.

    `signal` has one "someone is talking" value per 10 ms frame (booleans work). Searches offsets
    in around_ms ± search_ms (around_ms = the current offset).
    """
    sample_ms = len(signal) * VAD_FRAME_MS
    if speech_ms is None:
        speech_ms = sum(1 for x in signal if x > 0) * VAD_FRAME_MS

    def snap(ms: int) -> int:
        return ms - ms % COARSE_MS

    def near(a: int, b: int) -> list[tuple[int, int]]:
        return [
            (s, e)
            for s, e in lines
            if e + b > video_start_ms and s + a < video_start_ms + sample_ms
        ]

    lo, hi = snap(around_ms - search_ms), snap(around_ms + search_ms)
    # The baseline ("how well do wrong offsets score?") always spans ≥ ±BASELINE_MS: nearby
    # offsets share the dialogue's rhythm, so a narrow search alone can't tell a real peak.
    wide = max(search_ms, BASELINE_MS)
    blo, bhi = snap(around_ms - wide), snap(around_ms + wide)
    window = near(lo, hi)
    fail = SyncResult(around_ms, False, 0.0, 0.0, 0.0, speech_ms, sample_ms, len(window), "")
    if speech_ms < MIN_SPEECH_MS:
        fail.detail = f"only {speech_ms / 1000:.1f} s of speech in the sample (need {MIN_SPEECH_MS // 1000} s)"
        return fail
    if len(window) < MIN_LINES:
        fail.detail = "too few subtitle lines near this part of the episode"
        return fail

    f = [float(x) for x in signal]
    coarse = _search(
        _bin(f, COARSE_MS // VAD_FRAME_MS), near(blo, bhi), video_start_ms, blo, bhi, COARSE_MS
    )
    # Only offsets that put enough subtitle lines over the sample are candidates (and baseline):
    # offsets landing in the OP/ED or past the episode's ends score 0 and would fake a sharp
    # peak, and one line meeting one burst of singing can correlate well by chance.
    min_cov = max(MIN_SPEECH_MS, int(sample_ms * MIN_COVERAGE))
    coarse = [r for r in coarse if r[2] >= min_cov]
    candidates = [r for r in coarse if lo <= r[0] <= hi]
    if not candidates:
        fail.detail = "too few subtitle lines near this part of the episode"
        return fail
    best_c, corr, _ = max(candidates, key=lambda r: (r[1], -abs(r[0] - around_ms)))
    others = [sc for o, sc, _ in coarse if abs(o - best_c) >= PEAK_EXCLUSION_MS]
    spread = statistics.pstdev(others) if len(others) >= MIN_OTHERS else 0.0
    mean = statistics.fmean(others) if others else 0.0
    confidence = (corr - mean) / spread if spread > 1e-9 else 0.0
    runner_up = (max(others) - mean) / spread if spread > 1e-9 else 0.0
    fine = _search(
        f, window, video_start_ms, best_c - FINE_RADIUS_MS, best_c + FINE_RADIUS_MS, VAD_FRAME_MS
    )
    # Speech edges are fuzzy, so the peak is a plateau: take its middle, not one noisy edge.
    top = max(sc for _, sc, _ in fine)
    plateau = [o for o, sc, _ in fine if sc >= top - PLATEAU_TOLERANCE]
    best = round((min(plateau) + max(plateau)) / 2 / VAD_FRAME_MS) * VAD_FRAME_MS
    confident = confidence >= MIN_CONFIDENCE and confidence - runner_up >= MIN_GAP and corr > 0
    detail = "ok" if confident else "no clear match: try a part of the episode with more talking"
    return SyncResult(
        best, confident, round(confidence, 2), round(runner_up, 2), round(corr, 3),
        speech_ms, sample_ms, len(window), detail,
    )  # fmt: skip


def refine_offset(
    signal: list[float],
    lines: list[tuple[int, int]],
    video_start_ms: int,
    around_ms: int,
    radius_ms: int = 500,
) -> tuple[int, float]:
    """(offset, correlation) of the best 10 ms alignment of speech with lines within
    around_ms ± radius_ms: the fine step of find_offset, for an offset already known roughly
    (e.g. from recognized speech, #147)."""
    sample_ms = len(signal) * VAD_FRAME_MS
    lo, hi = around_ms - radius_ms, around_ms + radius_ms
    window = [
        (s, e) for s, e in lines if e + hi > video_start_ms and s + lo < video_start_ms + sample_ms
    ]
    if not window or not signal:
        return around_ms, 0.0
    fine = _search([float(x) for x in signal], window, video_start_ms, lo, hi, VAD_FRAME_MS)
    top = max(sc for _, sc, _ in fine)
    if top <= 0:
        return around_ms, top
    plateau = [o for o, sc, _ in fine if sc >= top - PLATEAU_TOLERANCE]
    best = round((min(plateau) + max(plateau)) / 2 / VAD_FRAME_MS) * VAD_FRAME_MS
    return best, round(top, 3)


def sync_file(path: Path, lines: list[tuple[int, int]], video_start_ms: int, search_ms: int,
              around_ms: int) -> SyncResult:  # fmt: skip
    signal, speech_ms = features(decode_pcm(path))
    return find_offset(signal, lines, video_start_ms, search_ms, around_ms, speech_ms)


# ---- sync points (#137): one offset per stretch of the episode ------------------------------

CUT_MS = 1500  # a new offset this far from the current one means a cut/eyecatch, not drift
MERGE_POINT_MS = 20_000  # a new point this close to an existing one replaces it


def normalize_points(points: list[dict]) -> list[dict]:
    """Sorted by at_ms, one per at_ms, at_ms > 0, ints."""
    by_at = {int(p["at_ms"]): int(p["offset_ms"]) for p in points if int(p["at_ms"]) > 0}
    return [{"at_ms": a, "offset_ms": by_at[a]} for a in sorted(by_at)]


def offset_at(video_ms: int, base_ms: int, points: list[dict]) -> int:
    """sub_offset_ms in effect at a video time."""
    offset = base_ms
    for p in points:
        if p["at_ms"] > video_ms:
            break
        offset = p["offset_ms"]
    return offset


def video_to_sub_ms(video_ms: int, base_ms: int, points: list[dict]) -> int:
    """Subtitle time shown at a video time: the line is on screen while
    start_ms <= video_ms - offset < end_ms."""
    return video_ms - offset_at(video_ms, base_ms, points)


def apply_sync(
    base_ms: int, points: list[dict], at_ms: int, new_ms: int, first: bool
) -> tuple[int, list[dict], str]:
    """Fold a confident sync result measured at video time `at_ms` into (base, points).

    Returns (base, points, action): "base" = first sync of the episode sets the global offset;
    "refined" = close to the offset in effect there (drift, ≤ CUT_MS) → that stretch is
    corrected; "point" = more than CUT_MS off → a cut: a new point from `at_ms` on.
    """
    points = normalize_points(points)
    if first and not points:
        return new_ms, [], "base"
    current = offset_at(at_ms, base_ms, points)
    owner = next((p for p in reversed(points) if p["at_ms"] <= at_ms), None)
    if abs(new_ms - current) <= CUT_MS:
        if owner is None:
            return new_ms, points, "refined"
        owner["offset_ms"] = new_ms
        return base_ms, points, "refined"
    near = next((p for p in points if abs(p["at_ms"] - at_ms) <= MERGE_POINT_MS), None)
    if near is not None:
        near["at_ms"], near["offset_ms"] = min(near["at_ms"], at_ms), new_ms
    else:
        points.append({"at_ms": max(1, at_ms), "offset_ms": new_ms})
    return base_ms, normalize_points(points), "point"
