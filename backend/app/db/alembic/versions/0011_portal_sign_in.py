"""The patient portal (ADR-0013, D86, D90-D94; A50; Thulasi on #13) and the staff
back-channel logout (D94).

Sign-in, clinic-scoped with forced RLS (shri_app reads and writes, never deletes):
  admin.portal_invitation  an enrolment code: only its HMAC, 72 hours, one open per patient,
                      revoked at the fifth wrong date of birth.
  admin.portal_account     the patient-realm user linked to one chart: pending-setup, active,
                      disabled (time and reason, D92) or suspended (a merged chart, keeping the
                      status it had for the undo).
  admin.portal_session     the patient's session, as app_session.
  admin.consumed_logout_token  each staff logout token acted on (platform-wide; no role may
                      touch it).
  admin.lookup_portal_session, lookup_portal_account, redeem_portal_invitation and
  end_backchannel_sessions: SECURITY DEFINER, EXECUTE for shri_app only.

What the portal reads and writes (D93), the role shri_portal:
  RESTRICTIVE own-chart policies on every clinical table it reads, generated with #69's rules
  (gen_db_rules.portal_sql): the chart in app.current_patient_id only, never drafts,
  entered-in-error, non-final results, psychotherapy notes or held items. Practitioners and
  places by clinic only, a practitioner without date of birth, gender or personal contacts.
  Never history, provenance, alerts or record notes. Writes: bookings and their cancellation,
  and change requests; INSERT on audit_event.
  admin.portal_change_request (D91), admin.online_booking_setting and
  admin.online_bookable_type (A50 (3)), admin.release_hold (D90: the reason never reaches the
  portal).
  admin.portal_held_items() and admin.portal_busy_times(): EXECUTE for shri_portal only.
  fhir_resource_history.recorded_by_patient_id: a version written in a portal session.
The shri_maintenance purge also removes ended portal sessions, spent invitations and expired
logout tokens.

Frozen SQL in sql_0011/:
  01_tables.sql          generated from the models: the new tables
  02_existing_tables.sql hand-written: history authorship, and the same-patient keys the new
                         tables need
  03_rls_grants.sql      generated (gen_db_rules.rls_sql): RLS and staff grants
  04_functions.sql       hand-written: the functions, the guards, the history snapshot with its
                         patient author, and the narrow migrator policies
  05_triggers.sql        generated (gen_db_rules.GUARDS): the triggers
  06_portal.sql          generated (gen_db_rules.portal_sql): shri_portal's grants and policies
  90_downgrade_purge.sql, 91_downgrade_history.sql, 92_downgrade_portal.sql: for the downgrade

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
FILES = ["02_existing_tables.sql", "01_tables.sql", "03_rls_grants.sql", "04_functions.sql",
         "05_triggers.sql", "06_portal.sql"]
FUNCTIONS = ["admin.lookup_portal_session(text)", "admin.lookup_portal_account(text)",
             "admin.redeem_portal_invitation(text, date)",
             "admin.end_backchannel_sessions(text, timestamptz, text, text)",
             "admin.portal_held_items()",
             "admin.portal_busy_times(uuid, timestamptz, timestamptz)"]

DOWNGRADE = [
    (SQL_DIR / "92_downgrade_portal.sql").read_text(),
    (SQL_DIR / "91_downgrade_history.sql").read_text(),
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
    "DROP TABLE admin.release_hold",
    "DROP TABLE admin.portal_change_request",
    "DROP TABLE admin.online_bookable_type",
    "DROP TABLE admin.online_booking_setting",
    "DROP FUNCTION public.shri_final_once_decided()",
    "DROP FUNCTION public.shri_release_hold_guard()",
    "ALTER TABLE clinical.fhir_resource_history DROP COLUMN recorded_by_patient_id",
    "ALTER TABLE admin.work_item DROP CONSTRAINT uq_work_item_patient_id_id",
    "ALTER TABLE clinical.condition DROP CONSTRAINT uq_condition_subject_patient_id_id",
]


def upgrade() -> None:
    for name in FILES:
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
