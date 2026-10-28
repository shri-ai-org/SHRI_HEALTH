"""Merge by link (D103), the copay's payment and file columns (D104) and the enrollment key's
clinic.

Changes:
  admin.patient_merge   merge by link: no record moves, so admin.patient_merge_record, the
                        patients' versions before the merge and the version-based undo of 0008
                        (D51) go. The undo is refused only when the merge is already undone or
                        a later merge involving either patient still stands
                        (admin.patient_merge_undo_blocked_reason: 'already-undone',
                        'later-merge'; shri_patient_merge_guard enforces it). The undo moves
                        nothing back, so admin.finish_patient_merge_undo and its commit check go.
  admin.patient_payment receipt_file_id NOT NULL (D104): the receipt is made in the payment's
                        transaction. check_number (a check payment only) and note, for the
                        contract's checkNumber and note.
  admin.binary_object   for the file service (API_STANDARDS §15): purpose (files.yaml
                        FilePurpose), state (pending-upload, quarantined, clean, rejected) and
                        wrapped_data_key (the data key core wraps, set only on a clean file).
                        Receipts and after-visit summaries are made by the server, so they are
                        clean from the start; any other file is clean only after a clean scan.
  admin.payer_enrollment the unique key includes tenant_id, so each clinic records its own
                        enrollments with a platform payer.
  clinical.coverage     one coverage per patient per order at any time: same-order periods may
                        not overlap (ex_coverage_order_no_overlap; an open end is open-ended,
                        entered-in-error excluded), replacing one active coverage per order, so
                        an ended coverage frees its order.

Frozen SQL in sql_0012/:
  01_existing_tables.sql  hand-written: the enrollment key, the payment and file columns,
                          the coverage order rule
  02_merge_by_link.sql    hand-written: the 0008 rule removed, the link rule and guard
  90_downgrade.sql        all of it back as 0011 left it, with 0008's undo rule and its table

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
    op.execute((SQL_DIR / "90_downgrade.sql").read_text())
