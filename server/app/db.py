import logging
from collections.abc import Iterator
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from fastapi import Request
from sqlalchemy import Engine, event, inspect
from sqlmodel import Session, SQLModel, create_engine

from app import models  # noqa: F401  (register tables)
from app.backup import backup

log = logging.getLogger("sensei.db")
MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"
BASELINE = "0001"  # schema of databases created by create_all() before migrations existed
BASELINE_TABLES = {
    "activityday", "anime", "card", "episode", "media", "reviewlog", "subtitleline",
    "understandingsnapshot", "userword", "watchday", "word",
}  # fmt: skip


def make_engine(db_path: Path) -> Engine:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):  # pragma: no cover - trivial
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    migrate(engine, db_path)
    return engine


def alembic_config() -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS))
    return cfg


def migrate(engine: Engine, db_path: Path) -> None:
    """Bring the database to the latest schema. Backs it up first if it has data."""
    cfg = alembic_config()
    head = ScriptDirectory.from_config(cfg).get_current_head()
    with engine.begin() as conn:
        tables = set(inspect(conn).get_table_names()) - {"alembic_version"}
        current = MigrationContext.configure(conn).get_current_revision()
    if current == head:
        return
    if tables:
        log.warning("database at %s needs migration (%s → %s); backing up", db_path, current, head)
        backup(db_path, db_path.parent / "backups", "pre-migration")
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        if current is None and tables:
            # Pre-migration database (made by create_all): add any *baseline* table it lacks,
            # then mark it as the baseline so only later migrations run.
            missing = [
                t
                for t in SQLModel.metadata.sorted_tables
                if t.name in BASELINE_TABLES and t.name not in tables
            ]
            SQLModel.metadata.create_all(conn, tables=missing)
            command.stamp(cfg, BASELINE)
        command.upgrade(cfg, "head")


def get_session(request: Request) -> Iterator[Session]:
    with Session(request.app.state.engine) as session:
        yield session
