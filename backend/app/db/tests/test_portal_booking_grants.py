"""Migration 0021: what the patient portal's self-booking writes beyond 0011 (Vimal's list on #85,
#288), and the cancel and reschedule exactly as the portal sends them, as shri_portal (SET ROLE,
see conftest.py) with the clinic and the session patient set. Synthetic data only."""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import Connection, Engine, text

from app.db.models import systems
from app.db.tests.test_portal_access import (
    DENIED,
    _as_patient,
    _book,
    _refused,
    chart,
    portal_engine,
)
from app.db.tests.test_portal_access import pytestmark as pytestmark  # noqa: PLC0414

__all__ = ["chart", "portal_engine"]       # fixtures, used by name
REVISIT_LOCKED = "P0001"
#: What scheduling's repository.cancel sets (#288), with no staff user in a portal session.
PORTAL_CANCEL = ("UPDATE clinical.appointment SET status = 'cancelled', "
                 f"cancelation_reason_system = '{systems.SHRI_LOCAL}', cancelation_reason_code = "
                 "'patient-cancelled', cancelation_reason_text = 'Feeling better', "
                 "ext_cancelled_at = now() WHERE id = :a")


def _event(c: Connection, chart: dict[str, Any], who: str, kind: str) -> None:
    c.execute(text("INSERT INTO admin.event_log (id, tenant_id, patient_id, type, subject, data) "
                   "VALUES (:i, :t, :p, :k, 'appointment', '{}')"),
              {"i": uuid.uuid4(), "t": chart["tenant"], "p": chart[who]["pt"].id, "k": kind})


