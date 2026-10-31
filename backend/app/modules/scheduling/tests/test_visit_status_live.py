"""Visit steps (recordVisitStatus) against a live database, as shri_app, with core's tenant_db,
facility filter, audit and events, and Anand's encounter helpers running for real: arrived,
roomed (the encounter triaged and in the room, shown on the status board), with provider and
no-show (DATA_OWNERSHIP §5.1, §5.2; demo step 7). Appointments are written directly at a fixed
wall-clock time, because booking through the API depends on the time the tests run. Synthetic
data only."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

from app.db.models import MAPPERS
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url

from .conftest import ZONE, Practice, setup_session
from .test_check_in_live import _check_in, _code, _sql, _today_appointment

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
M = MAPPERS


def _appointment_on(practice: Practice, day: dt.date, hour: int, patient: str = "kaia") -> str:
    """A booked appointment at the facility, on that local day and hour."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        start = dt.datetime.combine(day, dt.time(hour), ZoneInfo(ZONE))
        appt = M["appointment"](
            tenant_id=practice.clinic, status="booked", start=start,
            end=start + dt.timedelta(minutes=20), minutes_duration=20,
            subject_patient_id=practice.patients[patient],
            ext_appointment_type_id=practice.types["FU"], ext_facility_id=practice.facility)
        appt.participant = [
            M["appointment_participant"](actor_patient_id=practice.patients[patient],
                                         status="accepted"),
            M["appointment_participant"](actor_practitioner_id=practice.provider,
                                         status="accepted")]
        db.add(appt)
        db.flush()
        appointment_id = str(appt.id)
        db.commit()
        return appointment_id
    finally:
        db.close()
        admin.dispose()


def _status(client: Any, appointment_id: str, user: str = "ma", **body: Any) -> Any:
    return client(user).post(f"{API}/appointments/{appointment_id}/status", json=body)


def _board(client: Any, practice: Practice) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = client("ma").get(f"{API}/status-board", params={
        "facilityId": str(practice.facility), "view": "staff"}).json()["items"]
    return items


def test_rooming_triages_the_encounter_and_shows_on_the_board(client: Any,
                                                              practice: Practice) -> None:
    appointment = _today_appointment(practice)
    encounter = _check_in(client, appointment, selfPay=True).json()["encounterId"]
    roomed = _status(client, appointment, status="roomed", roomLocationId=str(practice.room))
    assert roomed.status_code == 200, roomed.text
    body = roomed.json()
    assert body["status"] == "checked-in" and body["visitStatus"] == "roomed"
    assert body["encounterId"] == encounter and roomed.headers["ETag"].startswith('"')
    assert _sql(practice, "SELECT status FROM clinical.encounter WHERE id = :e",
                e=encounter)[0][0] == "triaged"
    assert [tuple(r) for r in _sql(
        practice, "SELECT location_id, status FROM clinical.encounter_location "
        "WHERE encounter_id = :e", e=encounter)] == [(practice.room, "active")]
    board = _board(client, practice)
    assert [(b["visitStatus"], b["roomName"]) for b in board] == [("roomed", "Exam 1")]
    # Only the visit-step events: check-in publishes its own (appointment.checked-in, live board).
    events = _sql(practice, "SELECT type FROM admin.event_log WHERE subject IN (:a, :e) "
                  "AND type LIKE '%.status-changed' ORDER BY type",
                  a=f"appointment/{appointment}", e=f"encounter/{encounter}")
    assert [r[0] for r in events] == ["appointment.status-changed", "encounter.status-changed"]
    audit = _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE entity_id = :a "
                 "AND patient_id = :p AND action = 'update'", a=appointment,
                 p=practice.patients["kaia"])
    assert audit[0][0] >= 2  # check-in and rooming

    again = _status(client, appointment, status="roomed", roomLocationId=str(practice.room))
    assert again.status_code == 200  # a second roomed is allowed (A42)
    with_provider = _status(client, appointment, "md", status="with-provider")
    assert with_provider.status_code == 200, with_provider.text
    assert with_provider.json()["visitStatus"] == "with-provider"
    assert _sql(practice, "SELECT status FROM clinical.encounter WHERE id = :e",
                e=encounter)[0][0] == "in-progress"
    assert [b["visitStatus"] for b in _board(client, practice)] == ["with-provider"]
    late = _status(client, appointment, status="roomed", roomLocationId=str(practice.room))
    assert late.status_code == 409 and late.json()["currentState"] == "in-progress"


