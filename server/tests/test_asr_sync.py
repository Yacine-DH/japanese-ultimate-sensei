import os
import random
from pathlib import Path

import pytest

from app.asr_sync import (
    MIN_ANCHORS,
    Segment,
    asr_offset,
    find_anchors,
    speech_chunks,
    to_kana,
)

_ASR_MODEL = os.environ.get(
    "SENSEI_TEST_ASR_MODEL", ""
)  # read at import, before conftest clears it

# Made-up dialogue (any content works; lines need ≥ 5 kana to anchor).
TEXTS = [
    "まさか森の中で迷子になるとは思わなかった",
    "言っておくけど地図なんて持ってないからね",
    "それなら空から探せばいいじゃないか",
    "魔法の練習をもっとしておけばよかった",
    "ちょっと待って誰かからメッセージが来た",
    "どうせ大した用事じゃないんだろうけど",
    "気をつけて後ろから誰かがついてきてる",
    "近づいてくる反応が十二もあります",
    "モンスターじゃなくてプレイヤーなのか",
    "とにかく急いで洞窟の外に出よう",
    "この先に湖があるはずだから急ごう",
    "橋の上で待ち伏せされたら逃げられない",
    "私が後ろから回復の魔法をかけるから",
    "前に出て戦うのは俺に任せてくれ",
    "相手は火の魔法を使う連中ばかりだ",
    "盾を持った前衛が三人並んでいるぞ",
    "一人ずつ倒していくしかなさそうだな",
    "回復が追いつかないもう無理だよ",
    "諦めるのはまだ早いもう少しだけ頑張れ",
    "変身の魔法なんて初めて見たよ",
    "あれは幻を見せるだけの魔法のはずなのに",
    "どうしてこんなに強くなれるんだろう",
    "教えてほしいことがたくさんあるんだ",
    "まずは街に着いてから考えましょう",
]


def episode(seed=3, start=60_000):
    rnd = random.Random(seed)
    t, out = start, []
    for text in TEXTS:
        t += rnd.randint(400, 2500)
        d = 220 * len(text) // 2 + rnd.randint(-300, 300)
        out.append((t, t + d, text))
        t += d
    return out


def garble(text: str, rnd: random.Random, rate: float) -> str:
    """ASR-like errors: drop or swap a few characters."""
    out = []
    for ch in text:
        r = rnd.random()
        if r < rate / 2:
            continue
        out.append("あ" if r < rate else ch)
    return "".join(out)


def recognized(lines, offset, video_start, sample_ms, seed=5, rate=0.15, late_ms=0):
    """Segments the recognizer would return for a sample recorded from video_start: one per
    line heard (two lines merged into one chunk now and then), plus a noise chunk."""
    rnd = random.Random(seed)
    segs: list[Segment] = []
    heard = [
        (s + offset - video_start, e + offset - video_start, t)
        for s, e, t in lines
        if 0 <= s + offset - video_start and e + offset - video_start <= sample_ms
    ]
    i = 0
    while i < len(heard):
        s, e, t = heard[i]
        if i + 1 < len(heard) and rnd.random() < 0.3:  # VAD merged two lines
            e, t = heard[i + 1][1], t + heard[i + 1][2]
            i += 1
        segs.append(Segment(s + late_ms, e, garble(t, rnd, rate)))
        i += 1
    segs.append(Segment(1000, 2500, "ドーン"))  # an effect the model "heard"
    return segs


def test_to_kana_reads_kanji_and_drops_punctuation():
    assert to_kana("勉強、しよう！")[0] == to_kana("べんきょうしよう")[0]
    assert to_kana("カード")[0] == "かど"  # katakana → hiragana, ー dropped
    kana, times = to_kana("勉強", [100, 300])
    assert kana == "べんきょう" and times == [100] * 5


def test_speech_chunks_bridge_short_gaps_and_split_long():
    vad = [False] * 50 + [True] * 100 + [False] * 20 + [True] * 100 + [False] * 100
    assert speech_chunks(vad) == [(500, 2700)]  # the 200 ms gap is bridged
    assert speech_chunks([True] * 3000) == [(0, 12_000), (12_000, 24_000), (24_000, 30_000)]
    assert speech_chunks([True] * 20) == []  # 200 ms: too short


