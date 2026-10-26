"""Thulasi's core tables and changes (issue #13, follow-up a; locked with the schema, D72).

New tables, all clinic-scoped with forced RLS (models in app/db/models/admin/runtime.py):
  admin.app_session         one row per sign-in; session and CSRF tokens as SHA-256 hashes,
                            Keycloak tokens encrypted by core; tokens_refreshed_at records the
                            last Keycloak refresh (#35)
  admin.idempotency_record  Idempotency-Key results for 24 hours (T21, ADR-0007)
  admin.operation           long-running 202 work (API_STANDARDS §13)
  admin.event_log           thin events for SSE replay (T28)

Changes to existing tables:
  audit.audit_event         category (SECURITY_MODEL §6), existing rows derived from action;
                            clinic-less security events may be inserted by shri_app (A47);
                            the platform audit chain numbers clinic-less rows correctly
  audit.break_glass_access  reason_code plus optional reason_text, as the contract (D53)
  admin.integration_message the outbox: ordering_key, payload (IDs only), claim indexes

Two SECURITY DEFINER functions cross clinics, each for one role: admin.lookup_session
(cookie to session, shri_app) and admin.claim_outbound_messages (the outbox worker,
shri_integration). No role gets BYPASSRLS (D23).

RLS is forced, so it applies to shri_migrator too, which owns the tables and the functions.
Narrow policies, each TO shri_migrator for one command, let it see exactly the rows those
functions and the audit-chain trigger need (sql_0005/04_policies.sql).

Frozen SQL in sql_0005/:
  01_tables.sql          generated from the models: the four new tables
  02_existing_tables.sql hand-written: the column changes to the three existing tables
  03_rls_grants.sql      generated (gen_db_rules.rls_sql): RLS and grants for the new tables
  04_policies.sql        hand-written: A47 and the shri_migrator policies
  05_functions.sql       hand-written: lookup_session, claim_outbound_messages

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-26
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0005")
FILES = ["01_tables.sql", "02_existing_tables.sql", "03_rls_grants.sql", "04_policies.sql",
         "05_functions.sql"]

DOWNGRADE = [
    "DROP FUNCTION admin.claim_outbound_messages(integer)",
    "DROP FUNCTION admin.lookup_session(text)",
    "DROP POLICY migrator_outbox_claim ON admin.integration_message",
    "DROP POLICY migrator_outbox_read ON admin.integration_message",
    "DROP POLICY migrator_platform_chain ON audit.audit_event",
    "DROP POLICY platform_security_insert ON audit.audit_event",
    # Their policies, grants, indexes and keys go with them.
    "DROP TABLE admin.event_log",
    "DROP TABLE admin.operation",
    "DROP TABLE admin.idempotency_record",
    "DROP TABLE admin.app_session",
    "DROP INDEX admin.ix_integration_message_ordering",
    "DROP INDEX admin.ix_integration_message_outbound_due",
    "ALTER TABLE admin.integration_message DROP COLUMN payload",
    "ALTER TABLE admin.integration_message DROP COLUMN ordering_key",
    # Back to one free-text reason of at least 10 characters. A grant made with a code only
    # gets the code as its reason; a rewrite, because the guard trigger refuses an UPDATE.
    "ALTER TABLE audit.break_glass_access DROP CONSTRAINT ck_break_glass_access_other_needs_text",
    "ALTER TABLE audit.break_glass_access DROP CONSTRAINT ck_break_glass_access_reason_code_codes",
    """ALTER TABLE audit.break_glass_access ALTER COLUMN reason_text TYPE VARCHAR(500) USING (
         CASE WHEN reason_code = 'other' AND length(trim(reason_text)) >= 10 THEN reason_text
              ELSE left('break-glass ' || reason_code || coalesce(': ' || reason_text, ''), 500)
         END)""",
    # Rename first: PostgreSQL 18 names the NOT NULL constraint after the column it is set on.
    "ALTER TABLE audit.break_glass_access RENAME COLUMN reason_text TO reason",
    "ALTER TABLE audit.break_glass_access ALTER COLUMN reason SET NOT NULL",
    "ALTER TABLE audit.break_glass_access ADD CONSTRAINT ck_break_glass_access_reason_stated "
    "CHECK (length(trim(reason)) >= 10)",
    "ALTER TABLE audit.break_glass_access DROP COLUMN reason_code",
    "DROP INDEX audit.ix_audit_event_platform_time",
    # Not in the hash payload, so every hash still verifies without it.
    "ALTER TABLE audit.audit_event DROP COLUMN category",
]


def upgrade() -> None:
    for name in FILES:
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
