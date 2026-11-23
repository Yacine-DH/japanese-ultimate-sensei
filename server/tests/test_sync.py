import random
import time

import pytest

from app.media import ffmpeg_available
from app.sync import VAD_FRAME_MS, find_offset


def episode_lines(seed=1, n=400):
    rnd = random.Random(seed)
    t, out = 5000, []
    for _ in range(n):
        t += rnd.randint(300, 4000)  # pause
        d = rnd.randint(700, 4500)  # line duration
        out.append((t, t + d))
        t += d
    return out


def fake_speech(lines, offset, start, seconds, noise=0.15, seed=2):
    """VAD-like frames: speech while a line (shifted by offset) is spoken, with word gaps,
    late/early VAD edges and random false positives (music)."""
    rnd = random.Random(seed)
    frames = []
    for k in range(seconds * 1000 // VAD_FRAME_MS):
        t = start + k * VAD_FRAME_MS
        on = any(s + offset + 150 <= t < e + offset - 100 for s, e in lines)
        if on and rnd.random() < 0.2:
            on = False  # pauses between words
        if rnd.random() < noise:
            on = not on
        frames.append(on)
    return frames


@pytest.mark.parametrize("true_offset", [0, 2370, -8450, 61_230])
def test_finds_offset(true_offset):
    lines = episode_lines()
    frames = fake_speech(lines, true_offset, start=300_000, seconds=60)
    t = time.monotonic()
    r = find_offset(frames, lines, video_start_ms=300_000, search_ms=90_000)
    assert time.monotonic() - t < 5
    # VAD edges are fuzzy (here 150 ms late, 100 ms early): any offset in that band fits
    assert abs(r.offset_ms - true_offset) <= 150, r
    assert r.confident and r.detail == "ok" and r.lines_in_window > 10


def test_search_is_around_current_offset():
    lines = episode_lines()
    frames = fake_speech(lines, 150_000, start=400_000, seconds=45)
    r = find_offset(frames, lines, 400_000, search_ms=30_000, around_ms=140_000)
    assert abs(r.offset_ms - 150_000) <= 150 and r.confident


def test_not_confident_without_speech_or_lines():
    lines = episode_lines()
    silent = [False] * 6000
    r = find_offset(silent, lines, 300_000)
    assert not r.confident and "speech" in r.detail and r.offset_ms == 0
    r = find_offset(fake_speech(lines, 0, 300_000, 60), [], 300_000, around_ms=500)
    assert not r.confident and r.offset_ms == 500 and "lines" in r.detail


def test_random_noise_is_not_confident():
    rnd = random.Random(5)
    frames = [rnd.random() < 0.5 for _ in range(6000)]
    r = find_offset(frames, episode_lines(), 300_000)
    assert not r.confident


def _bursty(seed, n=4500):
    """On/off runs of 0.3-3 s: singing or effects, nothing to do with the subtitles."""
    rnd, f, on = random.Random(seed), [], False
    while len(f) < n:
        f += [on] * rnd.randint(30, 300)
        on = not on
    return f[:n]


def test_no_false_sync_during_op_or_ed():
    """Offsets that land before the first / after the last line must not fake a sharp peak
    (Antigravity's review of #100: 27/80 false positives before the fix)."""
    lines = [(s + 90_000, e + 90_000) for s, e in episode_lines(seed=3)]  # 90 s OP, no subs
    after_ed = lines[-1][1] + 20_000
    for seed in range(15):
        f = _bursty(seed)
        assert not find_offset(f, lines, 0).confident
        assert not find_offset(f, lines, after_ed).confident


def test_small_search_range_still_has_a_baseline():
    lines = episode_lines()
    r = find_offset(
        fake_speech(lines, 200, 400_000, 45, noise=0.0), lines, 400_000, search_ms=10_000
    )
    assert r.confident and abs(r.offset_ms - 200) <= 150
    assert not any(
        find_offset(_bursty(s), lines, 400_000, search_ms=10_000).confident for s in range(10)
    )


# ---- endpoint, with real audio through ffmpeg + webrtcvad ---------------------------------


def _srt(lines):
    def ts(ms):
        return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"

    return "\n".join(
        f"{i + 1}\n{ts(s)} --> {ts(e)}\n台詞その{i}です\n" for i, (s, e) in enumerate(lines)
    )


def _voice_wav(lines, offset, start_ms, seconds):
    """WAV where a voice-like harmonic tone plays whenever a (shifted) line is on screen."""
    import io
    import math
    import struct
    import wave

    rate, buf = 16000, bytearray()
    shifted = [(s + offset, e + offset) for s, e in lines]
    for k in range(seconds * rate):
        t_ms = start_ms + k * 1000 // rate
        on = any(s <= t_ms < e for s, e in shifted if s - 5000 < t_ms < e + 5000)
        x = 0.0
        if on:
            t = k / rate
            x = 0.25 * (math.sin(2 * math.pi * 140 * t) + 0.6 * math.sin(2 * math.pi * 420 * t)
                        + 0.3 * math.sin(2 * math.pi * 1100 * t)) * (0.6 + 0.4 * math.sin(8 * math.pi * t))  # fmt: skip
        buf += struct.pack("<h", int(x * 20000))
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate)
        w.writeframes(bytes(buf))
    return out.getvalue()


