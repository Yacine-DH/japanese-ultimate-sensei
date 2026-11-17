from app.subtitles import decode, parse, parse_bytes

from .conftest import FIXTURES


def test_parse_ass_cleans_and_filters():
    lines = parse((FIXTURES / "sample.ass").read_text(encoding="utf-8"))
    texts = [line.text for line in lines]
    # duplicate layer removed, comment + drawing + non-Japanese line dropped, tags stripped, \N joined
    assert texts == ["俺は海賊王になる男だ！", "お腹すいた… 何か食べたい"]
    assert (lines[0].start_ms, lines[0].end_ms) == (1000, 3500)


def test_parse_srt():
    lines = parse_bytes((FIXTURES / "sample.srt").read_bytes())
    assert [line.text for line in lines] == ["行くぞ！", "ありがとう"]


def test_decode_shift_jis():
    raw = "1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n".encode("cp932")
    assert "こんにちは" in decode(raw)
    assert parse_bytes(raw)[0].text == "こんにちは"
