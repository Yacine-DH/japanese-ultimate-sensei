"""episode sync points

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-23 18:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("episode") as batch:
        batch.add_column(
            sa.Column("sync_points_json", sa.String(), nullable=False, server_default="[]")
        )
        batch.add_column(sa.Column("synced_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("episode") as batch:
        batch.drop_column("synced_at")
        batch.drop_column("sync_points_json")
