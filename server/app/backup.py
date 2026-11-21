"""SQLite backups: online-safe copies of data/sensei.sqlite into data/backups/.

Nightly (systemd timer from deploy/install-service.sh) and automatically before every schema
migration.  Manual run (from server/):  uv run python -m app.backup
"""

import sqlite3
from datetime import datetime
from pathlib import Path

from app.config import get_settings

KEEP = {"nightly": 14, "pre-migration": 5, "manual": 5}


def backup(db_path: Path, dest_dir: Path, label: str = "manual") -> Path:
    """Copy the database with SQLite's backup API (consistent even while the server writes)."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"sensei-{datetime.now():%Y%m%d-%H%M%S}-{label}.sqlite"
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        out = sqlite3.connect(dest)
        with out:
            src.backup(out)
        out.close()
    finally:
        src.close()
    prune(dest_dir, label)
    return dest


def prune(dest_dir: Path, label: str) -> None:
    keep = KEEP.get(label, 5)
    files = sorted(dest_dir.glob(f"sensei-*-{label}.sqlite"))
    for old in files[:-keep]:
        old.unlink(missing_ok=True)


def main() -> None:
    import sys

    settings = get_settings()
    label = sys.argv[1] if len(sys.argv) > 1 else "manual"
    if not settings.db_path.exists():
        raise SystemExit(f"no database at {settings.db_path}")
    print(backup(settings.db_path, settings.data_dir / "backups", label))


if __name__ == "__main__":
    main()
