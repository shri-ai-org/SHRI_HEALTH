"""Merge by link (D103), required receipts (D104) and the enrollment key's clinic.

Changes:
  admin.patient_merge   merge by link: no record moves, so admin.patient_merge_record, the
                        patients' versions before the merge and the version-based undo of 0008
                        (D51) go. The undo is refused only when the merge is already undone or
                        a later merge involving either patient still stands
                        (admin.patient_merge_undo_blocked_reason: 'already-undone',
                        'later-merge'; shri_patient_merge_guard enforces it). The undo moves
                        nothing back, so admin.finish_patient_merge_undo and its commit check go.
  admin.patient_payment receipt_file_id NOT NULL (D104): the receipt is made in the payment's
                        transaction.
  admin.payer_enrollment the unique key includes tenant_id, so each clinic records its own
                        enrollments with a platform payer.

Frozen SQL in sql_0012/:
  01_existing_tables.sql        hand-written: the enrollment key and the required receipt
  02_merge_by_link.sql          hand-written: the 0008 rule removed, the link rule and guard
  90_downgrade_merge_record.sql the enrollment key, optional receipt and 0008's undo rule with
                                its table, for the downgrade

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-28
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0012")
FILES = ["01_existing_tables.sql", "02_merge_by_link.sql"]


def upgrade() -> None:
    for name in FILES:
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    op.execute((SQL_DIR / "90_downgrade_merge_record.sql").read_text())