def test_visit_steps_are_refused(client: Any, practice: Practice) -> None:
    appointment = _today_appointment(practice)
    room = {"status": "roomed", "roomLocationId": str(practice.room)}
    assert _status(client, appointment, "none", **room).status_code == 403
    assert _status(client, appointment, "dsp", **room).status_code == 403
    assert _status(client, appointment, "fd-b", **room).status_code == 404
    bad = _status(client, appointment, status="seen")
    assert bad.status_code == 422 and _code(bad) == "validation-failed"
    assert _status(client, appointment, status="roomed", extra=1).status_code == 422
    not_yet = _status(client, appointment, **room)
    assert not_yet.status_code == 409 and not_yet.json()["currentState"] == "booked"
    _check_in(client, appointment, selfPay=True)
    no_room = _status(client, appointment, status="roomed")
    assert no_room.status_code == 422 and no_room.json()["errors"][0] == {
        "in": "body", "pointer": "/roomLocationId", "code": "required"}
    elsewhere = _status(client, appointment, status="roomed", roomLocationId=str(uuid.uuid4()))
    assert elsewhere.status_code == 422 and _code(elsewhere) == "business-rule-violation"
    assert elsewhere.json()["errors"][0]["code"] == "invalid-reference"
    stray = _status(client, appointment, "md", status="with-provider",
                    roomLocationId=str(practice.room))
    assert stray.status_code == 422 and stray.json()["errors"][0]["code"] == "conflicting-fields"
    wrong_role = _status(client, appointment, "md", **room)  # MD doesn't room (§5.2)
    assert wrong_role.status_code == 403 and _code(wrong_role) == "permission-denied"
    assert _sql(practice, "SELECT count(*) FROM admin.visit_flow_event WHERE appointment_id = "
                ":a AND step = 'roomed'", a=UUID(appointment))[0][0] == 0
    assert _sql(practice, "SELECT e.status FROM clinical.encounter e WHERE e.appointment_id = "
                ":a", a=UUID(appointment))[0][0] == "arrived"
    out = _status(client, appointment, "fd", status="checked-out")
    assert out.status_code == 409 and _code(out) == "invalid-state-transition"
    assert out.json()["errors"][0]["pointer"] == "/status"


def test_arrived_then_check_in(client: Any, practice: Practice) -> None:
    appointment = _today_appointment(practice, "marcus")
    arrived = _status(client, appointment, "fd", status="arrived")
    assert arrived.status_code == 200, arrived.text
    assert arrived.json()["status"] == "arrived" and arrived.json()["visitStatus"] == "arrived"
    twice = _status(client, appointment, "fd", status="arrived")
    assert twice.status_code == 409 and twice.json()["currentState"] == "arrived"
    assert _check_in(client, appointment, selfPay=True).status_code == 200
    later = _appointment_on(practice, practice.day, 10)
    future = _status(client, later, "fd", status="arrived")
    assert future.status_code == 422 and future.json()["errors"][0] == {
        "in": "path", "name": "appointmentId", "code": "out-of-range"}


def test_no_show_only_after_the_start(client: Any, practice: Practice) -> None:
    future = _appointment_on(practice, practice.day, 11)
    early = _status(client, future, "fd", status="noshow")
    assert early.status_code == 422 and early.json()["errors"][0] == {
        "in": "body", "pointer": "/status", "code": "out-of-range"}
    yesterday = dt.datetime.now(ZoneInfo(ZONE)).date() - dt.timedelta(days=1)
    missed = _appointment_on(practice, yesterday, 9, "marcus")
    done = _status(client, missed, "fd", status="noshow")
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "noshow"
    assert _sql(practice, "SELECT status FROM clinical.appointment WHERE id = :a",
                a=UUID(missed))[0][0] == "noshow"
