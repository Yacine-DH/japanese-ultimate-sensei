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


def test_strips_speaker_labels_and_sound_cues():
    from app.subtitles import strip_annotations

    assert (
        strip_annotations("（ハイター）私たち 勇者一行の凱旋です。")
        == "私たち 勇者一行の凱旋です。"
    )
    assert strip_annotations("(ヒンメル)帰ったら仕事探さないとな") == "帰ったら仕事探さないとな"
    assert strip_annotations("［拍手］ありがとう") == "ありがとう"
    assert strip_annotations("（どうしよう…）") == "（どうしよう…）"  # whole-line thought kept
    assert strip_annotations("（拍手）") == ""  # whole-line sound cue (#90)
    assert (
        strip_annotations("（あの人は、まだ来ない）そうだね") == "（あの人は、まだ来ない）そうだね"
    )
    srt = "1\n00:00:01,000 --> 00:00:02,000\n（フリーレン）\n行こう\n"
    assert [line.text for line in parse(srt)] == ["行こう"]


def test_real_tv_and_sdh_cleanup():
    """Frieren ep 2 (AT-X TV srt + Netflix [cc]) artefacts (#90)."""
    from app.subtitles import parse, strip_annotations

    assert strip_annotations("え～とね 長距離魔法は➡") == "え～とね 長距離魔法は"
    assert strip_annotations("そうだね…｠") == "そうだね…"
    for cue in (
        "（足音）",
        "（鐘の音）",
        "（ドアの開閉音）",
        "（人々の逃げ惑う声）",
        "（寝息）",
        "（ノック）",
    ):
        assert strip_annotations(cue) == ""
    assert strip_annotations("（何だ この声）") == "（何だ この声）"  # a thought, not a cue
    for cue in ("［拍手］", "［足音］", "〔笑い声〕"):  # review of #95
        assert strip_annotations(cue) == ""
    assert strip_annotations("いや 蒼月草(そうげつそう)の花がいいか") == "いや 蒼月草の花がいいか"
    assert strip_annotations("（ヒンメル）帰ったら") == "帰ったら"
    srt = (
        "1\n00:00:01,000 --> 00:00:02,000\n（足音）\n\n"
        "2\n00:00:03,000 --> 00:00:04,000\n（足音）\nフリーレン様➡\n"
    )
    assert [line.text for line in parse(srt)] == ["フリーレン様"]
