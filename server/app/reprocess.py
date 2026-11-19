"""Re-tokenize every stored episode after tokenizer or dictionary changes.

Run (from server/):  uv run python -m app.reprocess
"""

from sqlmodel import Session, select

from app.config import get_settings
from app.db import make_engine
from app.dictionary import load_dictionary
from app.ingest import reprocess_episode
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


if __name__ == "__main__":
    main()
