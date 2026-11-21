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


def reading_of(text, surface):
    return by_surface(tokenize(text))[surface].reading


def test_colloquial_readings():
    assert reading_of("私は勇者だ", "私") == "わたし"
    assert reading_of("明日行こう", "明日") == "あした"
    assert by_surface(tokenize("私は勇者だ"))["私"].furigana == [{"text": "私", "ruby": "わたし"}]
    assert line("私は勇者だ") == "watashi wa yuusha da"
    # 何: なん before d/t/n sounds, なに otherwise
    for text, want in [
        ("何を食べる", "なに"), ("何が好き", "なに"), ("何もない", "なに"), ("何か食べたい", "なに"),
        ("何？", "なに"), ("何に使う", "なに"),
        ("何で泣いてるの", "なん"), ("何の話", "なん"), ("何だと", "なん"), ("何と言った", "なん"),
    ]:  # fmt: skip
        assert reading_of(text, "何") == want, text


def test_nan_nani_before_verbs_and_counters():
    for text, want in [
        ("何飲んでるの", "なに"), ("何泣いてるの", "なに"), ("何できるの", "なに"),
        ("何冊ある", "なん"), ("何軒", "なん"), ("何なの", "なん"),
    ]:  # fmt: skip
        assert reading_of(text, "何") == want, text


def test_nani_key_is_context_free():
    keys = {
        by_surface(tokenize(t))["何"].lemma_reading
        for t in ("何を食べる", "何の話", "何飲んでるの")
    }
    assert len(keys) == 1  # one word, one status, whatever the furigana says


def test_real_data_keys_and_romaji():
    """Frieren ep 2 findings (#89, #92)."""
    from app.nlp.tokenizer import line_romaji

    toks = tokenize("ある日 魔法がある")
    aru = [t for t in toks if t.surface == "ある"]
    assert aru[0].pos == "連体詞" and aru[0].lemma == "或る" and aru[0].lemma_reading == "ある"
    assert aru[1].pos == "動詞" and aru[1].lemma == "ある"  # distinct keys → distinct glosses
    sou = [t for t in tokenize("心配はなさそうだし") if t.surface == "そう"]
    assert sou and not sou[0].is_content  # 〜そう is grammar
    assert all(t.reading == t.surface for t in tokenize("あの 子") if t.pos == "空白")

    def rom(s: str) -> str:
        return line_romaji([t.to_dict() for t in tokenize(s)])

    assert rom("三つの要素") == "mittsu no youso"
    assert rom("一つは") == "hitotsu wa"
    assert rom("打ち込みすぎだ。") == "uchikomisugi da."
    assert rom("え～とね") == "ee to ne"
    assert rom("お願いします") == "onegai shimasu"
    assert rom("お好きなのですね") == "osuki na no desu ne"
    assert rom("なさそうだし") == "nasasou da shi"
    assert rom("ハイター様が") == "haitaa-sama ga"  # honorifics keep the hyphen
    assert rom("見捨てないような") == "misutenai you na"
