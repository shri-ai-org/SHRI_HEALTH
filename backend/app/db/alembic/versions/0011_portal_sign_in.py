"""The patient portal's sign-in tables and the staff back-channel logout (ADR-0013 §3 and §5,
D92, D94; A50 (1), (6), (8); Thulasi on #13).

New tables, clinic-scoped with forced RLS (shri_app reads and writes them, never deletes):
  admin.portal_invitation  an enrolment code issued at the desk: only its HMAC, 72 hours, one
                      open per patient, failed tries (revoked at the fifth).
  admin.portal_account     the patient-realm user linked to one chart: status pending-setup,
                      active, disabled (with time and reason, D92) or suspended (a merged chart,
                      keeping the status it had for the undo).
  admin.portal_session     the patient's server-side session, as app_session, for the account
                      and its patient.
Platform-wide, no role may read or write it:
  admin.consumed_logout_token  each staff logout token acted on, until it expires (jti once).

Functions (SECURITY DEFINER, EXECUTE for shri_app only):
  admin.lookup_portal_session(token_hash), admin.lookup_portal_account(keycloak_user_id) and
  admin.redeem_portal_invitation(code_hmac, birth_date): the three steps before a clinic is
  known; admin.end_backchannel_sessions(jti, jti_expires_at, sid, subject): records the token
  and ends the staff sessions it names, across clinics, returning them for their audit rows.
  admin.purge_expired_runtime_rows() also removes ended portal sessions, spent invitations and
  expired logout tokens (shri_maintenance, as before).

Frozen SQL in sql_0011/:
  01_tables.sql          generated from the models: the new tables
  03_rls_grants.sql      generated (gen_db_rules.rls_sql): RLS and grants
  04_functions.sql       hand-written: the functions and their narrow migrator policies
  05_triggers.sql        generated (gen_db_rules.GUARDS): the fixed-column triggers
  90_downgrade_purge.sql the purge as 0009 left it, for the downgrade

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-27
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0011")
FILES = ["01_tables.sql", "03_rls_grants.sql", "04_functions.sql", "05_triggers.sql"]
FUNCTIONS = ["admin.lookup_portal_session(text)", "admin.lookup_portal_account(text)",
             "admin.redeem_portal_invitation(text, date)",
             "admin.end_backchannel_sessions(text, timestamptz, text, text)"]

DOWNGRADE = [
    (SQL_DIR / "90_downgrade_purge.sql").read_text(),
    *(f"DROP FUNCTION {f}" for f in FUNCTIONS),
    "DROP POLICY migrator_portal_invitation_patient ON clinical.patient",
    "DROP POLICY migrator_backchannel_end ON admin.app_session",
    "DROP POLICY migrator_backchannel_read ON admin.app_session",
    "DROP POLICY migrator_backchannel_user ON admin.app_user",
    # Their triggers, policies, grants, indexes and keys go with them.
    "DROP TABLE admin.portal_session",
    "DROP TABLE admin.portal_account",
    "DROP TABLE admin.portal_invitation",
    "DROP TABLE admin.consumed_logout_token",
]


def upgrade() -> None:
    for name in FILES:
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
