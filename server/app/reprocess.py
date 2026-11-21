"""Re-tokenize every stored episode and re-link words to JMdict after tokenizer or
dictionary changes.

Run (from server/):  uv run python -m app.reprocess
"""

from sqlmodel import Session, select

from app.config import get_settings
from app.db import make_engine
from app.dictionary import load_dictionary
from app.ingest import relink_words, reprocess_episode
from app.models import Episode


def main() -> None:
    settings = get_settings()
    engine = make_engine(settings.db_path)
    dictionary = load_dictionary(settings.dictionary_path)
    with Session(engine) as session:
        for ep in session.exec(select(Episode)).all():
            n = reprocess_episode(session, ep.id, dictionary)
            session.commit()
            print(f"episode {ep.id}: {n} lines")
        if dictionary is not None:
            print(f"re-linked {relink_words(session, dictionary)} words to JMdict")
            session.commit()


if __name__ == "__main__":
    main()
