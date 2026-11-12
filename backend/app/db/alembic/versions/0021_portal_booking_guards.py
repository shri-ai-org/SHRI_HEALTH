"""What the patient portal's self-booking needs beyond 0011's grants (Vimal's list on #85, #288;
D93, D108 as amended).

0011 already gives shri_portal the booking inserts (appointment, participant, reason), the
cancel's columns (status, the cancellation reason, ext_cancelled_at and the timestamps) and the
participant's updated_at, each limited to the session patient's own appointments, with no
DELETE; and admin.portal_busy_times(practitioner, from, to) gives another patient's taken times
without anyone's appointment (Vimal's item 1: no new function). This adds:

  admin.event_log           INSERT for shri_portal, RESTRICTIVE policy portal_own_event: the
                            session patient's own appointment.booked, .cancelled and
                            .rescheduled events only, so the front desk's day view updates live
  admin.portal_chart_open() SECURITY DEFINER, EXECUTE shri_portal only: locks the session
                            patient's row FOR SHARE and answers whether the chart is active and
                            not merged (the portal can neither lock the row nor read patient_link)
  trg_appointment_portal_revisit_guard
                            BEFORE UPDATE OF status ON clinical.appointment, for shri_portal
                            only (the trigger's WHEN reads the invoker): a booked revisit (an
                            appointment a follow-up request points at, D98) is moved by the
                            clinic, so the portal can't cancel or reschedule it. P0001 with
                            constraint portal_revisit_locked

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-11
"""
from __future__ import annotations

from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None

_PATIENT = "NULLIF(current_setting('app.current_patient_id', true), '')::uuid"
#: As sql/93_portal.sql (gen_db_rules.portal_booking_sql), frozen here.
PORTAL_EVENTS = (
    "GRANT INSERT ON admin.event_log TO shri_portal",
    f"CREATE POLICY portal_own_event ON admin.event_log AS RESTRICTIVE FOR INSERT "
    f"TO shri_portal WITH CHECK (patient_id = {_PATIENT} AND type IN ('appointment.booked', "
    f"'appointment.cancelled', 'appointment.rescheduled'))",
)
CHART_OPEN = """
CREATE FUNCTION admin.portal_chart_open() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE open boolean;
BEGIN
  -- The owner is under forced row security too, so this sees the session's clinic only.
  SELECT p.active AND NOT EXISTS (SELECT 1 FROM clinical.patient_link l
                                   WHERE l.patient_id = p.id AND l.type = 'replaced-by')
    INTO open
    FROM clinical.patient p
   WHERE p.id = NULLIF(current_setting('app.current_patient_id', true), '')::uuid
     FOR SHARE OF p;
  RETURN coalesce(open, false);
END $$;
REVOKE EXECUTE ON FUNCTION admin.portal_chart_open() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.portal_chart_open() TO shri_portal;
"""
REVISIT_GUARD = """
CREATE FUNCTION public.shri_portal_revisit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM clinical.encounter_follow_up f
              WHERE f.booked_appointment_id = OLD.id) THEN
    RAISE EXCEPTION 'appointment %: a booked revisit is moved by the clinic', OLD.id
      USING ERRCODE = 'P0001', CONSTRAINT = 'portal_revisit_locked';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.shri_portal_revisit_guard() FROM PUBLIC;
CREATE TRIGGER trg_appointment_portal_revisit_guard
  BEFORE UPDATE OF status ON clinical.appointment FOR EACH ROW
  WHEN (current_user = 'shri_portal' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.shri_portal_revisit_guard();
"""


def upgrade() -> None:
    for statement in PORTAL_EVENTS:
        op.execute(statement)
    op.execute(CHART_OPEN)
    op.execute(REVISIT_GUARD)


def downgrade() -> None:
    op.execute("DROP TRIGGER trg_appointment_portal_revisit_guard ON clinical.appointment")
    op.execute("DROP FUNCTION public.shri_portal_revisit_guard()")
    op.execute("DROP FUNCTION admin.portal_chart_open()")
    op.execute("DROP POLICY portal_own_event ON admin.event_log")
    op.execute("REVOKE INSERT ON admin.event_log FROM shri_portal")
