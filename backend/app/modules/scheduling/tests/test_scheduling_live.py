"""The scheduling API against a live database, as shri_app, with nothing replaced but the sign-in:
core's tenant_db, facility filter, chart access, audit and idempotency run for real. Each test
gets a fresh practice (conftest.py). Synthetic data only.

Per operation: success; permission denied; validation; another clinic's data → 404; a facility
the user isn't assigned to → 404; and the operation's own rules (booking conflict, hours,
overbook, the 31-day range, the shared board, restricted charts).
"""

from __future__ import annotations

import os
import uuid
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.db.tests.conftest import TEST_DATABASE_URL, sync_url

from .conftest import Practice, local, setup_session

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"


def _booking(p: Practice, patient: str = "kaia", hour: int = 9, minute: int = 0,
             **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "patientId": str(p.patients[patient]), "providerId": str(p.provider),
        "facilityId": str(p.facility), "locationId": str(p.room),
        "appointmentTypeId": str(p.types["FU"]), "startAt": local(p.day, hour, minute),
        "reasonForVisit": "Follow-up on headaches.", "comment": "Prefers mornings.",
    }
    body.update(extra)
    return body


def _book(client: Any, p: Practice, **kw: Any) -> dict[str, Any]:
    made = client("fd").post(f"{API}/appointments", json=_booking(p, **kw))
    assert made.status_code == 201, made.text
    result: dict[str, Any] = made.json()
    return result


def _code(response: Any) -> str:
    code: str = response.json()["code"]
    return code


# ------------------------------------------------------------------ booking reference lists
def test_booking_lists_show_the_users_facilities_only(client: Any, practice: Practice) -> None:
    fd = client("fd")
    facilities = fd.get(f"{API}/booking/facilities").json()["items"]
    assert [f["id"] for f in facilities] == [str(practice.facility)]
    assert facilities[0]["timeZone"] == "America/Chicago"
    locations = fd.get(f"{API}/booking/locations").json()["items"]
    assert [loc["id"] for loc in locations] == [str(practice.room)]
    assert locations[0]["physicalType"] == "ro"
    providers = fd.get(f"{API}/booking/providers").json()["items"]
    assert [pr["id"] for pr in providers] == [str(practice.provider)]
    assert providers[0]["displayName"] == "Dr. Avery401 Lindqvist58"
    assert providers[0]["facilityIds"] == [str(practice.facility)]
    types = fd.get(f"{API}/booking/appointment-types").json()["items"]
    assert {t["code"] for t in types} == {"FU", "NEW", "OB"}
    assert next(t for t in types if t["code"] == "NEW")["defaultDurationMinutes"] == 40
    paged = fd.get(f"{API}/booking/appointment-types", params={"limit": 2}).json()
    assert len(paged["items"]) == 2 and paged["nextCursor"]


def test_booking_lists_refuse_and_scope(client: Any, practice: Practice) -> None:
    assert client("none").get(f"{API}/booking/facilities").status_code == 403
    assert client("dsp").get(f"{API}/booking/providers").status_code == 403  # D47: board only
    other = client("fd").get(f"{API}/booking/locations",
                             params={"facilityId": str(practice.other_facility)})
    assert other.status_code == 404
    assert client("fd").get(f"{API}/booking/providers",
                            params={"facilityId": "not-a-uuid"}).status_code == 422
    # Clinic B sees its own practice only.
    assert client("md-b").get(f"{API}/booking/facilities").json()["items"][0]["id"] == str(
        practice.facility_b)


# ------------------------------------------------------------------------------- free times
def test_free_times_leave_out_booked_ones(client: Any, practice: Practice) -> None:
    params = {"date": practice.day.isoformat(), "facilityId": str(practice.facility),
              "providerId": str(practice.provider), "limit": 100}
    before = client("fd").get(f"{API}/slots", params=params)
    assert before.status_code == 200, before.text
    body = before.json()
    assert body["timeZone"] == "America/Chicago"
    starts = [s["startAt"] for s in body["items"]]
    assert len(starts) == 24 and body["items"][0]["overbook"] is False  # 9:00–17:00, 20 minutes
    _book(client, practice)
    after = client("fd").get(f"{API}/slots", params=params).json()["items"]
    assert len(after) == 23
    new_visits = client("fd").get(f"{API}/slots", params={
        **params, "appointmentTypeId": str(practice.types["NEW"])}).json()["items"]
    assert all(s["endAt"] > s["startAt"] for s in new_visits) and len(new_visits) < 23


