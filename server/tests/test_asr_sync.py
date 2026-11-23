import random

import pytest

from app.asr_sync import (
    MIN_ANCHORS,
    Segment,
    asr_offset,
    find_anchors,
    speech_chunks,
    to_kana,
)

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
