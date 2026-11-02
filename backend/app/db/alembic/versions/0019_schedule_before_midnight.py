"""A schedule rule ends before midnight (Vimal on #85).

PostgreSQL's `time` accepts `24:00:00`, but asyncpg can't read it back, so one rule ending at
24:00 broke `GET /slots` and `GET /provider-schedules`. The contract's time pattern can't say
24:00 either. A rule that runs to the end of the day ends at 23:59, as the demo seed's all-day
schedule does; the start can't be 24:00 already (`time_order`).

Changes:
  admin.schedule_availability_rule  CHECK (end_time < '24:00'), ck_..._before_midnight

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-02
"""
from __future__ import annotations

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_check_constraint(op.f("ck_schedule_availability_rule_before_midnight"),
                               "schedule_availability_rule", "end_time < '24:00'",
                               schema="admin")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_schedule_availability_rule_before_midnight"),
                       "schedule_availability_rule", schema="admin", type_="check")
