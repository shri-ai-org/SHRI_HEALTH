"""The live status board's events (EVENTS.md §4, each operation's x-events), against a live
database: each write publishes its event through core's publish() in the same transaction, with
the facility and patient core's stream filters on, and IDs and statuses only in `data`. A refused
write publishes nothing. Synthetic data only."""

from __future__ import annotations

from typing import Any

import pytest

from app.db.tests.conftest import TEST_DATABASE_URL

from .conftest import Practice, local
from .test_check_in_live import _check_in, _coverage, _sql, _today_appointment
from .test_scheduling_live import _book, _booking

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
# What `data` may carry: IDs, enum statuses and the start time (EVENTS.md §2); never a name.
ALLOWED_DATA = {"appointmentId", "patientId", "providerId", "facilityId", "encounterId", "start",
                "status", "reasonCode"}


def _events(practice: Practice, subject: str) -> list[tuple[str, dict[str, Any], Any, Any]]:
    rows = _sql(practice, "SELECT type, data, facility_id, patient_id FROM admin.event_log "
                "WHERE subject = :s ORDER BY created_at, id", s=subject)
    for _, data, _, _ in rows:
        assert set(data) <= ALLOWED_DATA, set(data) - ALLOWED_DATA
    return [tuple(r) for r in rows]


def test_booking_publishes_appointment_booked(client: Any, practice: Practice) -> None:
    made = _book(client, practice)
    [(kind, data, facility, patient)] = _events(practice, f"appointment/{made['id']}")
    assert kind == "appointment.booked"
    assert (facility, patient) == (practice.facility, practice.patients["kaia"])
    assert data == {"appointmentId": made["id"], "patientId": str(practice.patients["kaia"]),
                    "providerId": str(practice.provider), "facilityId": str(practice.facility),
                    "start": data["start"]}
    assert "Kaia" not in str(data) and "Lindgren" not in str(data)


def test_a_refused_booking_publishes_nothing(client: Any, practice: Practice) -> None:
    _book(client, practice)
    before = _sql(practice, "SELECT count(*) FROM admin.event_log")[0][0]
    taken = client("fd").post(f"{API}/appointments", json=_booking(practice, "marcus", minute=10))
    assert taken.status_code == 409  # the change and its event roll back together
    assert _sql(practice, "SELECT count(*) FROM admin.event_log")[0][0] == before


def test_reschedule_and_cancel_publish_their_events(client: Any, practice: Practice) -> None:
    old = _book(client, practice)
    moved = client("fd").post(f"{API}/appointments/{old['id']}/reschedule", json={
        "startAt": local(practice.day, 11), "reasonCode": "patient-request"})
    assert moved.status_code == 201, moved.text
    new = moved.json()["id"]
    assert [e[0] for e in _events(practice, f"appointment/{new}")] == ["appointment.rescheduled"]
    cancelled = client("fd").post(f"{API}/appointments/{new}/cancel",
                                  json={"reasonCode": "patient-request"})
    assert cancelled.status_code in (200, 204), cancelled.text
    events = _events(practice, f"appointment/{new}")
    assert [e[0] for e in events] == ["appointment.rescheduled", "appointment.cancelled"]
    assert events[1][1]["reasonCode"] == "patient-request"
    assert events[1][2] == practice.facility


def test_check_in_and_undo_publish_their_events(client: Any, practice: Practice) -> None:
    _coverage(practice)
    appointment = _today_appointment(practice)
    checked = _check_in(client, appointment)
    assert checked.status_code == 200, checked.text
    encounter = checked.json()["encounterId"]
    undone = client("fd").post(f"{API}/appointments/{appointment}/undo-check-in",
                               json={"reason": "Checked in the wrong patient."})
    assert undone.status_code == 200, undone.text
    events = _events(practice, f"appointment/{appointment}")
    assert [(e[0], e[1].get("status")) for e in events] == [
        ("appointment.checked-in", "checked-in"), ("appointment.status-changed", "booked")]
    assert events[0][1]["encounterId"] == encounter
    assert all(e[2] == practice.facility for e in events)
    [(kind, data, _, _)] = _events(practice, f"encounter/{encounter}")
    assert (kind, data["appointmentId"]) == ("encounter.entered-in-error", appointment)
