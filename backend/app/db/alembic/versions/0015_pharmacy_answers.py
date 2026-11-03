"""The partner worker files the pharmacy's answer to a prescription (D97, D99; Thulasi on #124).

Changes:
  admin.erx_transaction  shri_integration may read it and update only status, error_message,
                         vendor_message_id and updated_by_user_id, so the worker can move a
                         NewRx from queued to sent, then accepted or rejected
                         (fhir_store.set_transmission_status). It never inserts or deletes one,
                         and the table's clinic policy keeps it to the clinic it works in.

Frozen SQL in sql_0015/:
  01_grants.sql     as generated (gen_db_rules.INTEGRATION_COLUMN_UPDATE)
  90_downgrade.sql  the grants revoked

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-28
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0015")


def upgrade() -> None:
    op.execute((SQL_DIR / "01_grants.sql").read_text())


def downgrade() -> None:
    op.execute((SQL_DIR / "90_downgrade.sql").read_text())
