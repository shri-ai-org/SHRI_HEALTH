"""Online pre-registration (D96, A51; issue #13, Thulasi's answers on the storage).

New table, clinic-scoped with forced RLS:
  admin.pre_registration  a request from the public form, as the person typed it
                      (patient-reported), with its Idempotency-Key and body hash, unique per
                      clinic. The front desk accepts it (the patient it created or linked, and
                      the kind of ID it checked) or rejects it with a reason; a decided request
                      never changes (shri_pre_registration_guard), and what was submitted never
                      does (shri_fixed_columns). shri_app reads it and records the decision
                      only: no INSERT, no DELETE.

Changes to existing tables:
  admin.tenant        pre_registration_code, pre_registration_enabled: the practice's public
                      link (the {practiceLinkId} in the form's URL) and whether it is on.
  audit.audit_event   the actor type `anonymous`, never with a user.
  admin.mrn_counter   the prefix is 2 to 8 capitals or digits, as GET /practice-settings
                      returns it (#96).

Functions:
  admin.submit_pre_registration(...)  the public form's only write: SECURITY DEFINER, EXECUTE
                      for shri_public only (a role with USAGE on admin and nothing else). It
                      finds the clinic from the practice's code, stores the request and writes
                      its anonymous audit row, and returns nothing.
  admin.purge_expired_runtime_rows()  also deletes requests rejected, or never reviewed, 30
                      days ago (shri_maintenance, as before).

Frozen SQL in sql_0009/:
  01_tables.sql          generated from the models: the new table
  02_existing_tables.sql hand-written: the changes to existing tables
  03_rls_grants.sql      generated (gen_db_rules.rls_sql): RLS and grants for the new table
  04_functions.sql       hand-written: the guard, the insert function, the purge and their
                         narrow policies
  05_triggers.sql        generated (gen_db_rules.GUARDS): the triggers
  90_downgrade_purge.sql the purge as 0005 left it, for the downgrade

Needs the shri_public role (Thulasi: the database image, CI and the RDS first run).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-27
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0009")
FILES = ["01_tables.sql", "02_existing_tables.sql", "03_rls_grants.sql", "04_functions.sql",
         "05_triggers.sql"]
SUBMIT = "admin.submit_pre_registration(text, uuid, text, jsonb, boolean, inet, text, text)"

DOWNGRADE = [
    (SQL_DIR / "90_downgrade_purge.sql").read_text(),
    f"DROP FUNCTION {SUBMIT}",
    "REVOKE USAGE ON SCHEMA admin FROM shri_public",
    "DROP POLICY migrator_pre_registration_link ON admin.tenant",
    # Its triggers, policies, grants, indexes and keys go with it.
    "DROP TABLE admin.pre_registration",
    "DROP FUNCTION public.shri_pre_registration_guard()",
    "ALTER TABLE admin.mrn_counter DROP CONSTRAINT ck_mrn_counter_prefix_format, "
    "ADD CONSTRAINT ck_mrn_counter_prefix_format CHECK (prefix ~ '^[A-Z0-9]{1,10}$')",
    # Refused once an anonymous row exists: the audit trail is never rewritten.
    "ALTER TABLE audit.audit_event DROP CONSTRAINT ck_audit_event_anonymous_actor, "
    "DROP CONSTRAINT ck_audit_event_actor_type_codes, "
    "ADD CONSTRAINT ck_audit_event_actor_type_codes CHECK (actor_type IN "
    "('user', 'system', 'ai', 'integration', 'patient', 'partner'))",
    # Their grants, checks and the unique key go with them.
    "ALTER TABLE admin.tenant DROP COLUMN pre_registration_enabled, "
    "DROP COLUMN pre_registration_code",
]


def upgrade() -> None:
    for name in FILES:
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
