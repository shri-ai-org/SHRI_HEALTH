"""Batch 1 follow-up schema items (A43; issue #13, follow-up c; locked with the schema, D72).

New table, clinic-scoped with forced RLS:
  admin.consent_requirement  the consents a practice asks for (D59): kind, title, policy
                      version, required, the blank form file, effective date, active. One row
                      per kind and policy version; the kind is fixed once created
                      (shri_fixed_columns); a version for the ETag (A41). Nothing is deleted.

Changes to existing tables:
  clinical.identifier supporting_document_id: the scanned document behind a patient's
                      identifier, e.g. a driver's license image (D56; the contract's
                      documentId), the same patient's document. Not served on /fhir.
  admin.patient_payment
                      receipt_file_id: the receipt PDF (D58).
  admin.patient_merge surviving_patient_version, merged_patient_version: both patients'
                      versions before the merge, as patient_merge_record has each moved
                      record's (the database checks they are current). Whether a merge can
                      still be undone (D51) is admin.patient_merge_undo_blocked_reason(id):
                      already-undone, records-changed, or NULL, by comparing versions. The
                      database refuses an undo that is not allowed, and any other change to a
                      merge (shri_patient_merge_guard). The undo ends with
                      admin.finish_patient_merge_undo(id), which refuses as records-changed an
                      undo that would leave a record pointing at the other patient's; an undo
                      that skips it is refused at commit (shri_patient_merge_undo_check).

Frozen SQL in sql_0008/:
  01_tables.sql          generated from the models: the new table
  02_existing_tables.sql hand-written: the column changes to existing tables
  03_rls_grants.sql      generated (gen_db_rules.rls_sql): RLS and grants for the new table
  04_functions.sql       hand-written: shri_fixed_columns, the merge version checks,
                         patient_merge_undo_blocked_reason and finish_patient_merge_undo
                         (EXECUTE for shri_app only), the merge guard and the undo check
  05_triggers.sql        generated (gen_db_rules.GUARDS, DEFERRED, VERSIONED_TABLES): the
                         triggers

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-26
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0008")
FILES = ["01_tables.sql", "02_existing_tables.sql", "03_rls_grants.sql", "04_functions.sql",
         "05_triggers.sql"]

DOWNGRADE = [
    "DROP TRIGGER trg_patient_merge_undo ON admin.patient_merge",
    "DROP TRIGGER trg_patient_merge_guard ON admin.patient_merge",
    "DROP TRIGGER trg_patient_merge_versions ON admin.patient_merge",
    "DROP TRIGGER trg_patient_merge_record_version ON admin.patient_merge_record",
    "DROP FUNCTION public.shri_patient_merge_undo_check()",
    "DROP FUNCTION public.shri_patient_merge_guard()",
    "DROP FUNCTION public.shri_patient_merge_versions()",
    "DROP FUNCTION public.shri_patient_merge_record_version()",
    "DROP FUNCTION admin.finish_patient_merge_undo(uuid)",
    "DROP FUNCTION admin.patient_merge_undo_blocked_reason(uuid)",
    "ALTER TABLE admin.patient_merge DROP COLUMN merged_patient_version",
    "ALTER TABLE admin.patient_merge DROP COLUMN surviving_patient_version",
    # Its triggers, policies, grants, indexes and keys go with it.
    "DROP TABLE admin.consent_requirement",
    "DROP FUNCTION public.shri_fixed_columns()",
    # Their checks and keys go with them.
    "ALTER TABLE admin.patient_payment DROP COLUMN receipt_file_id",
    "ALTER TABLE clinical.identifier DROP COLUMN supporting_document_id",
]


def upgrade() -> None:
    for name in FILES:
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
