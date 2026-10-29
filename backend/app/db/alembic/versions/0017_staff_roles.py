"""The staff roles for sign-in: one platform role per code in core's ROLE_PERMISSIONS.

Core's staff sign-in (#126) reads a user's roles from admin.user_role joined to admin.role, so
those roles must exist. This reverses "roles are not seeded" (#45) for admin.role only: the
codes come from core's ROLE_PERMISSIONS (app/core/permissions.py), generated, never typed. Core
stays the only permission catalogue: admin.permission and admin.role_permission are not seeded.

Changes:
  admin.role   one row per role code, tenant_id NULL (every clinic reads it; no role may write
               one) and is_system. A user's role in a clinic is an admin.user_role row (with a
               facility, or none for every facility) pointing at it. Inserted as the owner with
               row-level security not forced for that statement, as 0013 did for the platform
               rules; forced again before the migration commits.

When core's ROLE_PERMISSIONS gains or loses a code, test_staff_roles fails until a new
migration adds or retires the row (gen_db_rules.platform_roles_sql).

Frozen SQL in sql_0017/:
  01_staff_roles.sql  generated rows (gen_db_rules.platform_roles_sql), with the RLS steps
  90_downgrade.sql    the rows removed

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-29
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0017")


def upgrade() -> None:
    op.execute((SQL_DIR / "01_staff_roles.sql").read_text())


def downgrade() -> None:
    op.execute((SQL_DIR / "90_downgrade.sql").read_text())
