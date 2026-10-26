"""USAGE on the public schema for the roles that fire triggers, and audit inserts for /fhir.

1. USAGE (never CREATE) on schema public for shri_app, shri_integration and shri_fhir_reader.
   The hand-written rule functions live in public (sql_0002/10_rules.sql), and every trigger on
   the clinical, admin and audit tables calls them. The database image revokes all access to
   public from PUBLIC (infra/compose/postgres/initdb/10-service-roles.sh), and RDS may too, so
   without this grant a role cannot fire the triggers on the tables it is allowed to write.
   shri_reporting writes nothing and gets nothing here.

2. shri_fhir_reader may insert audit events, and do nothing else on the audit schema
   (DECISIONS D23 as amended, decision update 2026-10-24): USAGE on audit and INSERT on
   audit.audit_event. No SELECT (not even on columns), no UPDATE, no DELETE, and no access to
   audit.break_glass_access. Forced RLS on audit_event still checks the clinic of every row.
   The hash-chain trigger function (public.shri_audit_chain) is already SECURITY DEFINER,
   owned by shri_migrator, with search_path pinned (sql_0002/10_rules.sql), so rows inserted
   by an insert-only role still chain.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-24
"""
from __future__ import annotations

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

UPGRADE = [
    "GRANT USAGE ON SCHEMA public TO shri_app, shri_integration, shri_fhir_reader",
    "GRANT USAGE ON SCHEMA audit TO shri_fhir_reader",
    "GRANT INSERT ON audit.audit_event TO shri_fhir_reader",
]

DOWNGRADE = [
    "REVOKE INSERT ON audit.audit_event FROM shri_fhir_reader",
    "REVOKE USAGE ON SCHEMA audit FROM shri_fhir_reader",
    "REVOKE USAGE ON SCHEMA public FROM shri_app, shri_integration, shri_fhir_reader",
]


def upgrade() -> None:
    for statement in UPGRADE:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
