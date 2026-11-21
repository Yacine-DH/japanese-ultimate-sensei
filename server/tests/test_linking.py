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