def test_free_times_refuse(client: Any, practice: Practice) -> None:
    day = practice.day.isoformat()
    assert client("none").get(f"{API}/slots", params={
        "date": day, "facilityId": str(practice.facility)}).status_code == 403
    assert client("fd").get(f"{API}/slots", params={
        "date": day, "facilityId": str(practice.other_facility)}).status_code == 404
    assert client("fd").get(f"{API}/slots", params={
        "facilityId": str(practice.facility)}).status_code == 422  # no date
    unknown = client("fd").get(f"{API}/slots", params={
        "date": day, "facilityId": str(practice.facility),
        "appointmentTypeId": str(uuid.uuid4())})
    assert unknown.status_code == 422 and _code(unknown) == "validation-failed"


# ---------------------------------------------------------------------------------- booking
def test_book_returns_the_appointment(client: Any, practice: Practice) -> None:
    made = client("fd").post(f"{API}/appointments", json=_booking(practice))
    assert made.status_code == 201, made.text
    a = made.json()
    assert made.headers["Location"] == f"/api/v1/appointments/{a['id']}"
    assert made.headers["ETag"].startswith('"')
    assert a["status"] == "booked" and a["durationMinutes"] == 20
    assert a["patient"] == {"id": str(practice.patients["kaia"]),
                            "displayName": "Kaia401 Lindgren118", "restricted": False}
    assert a["provider"]["displayName"] == "Dr. Avery401 Lindqvist58"
    assert a["appointmentType"]["code"] == "FU" and a["timeZone"] == "America/Chicago"
    assert a["reasonForVisit"] == "Follow-up on headaches." and a["locationId"] == str(
        practice.room)
    assert "visitStatus" not in a and "encounterId" not in a


def test_book_refuses(client: Any, practice: Practice) -> None:
    assert client("ma").post(f"{API}/appointments",
                             json=_booking(practice)).status_code == 403  # D67
    assert client("none").post(f"{API}/appointments", json=_booking(practice)).status_code == 403
    missing = client("fd").post(f"{API}/appointments", json={
        k: v for k, v in _booking(practice).items() if k != "startAt"})
    assert missing.status_code == 422 and _code(missing) == "validation-failed"
    naive = client("fd").post(f"{API}/appointments",
                              json=_booking(practice, startAt="2035-01-08T09:00:00"))
    assert naive.status_code == 422  # a time without its offset
    unknown_field = client("fd").post(f"{API}/appointments", json=_booking(practice, roomId="x"))
    assert unknown_field.status_code == 422
    elsewhere = client("fd").post(f"{API}/appointments", json=_booking(
        practice, facilityId=str(practice.other_facility)))
    assert elsewhere.status_code == 404  # a facility the user isn't assigned to
    stranger = client("fd").post(f"{API}/appointments", json=_booking(
        practice, patientId=str(uuid.uuid4())))
    assert stranger.status_code == 404
    wrong_provider = client("fd").post(f"{API}/appointments", json=_booking(
        practice, providerId=str(practice.other_provider)))
    assert wrong_provider.status_code == 422
    assert wrong_provider.json()["errors"][0] == {
        "in": "body", "pointer": "/providerId", "code": "invalid-reference"}
    after_hours = client("fd").post(f"{API}/appointments", json=_booking(practice, hour=17))
    assert after_hours.status_code == 422 and _code(after_hours) == "business-rule-violation"


