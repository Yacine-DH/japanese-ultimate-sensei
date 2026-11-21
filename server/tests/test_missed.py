from app.nlp.frequency import usefulness, zipf

from .test_api import upload


def test_zipf_and_usefulness():
    assert zipf("食べる") > zipf("凱旋") > 0
    assert zipf("ｘｙｚｘｙｚ無意味") == 0.0
    assert usefulness(5.0, 3, 10) > usefulness(5.0, 1, 1) > usefulness(3.0, 1, 1)


def test_tokens_and_words_carry_zipf(client):
    ep = upload(client).json()
    toks = [t for line in client.get(f"/episodes/{ep['id']}/lines").json() for t in line["tokens"]]
    tabe = next(t for t in toks if t["surface"] == "食べ")
    assert tabe["zipf"] > 4
    assert next(t for t in toks if t["surface"] == "は")["zipf"] is None  # particles: no word
    items = client.get("/words", params={"sort": "frequency"}).json()["items"]
    zs = [w["zipf"] for w in items]
    assert zs == sorted(zs, reverse=True) and all(z is not None for z in zs)


def test_missed_words(client):
    ep = upload(client).json()
    missed = client.get(f"/episodes/{ep['id']}/missed").json()
    assert missed and missed == sorted(missed, key=lambda m: -m["score"])
    first = missed[0]
    assert first["word"]["status"] == "new" and first["word"]["occurrences"] >= 1
    assert first["example"]["text"] and first["anime_occurrences"] >= first["word"]["occurrences"]
    tabe = next(m for m in missed if m["word"]["lemma"] == "食べる")
    assert tabe["gloss_en"] and tabe["gloss_de"]

    # known words disappear; learning only with include_learning
    client.post(f"/words/{tabe['word']['id']}/status", json={"status": "known"})
    lemmas = {m["word"]["lemma"] for m in client.get(f"/episodes/{ep['id']}/missed").json()}
    assert "食べる" not in lemmas
    other = missed[1]["word"] if missed[0]["word"]["lemma"] == "食べる" else missed[0]["word"]
    client.post(f"/words/{other['id']}/status", json={"status": "learning"})
    assert other["lemma"] not in {
        m["word"]["lemma"] for m in client.get(f"/episodes/{ep['id']}/missed").json()
    }
    assert other["lemma"] in {
        m["word"]["lemma"]
        for m in client.get(
            f"/episodes/{ep['id']}/missed", params={"include_learning": True}
        ).json()
    }
    assert len(client.get(f"/episodes/{ep['id']}/missed", params={"limit": 1}).json()) == 1
    assert client.get("/episodes/999/missed").status_code == 404


def test_lookup_with_word_id_returns_linked_entry_first(client):
    ep = upload(client).json()
    toks = [t for line in client.get(f"/episodes/{ep['id']}/lines").json() for t in line["tokens"]]
    tabe = next(t for t in toks if t["surface"] == "食べ")
    r = client.get(
        "/dictionary/lookup",
        params={"q": "たべる", "reading": "たべる", "word_id": tabe["word_id"]},
    ).json()
    assert r["entries"][0]["id"] == "1358280"
