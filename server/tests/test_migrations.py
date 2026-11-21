import sqlite3

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlalchemy import create_engine
from sqlmodel import SQLModel

from app.backup import backup, prune
from app.db import BASELINE, BASELINE_TABLES, alembic_config, make_engine


def test_fresh_db_is_migrated_and_matches_models(tmp_path):
    engine = make_engine(tmp_path / "sensei.sqlite")
    with engine.connect() as conn:
        ctx = MigrationContext.configure(conn)
        assert ctx.get_current_revision() is not None
        # If this fails, a model changed without a migration:
        #   cd server && uv run alembic revision --autogenerate -m "..."
        assert compare_metadata(ctx, SQLModel.metadata) == []
    assert not (tmp_path / "backups").exists()  # nothing to back up on a fresh DB


def test_legacy_create_all_db_is_backed_up_and_stamped(tmp_path):
    db = tmp_path / "sensei.sqlite"
    legacy = create_engine(f"sqlite:///{db}")
    # A pre-migration database had exactly the baseline schema (create_all of that time):
    # build it from migration 0001, then drop Alembic's bookkeeping.
    cfg = alembic_config()
    with legacy.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, BASELINE)
        conn.exec_driver_sql("DROP TABLE alembic_version")
    with legacy.begin() as conn:
        conn.exec_driver_sql(
            "INSERT INTO anime (title, created_at) VALUES ('Frieren', '2026-11-01')"
        )
    legacy.dispose()

    engine = make_engine(db)
    with engine.connect() as conn:
        assert MigrationContext.configure(conn).get_current_revision() is not None
        assert conn.exec_driver_sql("SELECT title FROM anime").scalar() == "Frieren"
    backups = list((tmp_path / "backups").glob("*-pre-migration.sqlite"))
    assert len(backups) == 1
    assert sqlite3.connect(backups[0]).execute("SELECT title FROM anime").fetchone() == ("Frieren",)
    make_engine(db)  # second start: already at head, no new backup
    assert len(list((tmp_path / "backups").glob("*.sqlite"))) == 1


def test_baseline_tables_constant_matches_models():
    assert BASELINE_TABLES <= set(SQLModel.metadata.tables)


def test_backup_prune(tmp_path):
    db = tmp_path / "x.sqlite"
    sqlite3.connect(db).execute("CREATE TABLE t (a)").connection.commit()
    dest = tmp_path / "b"
    for i in range(20):
        (dest / f"sensei-20260101-0000{i:02d}-nightly.sqlite").parent.mkdir(exist_ok=True)
        (dest / f"sensei-20260101-0000{i:02d}-nightly.sqlite").write_bytes(b"")
    out = backup(db, dest, "nightly")
    assert out.exists() and len(list(dest.glob("*-nightly.sqlite"))) == 14
    assert out in list(dest.glob("*"))  # newest kept
    prune(dest, "nightly")
    assert len(list(dest.glob("*-nightly.sqlite"))) == 14