def test_a_portal_booking_emits_only_its_own_schedule_events(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        for kind in ("appointment.booked", "appointment.cancelled", "appointment.rescheduled"):
            _event(c, chart, "me", kind)
    with portal_engine.connect() as c:
        _as_patient(c, chart)
        for who, kind in (("other", "appointment.booked"),       # someone else's
                          ("me", "appointment.checked-in")):     # not a portal event
            savepoint = c.begin_nested()
            try:
                _event(c, chart, who, kind)
                raise AssertionError(f"{who} {kind} was accepted")
            except Exception as err:  # noqa: BLE001 - the policy refuses with 42501
                assert getattr(getattr(err, "orig", None), "sqlstate", "") == DENIED, err
            savepoint.rollback()
        assert _refused(c, "SELECT count(*) FROM admin.event_log") == DENIED      # write-only
        assert _refused(c, "DELETE FROM admin.event_log") == DENIED
        c.rollback()


def test_the_chart_guard_says_whether_the_session_chart_is_open(
        portal_engine: Engine, chart: dict[str, Any], admin_engine: Engine) -> None:
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert c.execute(text("SELECT admin.portal_chart_open()")).scalar_one() is True
    with admin_engine.begin() as c:                  # the chart is merged away (D103)
        c.execute(text("UPDATE clinical.patient SET active = false WHERE id = :p"),
                  {"p": chart["me"]["pt"].id})
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert c.execute(text("SELECT admin.portal_chart_open()")).scalar_one() is False
        c.execute(text("SELECT set_config('app.current_patient_id', '', true)"))
        assert c.execute(text("SELECT admin.portal_chart_open()")).scalar_one() is False


def test_the_portal_cancels_its_own_booking_and_never_a_booked_revisit(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    with portal_engine.begin() as c:
        _as_patient(c, chart, "other")
        theirs = _book(c, chart, "other", hours=96)
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        mine, revisit = _book(c, chart), _book(c, chart, hours=120)
    s = chart["s"]                                   # the clinic books the revisit (D98)
    s.execute(text("INSERT INTO clinical.encounter_follow_up (id, tenant_id, encounter_id, "
                   "patient_id, interval_value, interval_unit, status, requested_by_user_id, "
                   "requested_at, booked_appointment_id) SELECT gen_random_uuid(), e.tenant_id, "
                   "e.id, e.subject_patient_id, 2, 'week', 'booked', :u, now(), :a "
                   "FROM clinical.encounter e WHERE e.id = :e"),
              {"e": chart["me"]["enc"].id, "a": revisit,
               "u": chart["ctx"]["user"].id})
    s.commit()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        c.execute(text(PORTAL_CANCEL), {"a": mine})
        assert _refused(c, PORTAL_CANCEL, {"a": revisit}) == REVISIT_LOCKED
        # Not another patient's (0011's own-row policy: nothing to update).
        assert c.execute(text(PORTAL_CANCEL), {"a": theirs}).rowcount == 0
        assert _refused(c, "DELETE FROM clinical.appointment WHERE id = :a", {"a": mine}) \
            == DENIED
    # The clinic still moves its revisit (the guard is for shri_portal only).
    s.execute(text("UPDATE clinical.appointment SET status = 'cancelled', ext_cancelled_at = "
                   "now() WHERE id = :a"), {"a": revisit})
    s.rollback()


def test_a_staff_booking_cancelled_from_the_portal_keeps_who_last_changed_it(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    """Found reproducing #288's cancel: scheduling's repository.cancel also sets
    updated_by_user_id from the session's user, NULL in a portal session, so on a booking the
    front desk made the UPDATE names that column and shri_portal is refused. No grant: the
    portal's cancel should leave the staff columns alone (the version's history records the
    patient). Note to Vimal."""
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        staff_booked = _book(c, chart)
    s = chart["s"]
    s.execute(text("UPDATE clinical.appointment SET updated_by_user_id = :u WHERE id = :a"),
              {"u": chart["ctx"]["user"].id, "a": staff_booked})
    s.commit()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert _refused(c, PORTAL_CANCEL.replace(
            "ext_cancelled_at = now()", "ext_cancelled_at = now(), updated_by_user_id = NULL"),
            {"a": staff_booked}) == DENIED
        c.execute(text(PORTAL_CANCEL), {"a": staff_booked})      # without it: allowed



def test_the_portal_reschedules_its_own_booking_and_changes_nothing_else(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    """D61 as the portal sends it: the new booking (pointing at the old one) and the old one
    cancelled, in one transaction. Only the cancel's columns may change, and nothing is
    deleted."""
    with portal_engine.begin() as c:
        _as_patient(c, chart, "other")
        theirs = _book(c, chart, "other", hours=96)
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        old = _book(c, chart)
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        new = uuid.uuid4()
        c.execute(text("INSERT INTO clinical.appointment (id, tenant_id, status, "
                       "subject_patient_id, start, \"end\", meta_security, extension, "
                       "ext_rescheduled_from_appointment_id) VALUES (:n, :t, 'booked', :p, "
                       "now() + interval '6 days', now() + interval '6 days 20 minutes', '{}', "
                       "'[]', :o)"),
                  {"n": new, "t": chart["tenant"], "p": chart["me"]["pt"].id, "o": old})
        c.execute(text("INSERT INTO clinical.appointment_participant (id, tenant_id, "
                       "appointment_id, actor_patient_id, required, status) VALUES "
                       "(gen_random_uuid(), :t, :n, :p, 'required', 'accepted')"),
                  {"t": chart["tenant"], "n": new, "p": chart["me"]["pt"].id})
        c.execute(text(PORTAL_CANCEL.replace("'Feeling better'", "'Rescheduled online'")),
                  {"a": old})
    with portal_engine.connect() as c:
        _as_patient(c, chart)
        rows = {r.id: r.status for r in c.execute(text(
            "SELECT id, status FROM clinical.appointment WHERE id = ANY(:ids)"),
            {"ids": [old, new]})}
        assert rows == {old: "cancelled", new: "booked"}
        for column, value in (("start", "start + interval '1 hour'"),
                              ("subject_patient_id", "subject_patient_id"),
                              ("ext_facility_id", "ext_facility_id"),
                              ("updated_by_user_id", "NULL"),
                              ("ext_rescheduled_from_appointment_id", "id")):
            assert _refused(c, f"UPDATE clinical.appointment SET {column} = {value} "   # noqa: S608
                            "WHERE id = :a", {"a": new}) == DENIED, column
        assert c.execute(text(PORTAL_CANCEL), {"a": theirs}).rowcount == 0   # not theirs
        assert _refused(c, "DELETE FROM clinical.appointment WHERE id = :a", {"a": new}) \
            == DENIED
        assert _refused(c, "DELETE FROM clinical.appointment_participant "
                        "WHERE appointment_id = :a", {"a": new}) == DENIED
        c.rollback()
