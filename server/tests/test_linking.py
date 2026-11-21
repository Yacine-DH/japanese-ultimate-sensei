"""JMdict linking order (review of PR #79) and query counts."""

from sqlalchemy import event

from app.ingest import WordResolver
from app.nlp.tokenizer import tokenize

from .test_api import upload


class SpyDictionary:
    def __init__(self):
        self.queries: list[str] = []

    def best(self, text, reading=None, pos=None):
        self.queries.append(text)
        return ("1", True)  # first query wins


def first_query(sentence: str, surface: str) -> str:
    tok = next(t for t in tokenize(sentence) if t.surface == surface)
    spy = SpyDictionary()
    WordResolver(None, spy)._jmdict(tok)
    return spy.queries[0]


def test_kanji_lemma_links_to_itself_not_normalized_form():
    assert first_query("敵を斬る", "斬る") == "斬る"  # not 切る
    assert first_query("嫉妬で妬く", "妬く") == "妬く"  # not 焼く
    assert first_query("音楽を聴く", "聴く") == "聴く"  # not 聞く


def test_kana_lemma_uses_normalized_kanji_first():
    assert first_query("見ている", "いる") == "居る"
    assert first_query("そんなものだ", "もの") == "物"


def test_no_per_word_queries_when_listing(client):
    upload(client)
    client.get("/words", params={"sort": "frequency"})  # first call may fill zipf
    statements: list[str] = []
    engine = client.app.state.engine

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", count)
    try:
        client.get("/words", params={"sort": "frequency", "limit": 500})
        ep_id = client.get("/episodes").json()[0]["id"]
        client.get(f"/episodes/{ep_id}/missed")
    finally:
        event.remove(engine, "before_cursor_execute", count)
    per_word = [s for s in statements if "FROM word" in s and "word.id = ?" in s]
    assert per_word == [], f"{len(per_word)} per-word reloads"


def test_relink_uses_tokens_in_context(client, dictionary):
    """Review of #95: relinking must not re-tokenize a lemma alone (した → し|た, 為る)."""
    from sqlmodel import Session, select

    from app.ingest import relink_words
    from app.models import SubtitleLine, Word

    srt = b"1\n00:00:01,000 --> 00:00:02,000\n\xe9\xad\x94\xe7\x8e\x8b\xe3\x82\x92\xe5\x80\x92\xe3\x81\x99\n"
    ep = client.post(
        "/episodes", data={"anime_title": "x"}, files={"subtitle": ("s.srt", srt)}
    ).json()
    tok = next(
        t for t in client.get(f"/episodes/{ep['id']}/lines").json()[0]["tokens"] if t["word_id"]
    )
    engine = client.app.state.engine
    with Session(engine) as s:
        w = s.get(Word, tok["word_id"])
        before = (w.jmdict_id, w.pos)
        # a word only known from an Anki import, whose lemma splits when tokenized alone
        s.add(Word(lemma="した", reading="した", pos="名詞"))
        s.commit()
        relink_words(s, dictionary)
        s.commit()
        w = s.get(Word, tok["word_id"])
        assert (w.jmdict_id, w.pos) == before  # context POS kept
        shita = s.exec(select(Word).where(Word.lemma == "した")).one()
        assert shita.pos == "名詞"  # not 動詞 from the し|た split
        assert s.exec(select(SubtitleLine)).first()