@pytest.mark.skipif(not ffmpeg_available(), reason="ffmpeg not installed")
def test_sync_endpoint(client):
    lines = [(s, e) for s, e in episode_lines(seed=7, n=60) if s > 20_000][:30]
    ep = client.post(
        "/episodes",
        data={"anime_title": "Sync Anime", "episode_number": "1"},
        files={"subtitle": ("ep.srt", _srt(lines).encode(), "text/plain")},
    ).json()
    start = lines[3][0] - 1000
    wav = _voice_wav(lines, 3200, start, 30)

    r = client.post(f"/episodes/{ep['id']}/sync", data={"video_start_ms": start, "apply": "false"},
                    files={"file": ("s.wav", wav)})  # fmt: skip
    body = r.json()
    assert r.status_code == 200, body
    assert abs(body["offset_ms"] - 3200) <= 100 and body["confident"] and not body["applied"]
    assert client.get(f"/episodes/{ep['id']}").json()["sub_offset_ms"] == 0

    r = client.post(f"/episodes/{ep['id']}/sync", data={"video_start_ms": start},
                    files={"file": ("s.wav", wav)})  # fmt: skip
    assert r.json()["applied"] and r.json()["previous_offset_ms"] == 0
    assert client.get(f"/episodes/{ep['id']}").json()["sub_offset_ms"] == r.json()["offset_ms"]

    bad = client.post(f"/episodes/{ep['id']}/sync", data={"video_start_ms": 0},
                      files={"file": ("x.wav", b"not audio")})  # fmt: skip
    assert bad.status_code == 422
    small = client.post(f"/episodes/{ep['id']}/sync", data={"video_start_ms": 0, "search_ms": 1000},
                        files={"file": ("s.wav", wav)})  # fmt: skip
    assert small.status_code == 422
    assert client.post("/episodes/999/sync", data={"video_start_ms": 0},
                       files={"file": ("s.wav", wav)}).status_code == 404  # fmt: skip


def test_sync_points_helpers():
    """#137: one offset per stretch of the episode."""
    from app.sync import apply_sync, normalize_points, offset_at, video_to_sub_ms

    pts = normalize_points([{"at_ms": 600_000, "offset_ms": 4000}, {"at_ms": 0, "offset_ms": 9},
                            {"at_ms": 300_000, "offset_ms": 2500}])  # fmt: skip
    assert pts == [{"at_ms": 300_000, "offset_ms": 2500}, {"at_ms": 600_000, "offset_ms": 4000}]
    assert [offset_at(v, 1000, pts) for v in (0, 299_999, 300_000, 650_000)] == [
        1000,
        1000,
        2500,
        4000,
    ]
    assert video_to_sub_ms(310_000, 1000, pts) == 307_500

    assert apply_sync(0, [], 200_000, 3200, first=True) == (3200, [], "base")
    # drift ≤ 1.5 s: correct the stretch the sample is in
    assert apply_sync(3200, [], 500_000, 3900, first=False) == (3900, [], "refined")
    assert apply_sync(1000, pts, 400_000, 2000, first=False)[1][0]["offset_ms"] == 2000
    # > 1.5 s: a cut → a new point from the sample start, the earlier stretch keeps its offset
    base, new, action = apply_sync(3200, [], 700_000, 9200, first=False)
    assert (base, new, action) == (3200, [{"at_ms": 700_000, "offset_ms": 9200}], "point")
    # a second cut result close to that point moves it instead of adding another
    _, new, _ = apply_sync(3200, new, 690_000, 12_000, first=False)
    assert new == [{"at_ms": 690_000, "offset_ms": 12_000}]


@pytest.mark.skipif(not ffmpeg_available(), reason="ffmpeg not installed")
def test_sync_endpoint_inserts_a_point_after_a_cut(client):
    lines = [(s, e) for s, e in episode_lines(seed=7, n=90) if s > 20_000]
    ep = client.post(
        "/episodes",
        data={"anime_title": "Cut Anime", "episode_number": "1"},
        files={"subtitle": ("ep.srt", _srt(lines).encode(), "text/plain")},
    ).json()
    early = lines[3][0] - 1000
    r = client.post(f"/episodes/{ep['id']}/sync", data={"video_start_ms": early},
                    files={"file": ("a.wav", _voice_wav(lines, 3200, early, 30))}).json()  # fmt: skip
    assert r["action"] == "base" and abs(r["sub_offset_ms"] - 3200) <= 100, r

    late = lines[60][0] + 9200 - 1000  # video time; the stream has 6 s more before this part
    r = client.post(f"/episodes/{ep['id']}/sync", data={"video_start_ms": late},
                    files={"file": ("b.wav", _voice_wav(lines, 9200, late, 30))}).json()  # fmt: skip
    assert r["action"] == "point" and abs(r["previous_offset_ms"] - 3200) <= 100, r
    (point,) = r["sync_points"]
    assert point["at_ms"] == late and abs(point["offset_ms"] - 9200) <= 100
    got = client.get(f"/episodes/{ep['id']}").json()
    assert got["sync_points"] == r["sync_points"] and got["synced_at"]

    patched = client.patch(f"/episodes/{ep['id']}", json={"sync_points": []}).json()
    assert patched["sync_points"] == [] and abs(patched["sub_offset_ms"] - 3200) <= 100
    assert (
        client.patch(
            f"/episodes/{ep['id']}", json={"sync_points": [{"at_ms": 0, "offset_ms": 1}]}
        ).status_code
        == 422
    )
