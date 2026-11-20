"""A practitioner added while its appointment moves can't be double-booked (#471's gap).

  public.shri_participant_sync()
      The BEFORE INSERT OR UPDATE trigger on clinical.appointment_participant copies the
      appointment's period and whether it blocks (ext_blocking) onto the row, for
      ex_appointment_participant_no_double_booking. It read the appointment without locking it,
      so a practitioner row inserted while another transaction moved or reinstated the
      appointment copied the old period or status, and nothing recomputed it after that
      transaction committed: the practitioner could be booked twice for one slot. It now reads
      the appointment FOR NO KEY UPDATE OF ap, so it waits for that transaction and copies what
      it committed. FOR NO KEY UPDATE is the lock an UPDATE of the appointment takes, and the
      one the insert's own touch of its appointment (trg_appointment_participant_touch) took
      anyway, only later: it doesn't conflict with the KEY SHARE locks of foreign-key checks,
      and when the trigger runs from trg_appointment_sync the transaction already holds it.
      Nothing else in the function changes; 0002's definition (sql_0002/10_rules.sql) comes
      back on downgrade.

The chain: 0030 (#463), 0031 (#474) and 0032 (#480) are still open, so this revises 0029. It is
re-parented onto whichever of them merges first, and renumbered only if that touches nothing
already approved.

Revision ID: 0033
Revises: 0029
Create Date: 2026-11-20
"""
from __future__ import annotations

from alembic import op

revision = "0033"
down_revision = "0029"
branch_labels = None
depends_on = None

# 0002's function (sql_0002/10_rules.sql), with the appointment's lock or without it.
_PARTICIPANT_SYNC = """
CREATE OR REPLACE FUNCTION public.shri_participant_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  SELECT ap.start, ap."end", ap.status, ap.ext_overbook, coalesce(t.allow_overlap, false) AS ok
    INTO a FROM appointment ap LEFT JOIN appointment_type t ON t.id = ap.ext_appointment_type_id
   WHERE ap.id = NEW.appointment_id@LOCK@;
  NEW.period_start := a.start;
  NEW.period_end := a."end";
  NEW.ext_blocking := NEW.actor_practitioner_id IS NOT NULL AND a.start IS NOT NULL
                      AND a.status IN ('booked', 'arrived', 'checked-in', 'pending')
                      AND NOT a.ext_overbook AND NOT a.ok AND NEW.status <> 'declined';
  RETURN NEW;
END $$;
"""


def _participant_sync(lock: str) -> str:
    return _PARTICIPANT_SYNC.replace("@LOCK@", lock)


def upgrade() -> None:
    op.execute(_participant_sync(" FOR NO KEY UPDATE OF ap"))


def downgrade() -> None:
    op.execute(_participant_sync(""))
