"""Staff sign-in's lookup: who a Keycloak subject is, before a clinic is known (Thulasi on #13;
core's staff sign-in, #126).

Changes:
  admin.lookup_staff_user(keycloak_subject)  returns (user_id, tenant_id, is_active) for the
                       app_user with that Keycloak subject, at most one row (the column is
                       unique), or none. SECURITY DEFINER, owned by shri_migrator, search_path
                       pinned, EXECUTE for shri_app only, as admin.lookup_portal_account (0011).
                       Inactive users and platform staff (no clinic) are returned too: core
                       refuses them (403).
  admin.app_user       a SELECT policy for shri_migrator alone, so the function can read the
                       users under the table's forced RLS; no other role gains anything.

Frozen SQL in sql_0016/:
  01_staff_lookup.sql  hand-written: the policy and the function
  90_downgrade.sql     both dropped

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-28
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0016")


def upgrade() -> None:
    op.execute((SQL_DIR / "01_staff_lookup.sql").read_text())


def downgrade() -> None:
    op.execute((SQL_DIR / "90_downgrade.sql").read_text())
