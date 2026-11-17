from app.nlp.tokenizer import tokenize


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