@pytest.mark.parametrize("true_offset", [0, 14_200, -8_450, 95_000])
def test_finds_offset_from_recognized_lines(true_offset):
    lines = episode()
    video_start = lines[6][0] + true_offset - 500
    segs = recognized(lines, true_offset, video_start, 45_000)
    lo, hi = -120_000, 120_000
    anchors = find_anchors(lines, segs, video_start, lo, hi)
    r = asr_offset(anchors)
    assert r.confident, r
    assert abs(r.offset_ms - true_offset) <= 300, r
    assert r.agreeing >= MIN_ANCHORS


def test_late_chunk_start_steps_back_at_speaking_rate():
    lines = episode()
    video_start = lines[4][0] - 300
    segs = recognized(lines, 0, video_start, 45_000, rate=0.0, late_ms=400)
    r = asr_offset(find_anchors(lines, segs, video_start, -60_000, 60_000))
    assert r.confident and abs(r.offset_ms - 400) <= 300  # the late VAD edge, not more


def test_unrelated_speech_gives_no_confident_offset():
    lines = episode()
    segs = [
        Segment(0, 3000, "今日はいい天気ですね"),
        Segment(4000, 7000, "晩ご飯は何にしようか"),
        Segment(8000, 11_000, "宿題は終わったの"),
    ]
    r = asr_offset(find_anchors(lines, segs, lines[5][0], -120_000, 120_000))
    assert not r.confident and r.agreeing < MIN_ANCHORS


def test_repeated_lines_are_not_anchors():
    lines = [(1000, 3000, "ちょっと待ってください"), (40_000, 42_000, "ちょっと待ってください")]
    segs = [Segment(500, 2500, "ちょっと待ってください")]
    assert find_anchors(lines, segs, 10_000, -60_000, 60_000) == []


def test_offsets_outside_the_search_window_are_ignored():
    lines = episode()
    video_start = lines[6][0] + 95_000 - 500
    segs = recognized(lines, 95_000, video_start, 45_000)
    assert find_anchors(lines, segs, video_start, -30_000, 30_000) == []


# ---- endpoint: the ASR path is used when a recognizer is loaded ---------------------------


def _srt_with_text(lines):
    def ts(ms):
        return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"

    return "\n".join(f"{i + 1}\n{ts(s)} --> {ts(e)}\n{t}\n" for i, (s, e, t) in enumerate(lines))


def _post_episode(client, lines):
    return client.post(
        "/episodes",
        data={"anime_title": "ASR Anime", "episode_number": "1"},
        files={"subtitle": ("ep.srt", _srt_with_text(lines).encode(), "text/plain")},
    ).json()


def test_sync_endpoint_uses_recognized_speech(client, monkeypatch):
    from app import asr_sync
    from tests.test_sync import _voice_wav

    lines = episode()
    ep = _post_episode(client, lines)
    true_offset = 14_200
    start = lines[6][0] + true_offset - 500
    wav = _voice_wav([(s, e) for s, e, _ in lines], true_offset, start, 45)
    # The recognizer "hears" the lines that are on screen during the sample.
    client.app.state.asr = lambda pcm: ("", None)
    monkeypatch.setattr(
        asr_sync,
        "recognize_chunks",
        lambda pcm, vad, rec: recognized(lines, true_offset, start, 45_000),
    )
    body = client.post(
        f"/episodes/{ep['id']}/sync", data={"video_start_ms": start}, files={"file": ("s.wav", wav)}
    ).json()
    assert body["method"] == "asr" and body["anchors"] >= MIN_ANCHORS, body
    assert body["confident"] and body["applied"] and body["action"] == "base"
    assert abs(body["offset_ms"] - true_offset) <= 150, body  # refined on voice activity


