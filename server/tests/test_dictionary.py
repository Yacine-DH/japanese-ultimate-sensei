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


def test_lookup_puts_known_link_first(dictionary):
    ids = [e["id"] for e in dictionary.lookup("たべる", first="9999999")]
    assert ids[0] == "9999999" and "1358280" in ids


def test_lookup_skips_stale_first_entry(dictionary):
    # a word linked to an entry that no longer exists after a JMdict update
    ids = [e["id"] for e in dictionary.lookup("たべる", limit=1, first="0000000")]
    assert ids == ["1358280"]
    assert len(dictionary.lookup("たべる", limit=5, first="0000000")) == 2  # nothing dropped


def test_pos_breaks_ties_between_kana_homographs(tmp_path):
    """副詞 そう is 然う "in that way", not the auxiliary "seeming" (#89)."""
    import json

    from app.dictionary import Dictionary, build

    def entry(eid, kana, pos, gloss, misc=()):
        return {
            "id": eid,
            "kanji": [],
            "kana": [{"text": kana, "common": True, "tags": []}],
            "sense": [
                {"partOfSpeech": pos, "misc": list(misc), "gloss": [{"lang": "eng", "text": gloss}]}
            ],
        }

    src = tmp_path / "d.json"
    src.write_text(
        json.dumps(
            {
                "words": [
                    entry("1006610", "そう", ["aux", "adj-na"], "appearing that"),
                    entry("2137720", "そう", ["adv"], "in that way", ["uk"]),
                ]
            }
        )
    )
    out = tmp_path / "d.sqlite"
    build([src], out)
    d = Dictionary(out)
    assert d.best("そう", "そう", "副詞")[0] == "2137720"
    assert d.best("そう", "そう", "形状詞")[0] == "1006610"
