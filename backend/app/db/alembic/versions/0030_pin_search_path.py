"""Every trigger function and every SECURITY DEFINER function runs with search_path pinned to
pg_catalog, pg_temp (Thulasi's #424 review; Anand's plan, 18 Nov).

Until 0029 the hand-written trigger functions (sql_0002/10_rules.sql) named their tables bare,
and found them through the caller's search_path (the service roles' clinical, admin, audit,
public). So a writing definer function that fired them had to pin search_path to those four
schemas (shri_fhir_history, shri_audit_chain, admin.portal_request_refill), and its safety rested
on nobody but shri_migrator being able to create in them. Now no function the database runs on
a caller's behalf resolves a name through a schema anyone could write to:

  qualified and pinned (CREATE OR REPLACE, the 0029 body with every table and every one of our
  functions schema-qualified, nothing else changed)
      shri_ai_provenance_guard, shri_ai_suggestion_guard, shri_appointment_sync,
      shri_audio_consent_check, shri_audit_chain (SECURITY DEFINER; public.digest from
      pgcrypto), shri_child_frozen_guard, shri_composition_attester_guard,
      shri_composition_content_guard, shri_composition_guard, shri_composition_signed_check,
      shri_erx_order_only, shri_fhir_history (SECURITY DEFINER), shri_fhir_touch_parent,
      shri_final_result_guard, shri_freeze_except, shri_medication_request_alert_check,
      shri_medication_request_guard, shri_participant_sync, shri_service_request_guard
  pinned only (their bodies name no table and none of our functions bare)
      shri_bump_version, shri_fhir_version, shri_forbid_change, shri_provenance_target_check,
      audit.record_fhir_lookup_denied (0003/0006, was pg_catalog, clinical, audit; the
      generator says the same now), admin.portal_request_refill (0029, was the four schemas)
  new
      public.shri_qualified_table(tbl text): the generated touch and frozen-child triggers pass
      their parent table by its bare name in the trigger's arguments, and two cross schemas
      (admin.employer touches clinical.patient and clinical.related_person;
      admin.service_request_aoe_answer is frozen by clinical.service_request). It returns the
      quoted schema.table of the first of clinical, admin and audit that has the table, the
      order the roles' search_path gave, and raises 42P01 when none has it. The triggers keep
      their arguments, so none is dropped or recreated.

The ten trigger functions and eighteen definer functions already pinned this way (0005 onwards)
don't change. tests/test_search_path_pin.py fails if any trigger or definer function in
clinical, admin, audit or public has another search_path, and server_check has the same line.

Frozen SQL in sql_0030/:
  01_qualify_and_pin.sql  hand-written
  90_downgrade.sql        the 0029 definitions (pg_get_functiondef at 0029), the pins reset,
                          the helper dropped

Revision ID: 0030
Revises: 0029
Create Date: 2026-11-19
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0030")


def upgrade() -> None:
    op.execute((SQL_DIR / "01_qualify_and_pin.sql").read_text())


def downgrade() -> None:
    op.execute((SQL_DIR / "90_downgrade.sql").read_text())
