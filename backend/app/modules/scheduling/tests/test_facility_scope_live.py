"""Facility scope of every scheduling operation, against the live database (SECURITY_MODEL
§5.1, D37): a front desk user assigned to facility A1 only never sees, books into, changes or
acts on what belongs to facility A2 of the same clinic, nor anything of clinic B. A2's records are
made through the API by A2's own staff. One table, every operation the module serves
(facility_scope.py runs it). Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL

from .conftest import ZONE, Practice, local
from .facility_scope import (
    API,
    Row,
    appointment_today,
    failures,
    report,
    served_operations,
    staff,
    sweep,
)
from .test_check_in_live import _sql

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]


def _key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _booked(client: Any, user: str, body: dict[str, Any]) -> str:
    made = client(user).post(f"{API}/appointments", json=body)
    assert made.status_code == 201, made.text
    found: str = made.json()["id"]
    return found


def _checked_in(client: Any, user: str, appointment: str) -> str:
    done = client(user).post(f"{API}/appointments/{appointment}/check-in",
                             json={"selfPay": True}, headers=_key())
    assert done.status_code == 200, done.text
    encounter: str = done.json()["encounterId"]
    return encounter


def _rows(client: Any, practice: Practice, users: dict[str, CurrentUser]) -> list[Row]:
    p = practice
    staff(p, users, "fd-a2", "fd", facility=p.other_facility)
    a1, a2 = str(p.facility), str(p.other_facility)
    site2 = str(_sql(p, "SELECT location_id FROM admin.facility WHERE id = :f",
                     f=p.other_facility)[0][0])
    today = dt.datetime.now(ZoneInfo(ZONE)).date().isoformat()

    def booking(facility: str, provider: uuid.UUID, hour: int, **extra: Any) -> dict[str, Any]:
        body = {"patientId": str(p.patients["kaia"]), "providerId": str(provider),
                "facilityId": facility, "appointmentTypeId": str(p.types["FU"]),
                "startAt": local(p.day, hour), "reasonForVisit": "Follow-up on headaches."}
        return {**body, **extra}

    # A1's own records (the controls) and A2's, each made by that facility's front desk.
    mine = _booked(client, "fd", booking(a1, p.provider, 9, locationId=str(p.room)))
    theirs = _booked(client, "fd-a2", booking(a2, p.other_provider, 10))
    mine_today = appointment_today(p, "kaia", facility=p.facility, provider=p.provider,
                                   hour=11, room=p.room)
    mine_in = appointment_today(p, "restricted", facility=p.facility, provider=p.provider,
                                hour=12, room=p.room)
    _checked_in(client, "fd", mine_in)
    theirs_today = appointment_today(p, "kaia", facility=p.other_facility,
                                     provider=p.other_provider, hour=14)
    theirs_in = appointment_today(p, "marcus", facility=p.other_facility,
                                  provider=p.other_provider, hour=13)
    their_visit = _checked_in(client, "fd-a2", theirs_in)
    # A follow-up asked for at A2's visit (D98), written straight to the table.
    _sql(p, "INSERT INTO clinical.encounter_follow_up (id, tenant_id, encounter_id, patient_id, "
         "interval_value, interval_unit, requested_by_user_id) VALUES (gen_random_uuid(), :t, "
         ":e, :p, 2, 'week', :u)", t=p.clinic, e=their_visit, p=p.patients["marcus"],
         u=users["fd-a2"].id)
    hidden_a2 = (a2, theirs, theirs_today, theirs_in)
    move = {"startAt": local(p.day, 15), "reasonCode": "patient-request"}
    cancel = {"reasonCode": "patient-request"}
    appt = f"{API}/appointments"

    return [
        # --- reference lists: A2 and what is only A2's are left out; asking for A2 is 404
        Row("listBookableFacilities", "fd", "GET", f"{API}/booking/facilities", 200,
            hidden=(a2,), shown=(a1,)),
        Row("listBookableLocations", "fd", "GET", f"{API}/booking/locations", 200,
            hidden=(site2,), shown=(str(p.room),)),
        Row("listBookableLocations", "fd", "GET", f"{API}/booking/locations", 404,
            params={"facilityId": a2}),
        Row("listBookableProviders", "fd", "GET", f"{API}/booking/providers", 200,
            hidden=(str(p.other_provider), a2), shown=(str(p.provider),)),
        Row("listBookableProviders", "fd", "GET", f"{API}/booking/providers", 404,
            params={"facilityId": a2}),
        Row("listBookableAppointmentTypes", "fd", "GET", f"{API}/booking/appointment-types",
            200, shown=(str(p.types["FU"]),),
            note="clinic-wide reference data: appointment types have no facility"),
        # --- free times
        Row("listSlots", "fd", "GET", f"{API}/slots", 404,
            params={"facilityId": a2, "date": p.day.isoformat()}),
        Row("listSlots", "fd", "GET", f"{API}/slots", 200,
            params={"facilityId": a1, "date": p.day.isoformat(),
                    "providerId": str(p.other_provider)}, hidden=(a2,)),
        # --- appointment lists, with and without filters
        Row("listAppointments", "fd", "GET", appt, 200, params={"date": p.day.isoformat()},
            hidden=hidden_a2, shown=(mine,)),
        Row("listAppointments", "fd", "GET", appt, 200,
            params={"patientId": str(p.patients["kaia"])}, hidden=hidden_a2,
            shown=(mine, mine_today)),
        Row("listPatientAppointments", "fd", "GET",
            f"{API}/patients/{p.patients['kaia']}/appointments", 200, hidden=hidden_a2,
            shown=(mine, mine_today), note="the patient's history keeps to A1"),
        Row("listPatientAppointments", "fd-b", "GET",
            f"{API}/patients/{p.patients['kaia']}/appointments", 404),
        Row("listAppointments", "fd", "GET", appt, 200,
            params={"date": p.day.isoformat(), "providerId": str(p.other_provider)},
            hidden=hidden_a2),
        Row("listAppointments", "fd", "GET", appt, 404,
            params={"date": p.day.isoformat(), "facilityId": a2}),
        # --- booking: into A2, with A2's provider, or A2's follow-up request
        Row("bookAppointment", "fd", "POST", appt, 404, json=booking(a2, p.other_provider, 11)),
        Row("bookAppointment", "fd", "POST", appt, 422,
            json=booking(a1, p.other_provider, 11)),
        Row("bookAppointment", "fd", "POST", appt, 422,
            json=booking(a1, p.provider, 11, locationId=str(p.room),
                         patientId=str(p.patients["marcus"]),
                         followUpOfEncounterId=their_visit),
            note="A2's follow-up request (D98): `invalid-reference`, as for one that isn't open"),
        Row("bookAppointment", "fd", "POST", appt, 422,
            json=booking(a1, p.provider, 11, locationId=site2),
            note="A2's site as the location"),
        # --- one appointment and its actions, by ID
        Row("getAppointment", "fd", "GET", f"{appt}/{theirs}", 404),
        Row("rescheduleAppointment", "fd", "POST", f"{appt}/{theirs}/reschedule", 404,
            json=move),
        Row("rescheduleAppointment", "fd", "POST", f"{appt}/{mine}/reschedule", 404,
            json={**move, "facilityId": a2, "providerId": str(p.other_provider)},
            note="moving A1's appointment into A2"),
        Row("cancelAppointment", "fd", "POST", f"{appt}/{theirs}/cancel", 404, json=cancel),
        Row("updateAppointment", "fd", "PATCH", f"{appt}/{theirs}", 404,
            json={"patientInstruction": "x"},
            headers={"If-Match": '"1"', "Content-Type": "application/merge-patch+json"}),
        Row("checkInAppointment", "fd", "POST", f"{appt}/{theirs_today}/check-in", 404,
            json={"selfPay": True}, headers=_key()),
        Row("undoCheckIn", "fd", "POST", f"{appt}/{theirs_in}/undo-check-in", 404,
            json={"reason": "Wrong patient."}),
        Row("checkOutAppointment", "fd", "POST", f"{appt}/{theirs_in}/check-out", 404),
        Row("recordVisitStatus", "fd", "POST", f"{appt}/{theirs_today}/status", 404,
            json={"status": "arrived"}),
        Row("recordVisitStatus", "ma", "POST", f"{appt}/{theirs_in}/status", 404,
            json={"status": "roomed", "roomLocationId": str(p.room)}),
        # --- the status board
        Row("getStatusBoard", "fd", "GET", f"{API}/status-board", 404,
            params={"facilityId": a2, "date": today}),
        Row("getStatusBoard", "fd", "GET", f"{API}/status-board", 200,
            params={"facilityId": a1, "date": today, "view": "staff"}, hidden=hidden_a2,
            shown=(mine_today, mine_in)),
        # --- clinic B: clinic A's IDs and facility are 404, its lists empty (RLS)
        Row("listBookableFacilities", "fd-b", "GET", f"{API}/booking/facilities", 200,
            hidden=(a1, a2), shown=(str(p.facility_b),)),
        Row("listBookableLocations", "fd-b", "GET", f"{API}/booking/locations", 200,
            hidden=(str(p.room), site2)),
        Row("listBookableProviders", "fd-b", "GET", f"{API}/booking/providers", 200,
            hidden=(str(p.provider), str(p.other_provider))),
        Row("listBookableAppointmentTypes", "fd-b", "GET", f"{API}/booking/appointment-types",
            200, hidden=tuple(str(t) for t in p.types.values())),
        Row("listSlots", "fd-b", "GET", f"{API}/slots", 404,
            params={"facilityId": a1, "date": p.day.isoformat()}),
        Row("listAppointments", "fd-b", "GET", appt, 200,
            params={"patientId": str(p.patients["kaia"])}, hidden=(mine, mine_today, theirs)),
        Row("bookAppointment", "fd-b", "POST", appt, 404,
            json=booking(a1, p.provider, 11, locationId=str(p.room))),
        Row("getAppointment", "fd-b", "GET", f"{appt}/{mine}", 404),
        Row("rescheduleAppointment", "fd-b", "POST", f"{appt}/{mine}/reschedule", 404,
            json=move),
        Row("cancelAppointment", "fd-b", "POST", f"{appt}/{mine}/cancel", 404, json=cancel),
        Row("updateAppointment", "fd-b", "PATCH", f"{appt}/{mine}", 404,
            json={"patientInstruction": "x"},
            headers={"If-Match": '"1"', "Content-Type": "application/merge-patch+json"}),
        Row("checkInAppointment", "fd-b", "POST", f"{appt}/{mine_today}/check-in", 404,
            json={"selfPay": True}, headers=_key()),
        Row("undoCheckIn", "fd-b", "POST", f"{appt}/{mine_in}/undo-check-in", 404,
            json={"reason": "Wrong patient."}),
        Row("checkOutAppointment", "fd-b", "POST", f"{appt}/{mine_in}/check-out", 404),
        Row("recordVisitStatus", "fd-b", "POST", f"{appt}/{mine_today}/status", 404,
            json={"status": "arrived"}),
        Row("getStatusBoard", "fd-b", "GET", f"{API}/status-board", 404,
            params={"facilityId": a1, "date": today}),
    ]


def test_every_scheduling_operation_keeps_to_the_users_facilities(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    outcomes = sweep(client, practice, _rows(client, practice, users))
    assert not failures(outcomes), report(failures(outcomes))
    assert {o.row.operation for o in outcomes} == served_operations("scheduling"), \
        "the table must cover every operation scheduling serves"
