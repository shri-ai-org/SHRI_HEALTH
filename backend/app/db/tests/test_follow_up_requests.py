"""Migration 0010: the follow-up request on the encounter (D98, A52).

Every test runs as shri_app (SET ROLE from the superuser URL, see conftest.py), with forced
row-level security in force. Synthetic data only.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.db.models import MAPPERS
from app.db.tests import builders as b
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant, open_session
from app.db.tests.test_db_rules import fails

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS


def _visit(db: Session) -> dict[str, Any]:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx, status="finished")
    return {"ctx": ctx, "pt": pt, "enc": enc}


def _appointment(db: Session, pt: Any, days: int = 14) -> Any:
    appt = M["appointment"](status="booked", subject_patient_id=pt.id,
                            start=b.NOW + dt.timedelta(days=days),
                            end=b.NOW + dt.timedelta(days=days, minutes=20))
    db.add(appt)
    db.flush()
    return appt


def _ask(db: Session, v: dict[str, Any], **kw: Any) -> Any:
    fu = M["encounter_follow_up"](encounter_id=v["enc"].id, patient_id=v["pt"].id,
                                  interval_value=2, interval_unit="week",
                                  requested_by_user_id=v["ctx"]["user"].id, **kw)
    db.add(fu)
    db.flush()
    return fu


def _version(db: Session, enc: Any) -> int:
    return int(db.execute(text("SELECT meta_version_id FROM clinical.encounter WHERE id = :e"),
                          {"e": enc.id}).scalar_one())


def test_a_request_moves_the_encounters_version_and_is_in_its_history(db: Session) -> None:
    v = _visit(db)
    db.commit()
    before = _version(db, v["enc"])
    fu = _ask(db, v, note="Recheck blood pressure")
    db.commit()
    assert _version(db, v["enc"]) == before + 1                  # the ETag decline checks
    fu.interval_value = 3
    db.commit()
    assert _version(db, v["enc"]) == before + 2
    snaps = db.execute(text(
        "SELECT snapshot -> '_children' -> 'encounter_follow_up' -> 0 ->> 'interval_value' "
        "FROM clinical.fhir_resource_history WHERE resource_type = 'Encounter' "
        "AND resource_id = :e ORDER BY version_id"), {"e": v["enc"].id}).scalars().all()
    assert snaps[-2:] == ["2", "3"]


def test_one_request_per_visit(db: Session) -> None:
    v = _visit(db)
    _ask(db, v)
    with fails(db, "23505", "uq_encounter_follow_up_encounter_id"):
        _ask(db, v)


def test_booking_cancelling_and_rescheduling_the_revisit(db: Session) -> None:
    v = _visit(db)
    fu = _ask(db, v)
    first, second = _appointment(db, v["pt"]), _appointment(db, v["pt"], days=15)
    fu.status, fu.booked_appointment_id = "booked", first.id
    db.flush()
    fu.booked_appointment_id = second.id                          # rescheduled
    db.flush()
    fu.status, fu.booked_appointment_id = "open", None             # cancelled
    db.flush()
    with fails(db, "23514", "ck_encounter_follow_up_booked_has_appointment"):
        fu.status = "booked"
        db.flush()


def test_a_booked_revisit_is_the_same_patients(db: Session) -> None:
    v = _visit(db)
    fu = _ask(db, v)
    other = _appointment(db, b.patient(db, "Okafor", "Ada"))
    with fails(db, "23503", "fk_encounter_follow_up_booked_appointment_id_same_patient"):
        fu.status, fu.booked_appointment_id = "booked", other.id
        db.flush()


def test_a_request_belongs_to_the_visits_patient(db: Session) -> None:
    v = _visit(db)
    with fails(db, "23503", "fk_encounter_follow_up_encounter_id_same_patient"):
        db.add(M["encounter_follow_up"](
            encounter_id=v["enc"].id, patient_id=b.patient(db, "Okafor", "Ada").id,
            interval_value=1, interval_unit="month",
            requested_by_user_id=v["ctx"]["user"].id))
        db.flush()


@pytest.mark.parametrize("status", ["declined", "withdrawn"])
def test_a_decline_or_withdrawal_needs_a_reason_and_is_final(db: Session, status: str) -> None:
    v = _visit(db)
    fu = _ask(db, v)
    for reason in (None, "  "):
        with fails(db, "23514", "ck_encounter_follow_up_reason_matches_status"):
            fu.status, fu.status_reason = status, reason
            db.flush()
    fu.status, fu.status_reason = status, "Will call to book"
    db.flush()
    for change in ({"status": "open", "status_reason": None}, {"note": "changed"}):
        with fails(db, "P0001", message="no longer changes"):
            for k, val in change.items():
                setattr(fu, k, val)
            db.flush()


def test_an_open_request_has_no_reason(db: Session) -> None:
    v = _visit(db)
    with fails(db, "23514", "ck_encounter_follow_up_reason_matches_status"):
        _ask(db, v, status_reason="Not yet")


def test_only_an_open_request_changes_what_was_asked(db: Session) -> None:
    v = _visit(db)
    fu = _ask(db, v)
    fu.interval_value, fu.note = 6, "Six weeks instead"             # a PUT replaces it
    db.flush()
    fu.status, fu.booked_appointment_id = "booked", _appointment(db, v["pt"]).id
    db.flush()
    with fails(db, "P0001", message="can no longer change"):
        fu.interval_value = 1
        db.flush()
    with fails(db, "P0001", message="cannot go from booked to declined"):
        fu.status, fu.booked_appointment_id, fu.status_reason = "declined", None, "No"
        db.flush()


def test_the_visit_and_patient_of_a_request_never_change(db: Session) -> None:
    v, w = _visit(db), None
    fu = _ask(db, v)
    w = b.encounter(db, v["pt"], v["ctx"], status="finished")
    with fails(db, "P0001", message="is fixed once created"):
        fu.encounter_id = w.id
        db.flush()


def test_requests_are_never_deleted_and_stay_in_their_clinic(
        db: Session, app_engine: Engine, admin_engine: Engine) -> None:
    v = _visit(db)
    _ask(db, v)
    db.commit()
    with fails(db, "42501"):
        db.execute(text("DELETE FROM clinical.encounter_follow_up"))
    other = open_session(app_engine, make_tenant(admin_engine))
    try:
        assert other.execute(text("SELECT count(*) FROM clinical.encounter_follow_up")
                             ).scalar_one() == 0
    finally:
        conn = other.bind
        other.close()
        conn.close()  # type: ignore[union-attr]


def test_fhir_does_not_serve_the_request(db: Session) -> None:
    from app.fhir.serializer import to_fhir

    v = _visit(db)
    _ask(db, v, note="Recheck blood pressure")
    db.refresh(v["enc"])
    assert "Recheck" not in str(to_fhir(v["enc"]))
