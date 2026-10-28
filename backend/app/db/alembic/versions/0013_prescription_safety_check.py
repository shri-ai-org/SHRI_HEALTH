"""The latest safety check on a prescription (D97, A58; demo step 9).

Changes:
  clinical.medication_request  ext_safety_checked_at and ext_safety_checked_version: when the
                        latest safety check ran and on which version of the draft (the
                        contract's read-only safetyCheckedAt, present only while the checked
                        version is the current one). Recording a check is not a new version of
                        the prescription: no meta_version_id bump, no new meta_last_updated
                        (so no new ETag) and no history row, so an open editor's If-Match keeps
                        working (A58 (3)). Once signed, the columns are frozen with the rest of
                        the prescription (shri_medication_request_guard).
  shri_fhir_version()   takes, as trigger arguments, the columns whose change alone is not a
                        new version (FhirResourceMixin.fhir_unversioned_columns). Unchanged for
                        every table whose trigger passes none.

The alerts stay in clinical.detected_issue (with their overrides in detected_issue_mitigation),
which are their own resources, so recording them doesn't move the prescription's version either.

Frozen SQL in sql_0013/:
  01_safety_check.sql   the columns (as generated), the function (hand-written) and the
                        medication_request version trigger (as generated)
  90_downgrade.sql      the trigger and function as 0002 left them, and the columns dropped

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-28
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0013")


def upgrade() -> None:
    op.execute((SQL_DIR / "01_safety_check.sql").read_text())


def downgrade() -> None:
    op.execute((SQL_DIR / "90_downgrade.sql").read_text())
