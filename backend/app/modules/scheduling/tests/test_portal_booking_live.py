"""Patient self-booking from the portal against a live database (the demo slice, D108): the
real app, portal_db as shri_portal with its own-chart policies, the patient development sign-in
(X-Dev-Patient) and core's audit and idempotency. Two synthetic patients in one clinic
(portal_live.py); each already has one booked visit three days ahead. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.deps import DEV_PATIENT_CLINIC_HEADER, DEV_USER_HEADER
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url

from .portal_live import API, PortalChart, portal_client
from .portal_live import portal_app as portal_app  # noqa: F401 (fixture)
from .portal_live import portal_chart as portal_chart  # noqa: F401 (fixture)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

MINE = f"{API}/portal/me/appointments"


def _sql(sql: str, **params: Any) -> None:
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.begin() as c:
            # The FHIR touch triggers name their parent tables unqualified.
            c.execute(text("SET LOCAL search_path = clinical, admin, public"))
            c.execute(text(sql), params)
    finally:
        admin.dispose()


def _online(chart: PortalChart, *, notice_minutes: int = 1440) -> UUID:
    """The demo rules: follow-ups bookable online at A1, 24 h notice, 60 days, 24 h cut-offs."""
    p = chart.practice
    _sql("UPDATE admin.online_booking_setting SET min_notice_minutes = :n, "
         "booking_window_days = 60, cancel_cutoff_hours = 24, reschedule_cutoff_hours = 24 "
         "WHERE tenant_id = :t", n=notice_minutes, t=p.clinic)
    _sql("INSERT INTO admin.online_bookable_type (id, tenant_id, facility_id, "
         "appointment_type_id) VALUES (:i, :t, :f, :a)", i=uuid.uuid4(), t=p.clinic,
         f=p.facility, a=p.types["FU"])
    return p.types["FU"]


class Patient:
    def __init__(self, client: TestClient, chart: PortalChart, patient: UUID,
                 clinic: UUID | None = None) -> None:
        self.client = client
        self.headers = dict(portal_client(client, chart, patient).headers)
        if clinic is not None:
            self.headers[DEV_PATIENT_CLINIC_HEADER] = str(clinic)

    def get(self, url: str, params: dict[str, Any] | None = None) -> Any:
        return self.client.get(url, params=params, headers=self.headers)

    def post(self, url: str, body: dict[str, Any], key: str | None = None) -> Any:
        headers = {**self.headers, **({"Idempotency-Key": key} if key else {})}
        return self.client.post(url, json=body, headers=headers)


def _free(patient: Patient, chart: PortalChart, type_id: UUID, days: int = 4) -> list[Any]:
    day = (dt.datetime.now(dt.UTC) + dt.timedelta(days=days)).date().isoformat()
    found = patient.get(f"{API}/portal/me/slots", {
        "facilityId": str(chart.practice.facility), "appointmentTypeId": str(type_id),
        "date": day})
    assert found.status_code == 200, found.text
    items: list[Any] = found.json()["items"]
    return items


def _body(chart: PortalChart, type_id: UUID, slot: Any, **extra: Any) -> dict[str, Any]:
    return {"facilityId": str(chart.practice.facility), "appointmentTypeId": str(type_id),
            "providerId": slot["providerId"], "startAt": slot["startAt"],
            "reasonCode": "follow-up", **extra}


def test_reference_lists_and_free_times(portal_app: TestClient, portal_chart: PortalChart
                                        ) -> None:
    fu = _online(portal_chart)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    facilities = a.get(f"{API}/portal/booking/facilities").json()["items"]
    assert [f["id"] for f in facilities] == [str(portal_chart.practice.facility)]
    types = a.get(f"{API}/portal/booking/appointment-types",
                  {"facilityId": str(portal_chart.practice.facility)}).json()["items"]
    assert [t["id"] for t in types] == [str(fu)] and types[0]["durationMinutes"] == 20
    providers = a.get(f"{API}/portal/booking/providers",
                      {"facilityId": str(portal_chart.practice.facility)}).json()["items"]
    assert str(portal_chart.practice.provider) in [p["id"] for p in providers]
    free = _free(a, portal_chart, fu)
    assert free and all(s["providerId"] for s in free)
    soon = dt.datetime.now(dt.UTC) + dt.timedelta(hours=24)
    assert all(dt.datetime.fromisoformat(s["startAt"]) >= soon for s in free)
    # A visit type that isn't bookable online offers no times.
    assert _free(a, portal_chart, portal_chart.practice.types["NEW"]) == []


def test_book_then_it_is_on_the_staff_schedule(portal_app: TestClient,
                                              portal_chart: PortalChart) -> None:
    fu = _online(portal_chart)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    slot = _free(a, portal_chart, fu)[0]
    key = str(uuid.uuid4())
    booked = a.post(MINE, _body(portal_chart, fu, slot, reasonForVisit="Pressure readings"),
                    key)
    assert booked.status_code == 201, booked.text
    made = booked.json()
    assert made["status"] == "booked" and made["reasonCode"] == "follow-up"
    assert made["reasonForVisit"] == "Pressure readings" and made["canCancel"] is True
    assert booked.headers["Location"] == f"{MINE}/{made['id']}"
    again = a.post(MINE, _body(portal_chart, fu, slot, reasonForVisit="Pressure readings"), key)
    assert again.status_code == 201 and again.json()["id"] == made["id"]  # a retry, replayed
    # On the clinic's schedule: the row the front desk's day view lists (booked, this facility).
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.connect() as c:
            row = c.execute(text(
                "SELECT subject_patient_id, status, ext_facility_id, tenant_id "
                "FROM clinical.appointment WHERE id = :i"), {"i": made["id"]}).one()
    finally:
        admin.dispose()
    assert (row.subject_patient_id, row.status, row.ext_facility_id, row.tenant_id) == (
        portal_chart.a, "booked", portal_chart.practice.facility, portal_chart.practice.clinic)
    assert a.get(f"{MINE}/{made['id']}").json()["id"] == made["id"]


def test_each_booking_rule(portal_app: TestClient, portal_chart: PortalChart) -> None:
    fu = _online(portal_chart)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    free = _free(a, portal_chart, fu)
    no_reason = a.post(MINE, {k: v for k, v in _body(portal_chart, fu, free[0]).items()
                              if k != "reasonCode"})
    assert no_reason.status_code == 422
    assert no_reason.json()["errors"][0]["pointer"] == "/reasonCode"
    wrong = a.post(MINE, _body(portal_chart, portal_chart.practice.types["NEW"], free[0]))
    assert wrong.status_code == 422
    assert wrong.json()["errors"][0]["pointer"] == "/appointmentTypeId"
    tomorrow = (dt.datetime.now(dt.UTC) + dt.timedelta(hours=20)).replace(microsecond=0)
    too_soon = a.post(MINE, {**_body(portal_chart, fu, free[0]),
                             "startAt": tomorrow.isoformat()})
    assert too_soon.status_code == 422 and too_soon.json()["errors"][0]["pointer"] == "/startAt"
    far = (dt.datetime.now(dt.UTC) + dt.timedelta(days=61)).replace(microsecond=0)
    too_far = a.post(MINE, {**_body(portal_chart, fu, free[0]), "startAt": far.isoformat()})
    assert too_far.status_code == 422
    bad_code = a.post(MINE, {**_body(portal_chart, fu, free[0]), "reasonCode": "surgery"})
    assert bad_code.status_code == 422
    # Patient A has one visit ahead; one more is allowed, a third is refused.
    assert a.post(MINE, _body(portal_chart, fu, free[0])).status_code == 201
    third = a.post(MINE, _body(portal_chart, fu, free[-1]))
    assert third.status_code == 422 and third.json()["errors"][0]["pointer"] == "/startAt"


def test_a_taken_time_is_a_conflict(portal_app: TestClient, portal_chart: PortalChart) -> None:
    fu = _online(portal_chart)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    b = Patient(portal_app, portal_chart, portal_chart.b)
    slot = _free(a, portal_chart, fu)[0]
    assert a.post(MINE, _body(portal_chart, fu, slot)).status_code == 201
    taken = b.post(MINE, _body(portal_chart, fu, slot))
    assert taken.status_code == 409 and taken.json()["code"] == "booking-conflict"


def test_another_patients_booking_is_not_offered_again(portal_app: TestClient,
                                                       portal_chart: PortalChart) -> None:
    """The busy times come from admin.portal_busy_times (Anand's, migration 0011): another
    patient's booking is busy for B, though B can't see the appointment itself."""
    fu = _online(portal_chart)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    b = Patient(portal_app, portal_chart, portal_chart.b)
    slot = _free(a, portal_chart, fu)[0]
    made = a.post(MINE, _body(portal_chart, fu, slot))
    assert made.status_code == 201, made.text
    assert slot["startAt"] not in [s["startAt"] for s in _free(b, portal_chart, fu)]
    assert b.get(f"{MINE}/{made.json()['id']}").status_code == 404
    taken = b.post(MINE, _body(portal_chart, fu, slot))
    assert taken.status_code == 409 and taken.json()["code"] == "booking-conflict"


def test_a_patient_cancels_a_booking_the_front_desk_made(portal_app: TestClient,
                                                         portal_chart: PortalChart) -> None:
    """The portal never writes the staff columns (Anand's finding on #85): a desk-made booking,
    whose updated_by_user_id names a staff user, cancels from the portal (no 500)."""
    _online(portal_chart)
    soon = portal_chart.ids["a-next"]
    _sql("UPDATE clinical.appointment SET updated_by_user_id = (SELECT u.id FROM admin.app_user u "
         "WHERE u.tenant_id = :t LIMIT 1) WHERE id = :a", t=portal_chart.practice.clinic, a=soon)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    done = a.post(f"{MINE}/{soon}/cancel", {"reasonText": "Feeling better."})
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "cancelled"


def test_an_inactive_chart_cannot_book_or_move_online(portal_app: TestClient,
                                                      portal_chart: PortalChart) -> None:
    fu = _online(portal_chart)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    free = _free(a, portal_chart, fu)
    made = a.post(MINE, _body(portal_chart, fu, free[0]))
    assert made.status_code == 201, made.text
    _sql("UPDATE clinical.patient SET active = false WHERE id = :p", p=portal_chart.a)
    refused = a.post(MINE, _body(portal_chart, fu, free[1]))
    assert refused.status_code == 403 and refused.json()["code"] == "permission-denied"
    moved = a.post(f"{MINE}/{made.json()['id']}/reschedule", {"startAt": free[-1]["startAt"]})
    assert moved.status_code == 403 and moved.json()["code"] == "permission-denied"
    assert a.get(f"{MINE}/{made.json()['id']}").json()["status"] == "booked"


def test_cancel_and_reschedule_with_their_cut_offs(portal_app: TestClient,
                                                   portal_chart: PortalChart) -> None:
    fu = _online(portal_chart)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    free = _free(a, portal_chart, fu)
    made = a.post(MINE, _body(portal_chart, fu, free[0])).json()
    moved = a.post(f"{MINE}/{made['id']}/reschedule", {"startAt": free[-1]["startAt"]},
                   str(uuid.uuid4()))
    assert moved.status_code == 201, moved.text
    assert moved.json()["startAt"] == free[-1]["startAt"]
    assert moved.json()["reasonCode"] == "follow-up"
    assert a.get(f"{MINE}/{made['id']}").json()["status"] == "cancelled"
    cancelled = a.post(f"{MINE}/{moved.json()['id']}/cancel", {"reasonText": "Feeling better."})
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    again = a.post(f"{MINE}/{moved.json()['id']}/cancel", {"reasonText": "Twice."})
    assert again.status_code == 409 and again.json()["code"] == "invalid-state-transition"
    _sql("UPDATE admin.online_booking_setting SET cancel_cutoff_hours = 96, "
         "reschedule_cutoff_hours = 96 WHERE tenant_id = :t", t=portal_chart.practice.clinic)
    soon = portal_chart.ids["a-next"]  # three days ahead: inside a 96-hour cut-off
    late = a.post(f"{MINE}/{soon}/cancel", {"reasonText": "Too late."})
    assert late.status_code == 422 and late.json()["errors"][0]["pointer"] == "/startAt"
    late_move = a.post(f"{MINE}/{soon}/reschedule", {"startAt": free[0]["startAt"]})
    assert late_move.status_code == 422
    assert a.post(f"{MINE}/{soon}/cancel", {"reasonText": ""}).status_code == 422


def test_another_patients_or_clinics_appointment_is_not_found(
        portal_app: TestClient, portal_chart: PortalChart) -> None:
    fu = _online(portal_chart)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    free = _free(a, portal_chart, fu)
    theirs = portal_chart.ids["b-next"]
    assert a.post(f"{MINE}/{theirs}/cancel", {"reasonText": "Not mine."}).status_code == 404
    assert a.post(f"{MINE}/{theirs}/reschedule",
                  {"startAt": free[0]["startAt"]}).status_code == 404
    assert a.post(f"{MINE}/{uuid.uuid4()}/cancel", {"reasonText": "None."}).status_code == 404
    other_clinic = Patient(portal_app, portal_chart, portal_chart.a,
                           clinic=portal_chart.practice.clinic_b)
    assert other_clinic.post(f"{MINE}/{portal_chart.ids['a-next']}/cancel",
                             {"reasonText": "Elsewhere."}).status_code in (401, 403, 404)
    assert theirs not in [x["id"] for x in a.get(MINE).json()["items"]]


def test_booking_needs_a_patient_session(portal_app: TestClient,
                                         portal_chart: PortalChart) -> None:
    fu = _online(portal_chart)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    slot = _free(a, portal_chart, fu)[0]
    staff = portal_app.post(MINE, json=_body(portal_chart, fu, slot),
                            headers={DEV_USER_HEADER: "fd"})
    assert staff.status_code == 401
    nobody = portal_app.get(f"{API}/portal/booking/facilities")
    assert nobody.status_code == 401


def test_a_visit_booked_from_a_follow_up_request_is_moved_by_the_clinic_only(
        portal_app: TestClient, portal_chart: PortalChart) -> None:
    """D98: checked under the appointment's row lock, so a link the desk makes meanwhile counts."""
    fu = _online(portal_chart)
    a = Patient(portal_app, portal_chart, portal_chart.a)
    free = _free(a, portal_chart, fu)
    made = a.post(MINE, _body(portal_chart, fu, free[0]))
    assert made.status_code == 201, made.text
    _sql("INSERT INTO clinical.encounter_follow_up (id, tenant_id, encounter_id, patient_id, "
         "interval_value, interval_unit, status, requested_by_user_id, booked_appointment_id) "
         "SELECT gen_random_uuid(), e.tenant_id, e.id, e.subject_patient_id, 2, 'week', 'booked', "
         "(SELECT u.id FROM admin.app_user u WHERE u.tenant_id = e.tenant_id LIMIT 1), :a "
         "FROM clinical.encounter e WHERE e.subject_patient_id = :p LIMIT 1",
         a=UUID(made.json()["id"]), p=portal_chart.a)
    for action, body in (("cancel", {"reasonText": "Feeling better."}),
                         ("reschedule", {"startAt": free[-1]["startAt"]})):
        refused = a.post(f"{MINE}/{made.json()['id']}/{action}", body)
        assert refused.status_code == 422, refused.text
        assert refused.json()["errors"][0]["code"] == "not-editable", action
    assert a.get(f"{MINE}/{made.json()['id']}").json()["status"] == "booked"