def test_sync_endpoint_falls_back_to_voice_activity(client, monkeypatch):
    from app import asr_sync
    from tests.test_sync import _voice_wav

    lines = episode()
    ep = _post_episode(client, lines)
    start = lines[6][0] + 3200 - 500
    wav = _voice_wav([(s, e) for s, e, _ in lines], 3200, start, 45)

    def broken(pcm, vad, rec):
        raise RuntimeError("model crashed")

    client.app.state.asr = lambda pcm: ("", None)
    monkeypatch.setattr(asr_sync, "recognize_chunks", broken)
    body = client.post(
        f"/episodes/{ep['id']}/sync",
        data={"video_start_ms": start, "apply": "false"},
        files={"file": ("s.wav", wav)},
    ).json()
    assert body["method"] == "vad" and body["anchors"] == 0, body
    assert abs(body["offset_ms"] - 3200) <= 150

    monkeypatch.setattr(asr_sync, "recognize_chunks", lambda pcm, vad, rec: [])  # heard nothing
    body = client.post(
        f"/episodes/{ep['id']}/sync",
        data={"video_start_ms": start, "apply": "false"},
        files={"file": ("s.wav", wav)},
    ).json()
    assert body["method"] == "vad" and abs(body["offset_ms"] - 3200) <= 150, body


def test_no_model_means_no_recognizer(tmp_path):
    from app.asr_sync import load_recognizer

    assert load_recognizer(tmp_path / "missing") is None


def test_asr_setup_keeps_only_the_int8_model(tmp_path, monkeypatch):
    import contextlib
    import io
    import tarfile

    from app import asr_setup
    from app.asr_sync import MODEL_NAME

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tar:
        for name in ("encoder-epoch-99-avg-1.int8.onnx", "encoder-epoch-99-avg-1.onnx",
                     "decoder-epoch-99-avg-1.onnx", "joiner-epoch-99-avg-1.int8.onnx",
                     "tokens.txt", "README.md", "../evil.int8.onnx"):  # fmt: skip
            data = name.encode()
            info = tarfile.TarInfo(name if name.startswith("..") else f"{MODEL_NAME}/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))

    class Resp:
        def raise_for_status(self):
            return self

        def iter_bytes(self, _n):
            yield buf.getvalue()

    monkeypatch.setattr(asr_setup.httpx, "stream", lambda *a, **k: contextlib.nullcontext(Resp()))
    dest = asr_setup.install(tmp_path / "models")
    assert dest == tmp_path / "models" / MODEL_NAME
    assert sorted(f.name for f in dest.iterdir()) == [
        "decoder-epoch-99-avg-1.onnx",  # no int8 decoder in the archive: the fp32 one is kept
        "encoder-epoch-99-avg-1.int8.onnx",
        "joiner-epoch-99-avg-1.int8.onnx",
        "tokens.txt",
    ]
    assert not (tmp_path / "evil.int8.onnx").exists()
    assert [p.name for p in (tmp_path / "models").iterdir()] == [MODEL_NAME]  # temp dir gone
    assert asr_setup.install(tmp_path / "models") == dest  # second run: nothing to do


def test_real_model_recognizes_japanese():
    """Runs only with SENSEI_TEST_ASR_MODEL=<model dir> (from `python -m app.asr_setup`, plus
    the archive's test_wavs/): the conftest clears SENSEI_* so read it before that."""
    import wave

    model = _ASR_MODEL
    if not model or not (Path(model) / "test_wavs" / "3.wav").exists():
        pytest.skip("set SENSEI_TEST_ASR_MODEL to a model folder with test_wavs/")
    from app.asr_sync import load_recognizer

    rec = load_recognizer(Path(model))
    assert rec is not None
    with wave.open(str(Path(model) / "test_wavs" / "3.wav")) as w:
        pcm = w.readframes(w.getnframes())
    text, char_ms = rec(pcm)
    assert to_kana(text)[0] == to_kana("ヤンバルクイナとの出会いは十八歳の時だった")[0]
    assert char_ms is not None and len(char_ms) == len(text) and char_ms == sorted(char_ms)