def test_a_taken_slot_is_409_and_overbooks_follow_the_type(client: Any,
                                                            practice: Practice) -> None:
    _book(client, practice)
    taken = client("fd").post(f"{API}/appointments", json=_booking(practice, "marcus",
                                                                   minute=10))
    assert taken.status_code == 409 and _code(taken) == "booking-conflict"
    not_allowed = client("fd").post(f"{API}/appointments", json=_booking(
        practice, "marcus", overbook=True))
    assert not_allowed.status_code == 422
    assert not_allowed.json()["errors"][0]["pointer"] == "/overbook"
    ok = client("fd").post(f"{API}/appointments", json=_booking(
        practice, "marcus", overbook=True, appointmentTypeId=str(practice.types["OB"])))
    assert ok.status_code == 201, ok.text
    assert ok.json()["overbook"] is True
    again = client("fd").post(f"{API}/appointments", json=_booking(
        practice, "restricted", overbook=True, appointmentTypeId=str(practice.types["OB"])))
    assert again.status_code == 422  # the type's limit of one is reached


def test_a_merged_patient_cannot_be_booked(client: Any, practice: Practice) -> None:
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    db.execute(text("INSERT INTO clinical.patient_link (id, tenant_id, patient_id, "
                    "other_patient_id, type) VALUES (:i, :t, :p, :o, 'replaced-by')"),
               {"i": uuid.uuid4(), "t": practice.clinic, "p": practice.patients["marcus"],
                "o": practice.patients["kaia"]})
    db.commit()
    db.close()
    admin.dispose()
    merged = client("fd").post(f"{API}/appointments", json=_booking(practice, "marcus"))
    assert merged.status_code == 409 and _code(merged) == "patient-merged"


# ---------------------------------------------------------------------------- one appointment
def test_get_one_appointment(client: Any, practice: Practice) -> None:
    a = _book(client, practice)
    got = client("ma").get(f"{API}/appointments/{a['id']}")
    assert got.status_code == 200 and got.json()["id"] == a["id"]
    assert got.headers["ETag"].startswith('"')
    assert client("none").get(f"{API}/appointments/{a['id']}").status_code == 403
    assert client("md-b").get(f"{API}/appointments/{a['id']}").status_code == 404
    assert client("fd").get(f"{API}/appointments/{uuid.uuid4()}").status_code == 404
    assert client("fd").get(f"{API}/appointments/not-a-uuid").status_code == 422


def test_another_facilitys_appointment_is_not_found(client: Any, practice: Practice) -> None:
    # The API refuses a booking at A2 for this user, so a booked appointment is moved there.
    a = _book(client, practice)
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.begin() as c:
        c.execute(text("UPDATE clinical.appointment SET ext_facility_id = :f WHERE id = :a"),
                  {"f": practice.other_facility, "a": a["id"]})
    admin.dispose()
    assert client("fd").get(f"{API}/appointments/{a['id']}").status_code == 404
    assert client("fd").post(f"{API}/appointments/{a['id']}/cancel",
                             json={"reasonCode": "patient-request"}).status_code == 404


def test_a_restricted_chart_shows_name_and_appointment_only(client: Any,
                                                            practice: Practice) -> None:
    """SECURITY_MODEL §5.2 rule 2: no break-glass needed to book or view the schedule, but the
    clinical text stays hidden (D60)."""
    a = _book(client, practice, patient="restricted")
    assert a["patient"]["restricted"] is True
    assert "reasonForVisit" not in a and "comment" not in a
    got = client("ma").get(f"{API}/appointments/{a['id']}").json()
    assert got["patient"]["displayName"] == "Elena88 Vasquez512"
    assert "reasonForVisit" not in got


# --------------------------------------------------------------------------- the day and week
def test_list_by_day_by_range_and_by_patient(client: Any, practice: Practice) -> None:
    first = _book(client, practice)
    second = _book(client, practice, patient="marcus", hour=10)
    day = practice.day.isoformat()
    by_day = client("ma").get(f"{API}/appointments", params={"date": day})
    assert by_day.status_code == 200, by_day.text
    assert [a["id"] for a in by_day.json()["items"]] == [first["id"], second["id"]]
    assert by_day.json()["timeZone"] == "America/Chicago"
    week = client("ma").get(f"{API}/appointments", params={
        "dateFrom": day, "dateTo": (practice.day + timedelta(days=6)).isoformat()})
    assert len(week.json()["items"]) == 2
    mine = client("ma").get(f"{API}/appointments", params={
        "patientId": str(practice.patients["marcus"])}).json()["items"]
    assert [a["id"] for a in mine] == [second["id"]]
    booked = client("ma").get(f"{API}/appointments", params={
        "date": day, "status": ["cancelled"]}).json()["items"]
    assert booked == []
    assert client("md-b").get(f"{API}/appointments", params={"date": day}).json()["items"] == []


