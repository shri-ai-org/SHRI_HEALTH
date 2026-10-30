"""Check-out and the visit's follow-up request against a live database (D98; demo steps 10-11), as
shri_app, with core's tenant_db, facility filter, chart check, audit, events and idempotency
running for real: the request shown on the appointment and the staff board, the revisit booked
from it (and cancelled, and rescheduled, in the same transaction), the decline, and check-out
with its 409s. checkOutAppointment and declineFollowUpRequest wait for core's T50 permissions;
``pending_client`` grants them as T50 proposes (pending_permissions.py). Synthetic data only."""

from __future__ import annotations

import uuid
from typing import Any
from uuid import UUID

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL

from .conftest import Practice, local
from .test_check_in_live import _key, _sql, _today_appointment
from .test_check_in_live import checked_in_visit as _visit

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
ASK = {"interval": {"value": 3, "unit": "month"}, "note": "Recheck blood pressure."}


def _etag(client: Any, encounter: str) -> str:
    """The encounter's ETag, read by the clinician (the front desk has no encounters:read)."""
    tag: str = client("md").get(f"{API}/encounters/{encounter}").headers["ETag"]
    return tag


def _ask(client: Any, practice: Practice, encounter: str) -> dict[str, Any]:
    body = {**ASK, "appointmentTypeId": str(practice.types["FU"]),
            "providerId": str(practice.provider)}
    done = client("md").put(f"{API}/encounters/{encounter}/follow-up", json=body,
                            headers={"If-Match": _etag(client, encounter)})
    assert done.status_code == 200, done.text
    result: dict[str, Any] = done.json()
    return result


def _revisit(client: Any, practice: Practice, encounter: str, hour: int = 10,
             patient: str = "kaia") -> Any:
    return client("fd").post(f"{API}/appointments", json={
        "patientId": str(practice.patients[patient]), "providerId": str(practice.provider),
        "facilityId": str(practice.facility), "appointmentTypeId": str(practice.types["FU"]),
        "startAt": local(practice.day, hour), "reasonForVisit": "Recheck blood pressure.",
        "followUpOfEncounterId": encounter})


def _check_out(client: Any, appointment: str, user: str = "fd", **headers: str) -> Any:
    return client(user).post(f"{API}/appointments/{appointment}/check-out", headers=headers)


def _follow_up(client: Any, appointment: str) -> dict[str, Any]:
    found: dict[str, Any] = client("fd").get(f"{API}/appointments/{appointment}").json()
    follow_up: dict[str, Any] = found["followUp"]
    return follow_up


def _pointers(response: Any) -> list[str]:
    return [e["pointer"] for e in response.json()["errors"]]


# ------------------------------------------------------------------------------- check-out
def test_check_out_waits_for_the_follow_up_until_the_revisit_is_booked(
        pending_client: Any, practice: Practice) -> None:
    client = pending_client
    appointment, encounter = _visit(client, practice)
    asked = _ask(client, practice, encounter)
    assert asked["status"] == "open"
    seen = _follow_up(client, appointment)  # the front desk sees it without encounters:read
    assert seen == {"encounterId": encounter, "interval": {"value": 3, "unit": "month"},
                    "appointmentTypeId": str(practice.types["FU"]),
                    "providerId": str(practice.provider), "note": "Recheck blood pressure.",
                    "status": "open"}
    board = client("fd").get(f"{API}/status-board", params={
        "facilityId": str(practice.facility), "view": "staff"}).json()["items"]
    assert board[0]["followUp"]["status"] == "open"
    shared = client("dsp").get(f"{API}/status-board", params={
        "facilityId": str(practice.facility), "view": "staff"}).json()["items"]
    assert "followUp" not in shared[0]  # D47: never on a shared screen
    blocked = _check_out(client, appointment)
    assert blocked.status_code == 409 and blocked.json()["code"] == "invalid-state-transition"
    assert _pointers(blocked) == ["/followUp"] and blocked.json()["currentState"] == "checked-in"
    revisit = _revisit(client, practice, encounter)
    assert revisit.status_code == 201, revisit.text
    booked = _follow_up(client, appointment)
    assert booked["status"] == "booked" and booked["bookedAppointmentId"] == revisit.json()["id"]
    key = _key()
    done = _check_out(client, appointment, **key)
    assert done.status_code == 200, done.text
    out = done.json()
    assert out["status"] == "fulfilled" and out["visitStatus"] == "checked-out"
    assert out["followUp"]["status"] == "booked"
    replayed = _check_out(client, appointment, **key)  # the same key replays the first answer
    assert replayed.status_code == 200 and replayed.json() == out
    again = _check_out(client, appointment)
    assert again.status_code == 409 and _pointers(again) == ["/status"]
    assert again.json()["currentState"] == "fulfilled"
    assert _sql(practice, "SELECT count(*) FROM admin.visit_flow_event WHERE appointment_id = :a "
                "AND step = 'checked-out'", a=appointment)[0][0] == 1
    events = _sql(practice, "SELECT type FROM admin.event_log WHERE subject = :s ORDER BY type",
                  s=f"appointment/{appointment}")
    assert {"appointment.checked-out", "appointment.status-changed"} <= {e[0] for e in events}
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE entity_id = :a "
                "AND patient_id = :p", a=appointment, p=practice.patients["kaia"])[0][0] >= 1


