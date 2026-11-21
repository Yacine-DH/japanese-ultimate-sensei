"""Alembic environment. Runs with the app's connection when called from app.db.migrate(),
or opens data/sensei.sqlite (app settings) when run from the alembic CLI."""

from alembic import context
from sqlalchemy import create_engine
from sqlmodel import SQLModel

from app import models  # noqa: F401  (register tables)

target_metadata = SQLModel.metadata


def run(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,  # SQLite can't ALTER most things; batch mode recreates tables
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    raise SystemExit("offline (SQL script) migrations are not supported")

conn = context.config.attributes.get("connection")
if conn is not None:
    run(conn)
else:
    from app.config import get_settings

    engine = create_engine(f"sqlite:///{get_settings().db_path}")
    with engine.begin() as c:
        run(c)