def test_list_refuses(client: Any, practice: Practice) -> None:
    day = practice.day
    too_long = client("ma").get(f"{API}/appointments", params={
        "dateFrom": day.isoformat(), "dateTo": (day + timedelta(days=31)).isoformat()})
    assert too_long.status_code == 422  # 32 days (D62)
    assert too_long.json()["errors"][0] == {"in": "query", "name": "dateTo",
                                            "code": "out-of-range"}
    ok = client("ma").get(f"{API}/appointments", params={
        "dateFrom": day.isoformat(), "dateTo": (day + timedelta(days=30)).isoformat()})
    assert ok.status_code == 200
    assert client("ma").get(f"{API}/appointments").status_code == 422
    assert client("none").get(f"{API}/appointments",
                              params={"date": day.isoformat()}).status_code == 403
    assert client("ma").get(f"{API}/appointments", params={
        "date": day.isoformat(), "facilityId": str(practice.other_facility)}).status_code == 404


# ------------------------------------------------------------------------- reschedule, cancel
def test_reschedule_cancels_the_old_and_books_the_new(client: Any, practice: Practice) -> None:
    old = _book(client, practice)
    moved = client("fd").post(f"{API}/appointments/{old['id']}/reschedule", json={
        "startAt": local(practice.day, 11), "reasonCode": "patient-request",
        "reasonText": "Work shift moved."})
    assert moved.status_code == 201, moved.text
    new = moved.json()
    assert moved.headers["Location"] == f"/api/v1/appointments/{new['id']}"
    assert new["rescheduledFromId"] == old["id"] and new["status"] == "booked"
    assert new["reasonForVisit"] == "Follow-up on headaches."  # carried over
    was = client("fd").get(f"{API}/appointments/{old['id']}").json()
    assert was["status"] == "cancelled"
    assert was["cancellation"]["reasonCode"] == "patient-request"
    longer = client("fd").post(f"{API}/appointments/{new['id']}/reschedule", json={
        "startAt": local(practice.day, 13), "reasonCode": "visit-type-changed",
        "appointmentTypeId": str(practice.types["NEW"])})
    assert longer.status_code == 201 and longer.json()["durationMinutes"] == 40  # #68


def test_reschedule_refuses(client: Any, practice: Practice) -> None:
    a = _book(client, practice)
    other = _book(client, practice, patient="marcus", hour=12)
    url = f"{API}/appointments/{a['id']}/reschedule"
    assert client("ma").post(url, json={"startAt": local(practice.day, 11),
                                        "reasonCode": "x"}).status_code == 403
    no_reason = client("fd").post(url, json={"startAt": local(practice.day, 11)})
    assert no_reason.status_code == 422
    clash = client("fd").post(url, json={"startAt": local(practice.day, 12),
                                         "reasonCode": "patient-request"})
    assert clash.status_code == 409 and _code(clash) == "booking-conflict"
    still = client("fd").get(f"{API}/appointments/{a['id']}").json()
    assert still["status"] == "booked"  # the failed reschedule changed nothing
    assert client("fd-b").post(url, json={"startAt": local(practice.day, 11),
                                          "reasonCode": "x"}).status_code == 404
    client("fd").post(f"{API}/appointments/{other['id']}/cancel", json={"reasonCode": "x"})
    gone = client("fd").post(f"{API}/appointments/{other['id']}/reschedule", json={
        "startAt": local(practice.day, 14), "reasonCode": "x"})
    assert gone.status_code == 409 and gone.json()["currentState"] == "cancelled"