def test_a_declined_follow_up_lets_the_patient_check_out(pending_client: Any,
                                                        practice: Practice) -> None:
    client = pending_client
    appointment, encounter = _visit(client, practice)
    _ask(client, practice, encounter)
    path = f"{API}/encounters/{encounter}/follow-up/decline"
    body = {"reason": "Patient will call to book."}
    tag = {"If-Match": _etag(client, encounter)}
    assert client("md").post(path, json=body, headers=tag).status_code == 403  # D67
    assert client("fd").post(path, json=body).status_code == 428
    assert client("fd").post(path, json={"reason": ""}, headers=tag).status_code == 422
    assert client("fd").post(path, json=body, headers={"If-Match": '"1"'}).status_code == 412
    declined = client("fd").post(path, json=body, headers={**tag, **_key()})
    assert declined.status_code == 200, declined.text
    assert declined.json()["status"] == "declined"
    assert declined.json()["declinedReason"] == "Patient will call to book."
    assert _sql(practice, "SELECT status, status_reason FROM clinical.encounter_follow_up "
                "WHERE encounter_id = :e", e=encounter)[0] == ("declined",
                                                               "Patient will call to book.")
    fresh = {"If-Match": _etag(client, encounter)}  # read first: the client is shared
    twice = client("fd").post(path, json=body, headers=fresh)
    assert twice.status_code == 409 and twice.json()["currentState"] == "declined"
    assert _follow_up(client, appointment)["status"] == "declined"
    assert _check_out(client, appointment).status_code == 200


def test_check_out_refusals(pending_client: Any, practice: Practice) -> None:
    client = pending_client
    booked = _today_appointment(practice, hour=9)
    not_in = _check_out(client, booked)
    assert not_in.status_code == 409 and _pointers(not_in) == ["/status"]
    assert not_in.json()["currentState"] == "booked"
    appointment, _ = _visit(client, practice, "marcus")
    for user in ("md", "ma", "rn", "bil", "none"):  # D98: front desk and ADM only
        assert _check_out(client, appointment, user).status_code == 403, user
    assert _check_out(client, appointment, "fd-b").status_code == 404  # another clinic
    assert _check_out(client, str(uuid.uuid4())).status_code == 404
    bad = client("fd").post(f"{API}/appointments/nope/check-out")
    assert bad.status_code == 422 and bad.json()["code"] == "validation-failed"
    elsewhere = _today_appointment(practice, "kaia", facility=practice.other_facility, hour=15)
    assert _check_out(client, elsewhere).status_code == 404  # not the user's facility
    assert _check_out(client, appointment, "adm").status_code == 200


