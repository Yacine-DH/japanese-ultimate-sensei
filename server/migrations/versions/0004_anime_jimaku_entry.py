"""anime jimaku entry id

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-22 17:30:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("anime") as batch:
        batch.add_column(sa.Column("jimaku_entry_id", sa.Integer(), nullable=True))
        batch.create_index("ix_anime_jimaku_entry_id", ["jimaku_entry_id"])


def downgrade() -> None:
    with op.batch_alter_table("anime") as batch:
        batch.drop_index("ix_anime_jimaku_entry_id")
        batch.drop_column("jimaku_entry_id")
