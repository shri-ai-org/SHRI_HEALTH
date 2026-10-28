"""Prescriptions and notes for the demo (D97, A58, D28, D73; demo steps 7 to 9).

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
  clinical.medication_request ck_medication_request_active_requires_signature also lets a
                        medication the patient reports (intent plan with reportedBoolean or
                        reportedReference; D28) be active without a signature; an order still
                        needs one. shri_erx_order_only: only an order is ever sent
                        (admin.erx_transaction).
  clinical.composition  the co-signature (D73): ext_cosign_status (not-required, pending,
                        returned, cosigned), ext_cosigner_practitioner_id (the supervising
                        physician named by the matching rule) and, only while returned, the
                        co-signer's ext_cosign_return_comment and ext_cosign_returned_at.
                        shri_composition_guard lets a signed note move these columns and
                        nothing else; the co-signer never changes and cosigned is final.
  shri_portal           reads every column of clinical.composition but the return comment
                        and its time (column-limited SELECT; gen_db_rules.PORTAL_HIDDEN_COLUMNS).
  admin.cds_rule        the platform's two fixed prescription rules (tenant_id NULL):
                        allergy (high, not suppressible) and duplicate-medication (moderate).

The alerts stay in clinical.detected_issue (with their overrides in detected_issue_mitigation),
which are their own resources, so recording them doesn't move the prescription's version either.

Frozen SQL in sql_0013/:
  01_safety_check.sql   the columns (as generated), the function (hand-written) and the
                        medication_request version trigger (as generated)
  02_reported_medications.sql  the check (as generated), shri_erx_order_only (hand-written)
                        and its trigger (as generated)
  03_cosign.sql         the columns and checks (as generated), shri_composition_guard
                        (hand-written, 0002's with the co-signature columns)
  04_platform_rules.sql the two platform rules (as generated), inserted by the owner with
                        RLS unforced for that statement
  05_portal.sql         the portal's column-limited SELECT on composition (as generated)
  90_downgrade.sql      everything back as 0012 left it

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


FILES = ["01_safety_check.sql", "02_reported_medications.sql", "03_cosign.sql",
         "04_platform_rules.sql", "05_portal.sql"]


def upgrade() -> None:
    for name in FILES:
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    op.execute((SQL_DIR / "90_downgrade.sql").read_text())
