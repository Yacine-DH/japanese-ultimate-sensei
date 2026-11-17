import pytest

from app.nlp.kana import furigana, has_japanese, kata_to_hira, to_romaji


def seg(*pairs):
    return [{"text": t, "ruby": r} for t, r in pairs]


@pytest.mark.parametrize(
    ("surface", "reading", "expected"),
    [
        ("食べる", "たべる", seg(("食", "た"), ("べる", None))),
        ("お茶", "おちゃ", seg(("お", None), ("茶", "ちゃ"))),
        ("今日", "きょう", seg(("今日", "きょう"),)),
        ("取り扱い", "とりあつかい", seg(("取", "と"), ("り", None), ("扱", "あつか"), ("い", None))),
        ("ひらがな", "ひらがな", seg(("ひらがな", None),)),
        ("カタカナ", "かたかな", seg(("カタカナ", None),)),
        ("人々", "ひとびと", seg(("人々", "ひとびと"),)),
        ("食べる", "タベル", seg(("食", "た"), ("べる", None))),  # katakana reading input
        ("食べる", "のむ", seg(("食べる", "のむ"),)),  # unalignable → whole-word fallback
        ("", "", []),
    ],
)
def test_furigana(surface, reading, expected):
    assert furigana(surface, reading) == expected


def test_kata_to_hira():
    assert kata_to_hira("カタカナー") == "かたかなー"
    assert kata_to_hira("漢字abc") == "漢字abc"


def test_has_japanese():
    assert has_japanese("abc ねこ")
    assert not has_japanese("Hello ♪ ~")


def test_romaji():
    assert to_romaji("たべる") == "taberu"
    assert to_romaji("") == ""
