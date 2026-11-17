def test_lookup_merges_languages(dictionary):
    [entry, *_] = dictionary.lookup("食べる")
    assert entry["id"] == "1358280"
    assert entry["common"] is True
    assert entry["kanji"] == ["食べる", "喰べる"]
    assert entry["senses"]["eng"][0]["glosses"] == ["to eat"]
    assert entry["senses"]["ger"][0]["glosses"] == ["essen", "speisen"]


def test_kana_lookup_prefers_common(dictionary):
    ids = dictionary.find_ids("たべる")
    assert ids[0] == "1358280"  # common entry beats the rare homophone
    assert "9999999" in ids


def test_reading_disambiguates_and_kana_form_matches(dictionary):
    assert dictionary.best("なる", "なる") == ("1375610", True)


def test_missing(dictionary):
    assert dictionary.lookup("存在しない") == []
    assert dictionary.best("存在しない") is None