def test_a_restricted_chart_checks_out_without_break_glass(
        pending_client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    """As check-in (T16): the front desk checks a restricted patient out; the follow-up's note,
    clinical text, is left out (D60), and its decline needs chart access (D37)."""
    client = pending_client
    appointment, encounter = _visit(client, practice, "restricted")
    _sql(practice, "INSERT INTO clinical.encounter_follow_up (id, tenant_id, encounter_id, "
         "patient_id, interval_value, interval_unit, note, requested_by_user_id) VALUES "
         "(:id, :t, :e, :p, 2, 'week', 'Sensitive note.', :u)", id=uuid.uuid4(),
         t=practice.clinic, e=encounter,
         p=practice.patients["restricted"], u=users["md"].id)
    seen = _follow_up(client, appointment)
    assert seen["status"] == "open" and "note" not in seen
    decline = client("fd").post(f"{API}/encounters/{encounter}/follow-up/decline",
                                json={"reason": "Will call."}, headers={"If-Match": '"1"'})
    assert decline.status_code == 403 and decline.json()["code"] == "break-glass-required"
    revisit = _revisit(client, practice, encounter, patient="restricted")  # booking: T16
    assert revisit.status_code == 201, revisit.text
    done = _check_out(client, appointment)
    assert done.status_code == 200, done.text
    assert done.json()["followUp"]["status"] == "booked" and "note" not in done.json()["followUp"]


# ------------------------------------------------------- the revisit: book, cancel, reschedule
def test_the_revisit_books_cancels_and_reschedules_the_request(pending_client: Any,
                                                              practice: Practice) -> None:
    client = pending_client
    appointment, encounter = _visit(client, practice)
    _ask(client, practice, encounter)
    version = _etag(client, encounter)
    revisit = _revisit(client, practice, encounter)
    assert revisit.status_code == 201, revisit.text
    assert _etag(client, encounter) != version  # the request moved the encounter's version
    twice = _revisit(client, practice, encounter, hour=11)  # no longer open
    assert twice.status_code == 422
    assert twice.json()["errors"][0]["pointer"] == "/followUpOfEncounterId"
    moved = client("fd").post(f"{API}/appointments/{revisit.json()['id']}/reschedule", json={
        "startAt": local(practice.day, 14), "reasonCode": "patient-request"})
    assert moved.status_code == 201, moved.text
    follow_up = _follow_up(client, appointment)
    assert follow_up["status"] == "booked"
    assert follow_up["bookedAppointmentId"] == moved.json()["id"]  # points at the new one
    cancelled = client("fd").post(f"{API}/appointments/{moved.json()['id']}/cancel",
                                  json={"reasonCode": "patient-request"})
    assert cancelled.status_code == 200, cancelled.text
    reopened = _follow_up(client, appointment)
    assert reopened["status"] == "open" and "bookedAppointmentId" not in reopened
    assert _revisit(client, practice, encounter, hour=15).status_code == 201  # open again
    history = _sql(practice, "SELECT count(*) FROM clinical.fhir_resource_history WHERE "
                   "resource_type = 'Encounter' AND resource_id = :e", e=encounter)[0][0]
    assert history >= 5  # check-in, the request, booked, moved, reopened, booked again


def test_a_revisit_must_book_an_open_request_of_the_same_patient(pending_client: Any,
                                                                practice: Practice) -> None:
    client = pending_client
    _, encounter = _visit(client, practice)
    no_request = _revisit(client, practice, encounter)
    assert no_request.status_code == 422
    assert no_request.json()["errors"] == [{"in": "body", "pointer": "/followUpOfEncounterId",
                                            "code": "invalid-reference"}]
    _ask(client, practice, encounter)
    other = _revisit(client, practice, encounter, patient="marcus")
    assert other.status_code == 422  # someone else's visit
    unknown = _revisit(client, practice, str(uuid.uuid4()))
    assert unknown.status_code == 422
    assert _sql(practice, "SELECT count(*) FROM clinical.appointment WHERE "
                "subject_patient_id = :p", p=practice.patients["marcus"])[0][0] == 0
    assert _sql(practice, "SELECT status FROM clinical.encounter_follow_up WHERE "
                "encounter_id = :e", e=UUID(encounter))[0][0] == "open"
