from app.nlp.tokenizer import line_romaji, tokenize


def by_surface(tokens):
    return {t.surface: t for t in tokens}


def test_basic_sentence():
    toks = tokenize("俺は海賊王になる男だ！")
    assert "".join(t.surface for t in toks) == "俺は海賊王になる男だ！"
    content = [t.lemma for t in toks if t.is_content]
    assert "海賊" in content or "海賊王" in content
    particles = [t for t in toks if t.surface == "は"]
    assert particles and not particles[0].is_content


def test_inflected_verb_lemma_and_reading():
    t = by_surface(tokenize("何か食べたい"))["食べ"]
    assert t.lemma == "食べる"
    assert t.lemma_reading == "たべる"
    assert t.reading == "たべ"
    assert t.furigana == [{"text": "食", "ruby": "た"}, {"text": "べ", "ruby": None}]
    assert t.romaji == "tabe"
    assert t.is_content


def test_punctuation_not_content():
    toks = tokenize("ありがとう！")
    assert not by_surface(toks)["！"].is_content


def test_romaji_sokuon_and_particles():
    toks = tokenize("旅は終わった")
    romaji = " ".join(t.romaji for t in toks)
    assert romaji == "tabi wa owat ta"  # 終わっ|た → owat + ta (reads "owatta")
    assert by_surface(tokenize("魔王を倒した"))["を"].romaji == "o"


def line(text):
    return line_romaji([t.to_dict() for t in tokenize(text)])


def test_line_romaji_groups_words():
    assert line("魔王を倒した勇者一行の旅は終わった。") == (
        "maou o taoshita yuusha ikkou no tabi wa owatta."
    )
    assert line("食べたいです。") == "tabetai desu."  # aux glues, copula stays a word
    assert line("勇者だった") == "yuusha datta"
    assert line("「行ってきます」と言った。") == '"itte kimasu" to itta.'
    assert line("寒くなかった") == "samuku nakatta"


def test_line_romaji_handles_legacy_tokens_without_new_fields():
    toks = [t.to_dict() for t in tokenize("旅は終わった")]
    for t in toks:
        t.pop("is_proper_noun")
    assert line_romaji(toks) == "tabi wa owatta"


def test_proper_nouns():
    toks = by_surface(tokenize("フリーレン様、東京へ行こう"))
    assert toks["フリーレン"].is_proper_noun  # out-of-vocabulary katakana → a name
    assert toks["東京"].is_proper_noun  # Sudachi 固有名詞
    assert not toks["フリーレン"].is_content and not toks["東京"].is_content
    assert line("フリーレン様、ヒンメルは勇者だった。") == "furiiren-sama, hinmeru wa yuusha datta."
    assert not by_surface(tokenize("テレビを見た"))["テレビ"].is_proper_noun  # known loanword