def test_cancel(client: Any, practice: Practice) -> None:
    a = _book(client, practice)
    url = f"{API}/appointments/{a['id']}/cancel"
    assert client("ma").post(url, json={"reasonCode": "x"}).status_code == 403
    assert client("fd").post(url, json={}).status_code == 422
    assert client("fd-b").post(url, json={"reasonCode": "x"}).status_code == 404
    done = client("fd").post(url, json={"reasonCode": "patient-request",
                                        "reasonText": "Feeling better."})
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "cancelled"
    assert done.json()["cancellation"]["reasonText"] == "Feeling better."
    again = client("fd").post(url, json={"reasonCode": "patient-request"})
    assert again.status_code == 409 and _code(again) == "invalid-state-transition"
    # The slot is free again.
    assert client("fd").post(f"{API}/appointments",
                             json=_booking(practice, "marcus")).status_code == 201


# ------------------------------------------------------------------------------ status board
def test_the_shared_board_shows_initials_time_and_status_only(client: Any,
                                                             practice: Practice) -> None:
    _book(client, practice)
    params = {"facilityId": str(practice.facility), "date": practice.day.isoformat()}
    shared = client("fd").get(f"{API}/status-board", params=params)
    assert shared.status_code == 200, shared.text
    item = shared.json()["items"][0]
    assert set(item) == {"appointmentId", "initials", "startAt", "status"}
    assert item["initials"] == "KL"
    assert shared.json()["facilityName"] == "Main office (synthetic)"
    display = client("dsp").get(f"{API}/status-board", params={**params, "view": "staff"})
    assert set(display.json()["items"][0]) == set(item)  # DSP always gets the shared view (D47)


def test_the_staff_board(client: Any, practice: Practice) -> None:
    _book(client, practice)
    _book(client, practice, patient="restricted", hour=10)
    cancelled = _book(client, practice, patient="marcus", hour=11)
    client("fd").post(f"{API}/appointments/{cancelled['id']}/cancel", json={"reasonCode": "x"})
    params = {"facilityId": str(practice.facility), "date": practice.day.isoformat(),
              "view": "staff"}
    items = client("ma").get(f"{API}/status-board", params=params).json()["items"]
    assert len(items) == 2  # cancelled visits leave the board
    open_chart, restricted = items
    assert open_chart["patient"]["displayName"] == "Kaia401 Lindgren118"
    assert open_chart["reasonForVisit"] == "Follow-up on headaches."
    assert open_chart["appointmentType"]["code"] == "FU"
    assert restricted["patient"]["restricted"] is True and "reasonForVisit" not in restricted
    assert client("none").get(f"{API}/status-board", params=params).status_code == 403
    assert client("ma").get(f"{API}/status-board", params={
        **params, "facilityId": str(practice.other_facility)}).status_code == 404
    assert client("ma").get(f"{API}/status-board", params={
        "view": "staff"}).status_code == 422  # facilityId is required
    assert client("md-b").get(f"{API}/status-board", params={
        **params, "facilityId": str(practice.facility_b)}).json()["items"] == []


# ----------------------------------------------------------------------- safe retries (T21)
@pytest.mark.skipif(not os.environ.get("OPENBAO_TRANSIT_ADDR")
                    and os.environ.get("REQUIRE_OPENBAO") != "1",
                    reason="OPENBAO_TRANSIT_ADDR not set (the stored response is encrypted)")
def test_a_keyed_booking_is_replayed_not_repeated(client: Any, practice: Practice) -> None:
    key = {"Idempotency-Key": str(uuid.uuid4())}
    body = _booking(practice)
    first = client("fd").post(f"{API}/appointments", json=body, headers=key)
    assert first.status_code == 201, first.text
    replay = client("fd").post(f"{API}/appointments", json=body, headers=key)
    assert replay.status_code == 201 and replay.headers["Idempotent-Replayed"] == "true"
    assert replay.json()["id"] == first.json()["id"]
    reused = client("fd").post(f"{API}/appointments", json=_booking(practice, hour=13),
                               headers=key)
    assert reused.status_code == 422 and _code(reused) == "idempotency-key-reused"
    day = client("fd").get(f"{API}/appointments",
                           params={"date": practice.day.isoformat()}).json()["items"]
    assert len(day) == 1  # booked once
