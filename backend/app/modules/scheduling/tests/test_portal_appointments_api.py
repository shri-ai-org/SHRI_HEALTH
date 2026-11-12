"""The patient portal's appointment reads (B8a, D84; #269, #271) against an in-memory stand-in for
the shri_portal reads. The stand-in keeps rows per clinic and patient and shows a session only its
own patient's rows, as the own-chart policies do (D93); test_portal_appointments_live.py covers
the real database and policies. Patients sign in with the development stand-in (X-Dev-Patient,
D108). Synthetic data only."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core import permissions
from app.core.config import Settings
from app.core.deps import (
    DEV_PATIENT_CLINIC_HEADER,
    DEV_PATIENT_HEADER,
    DEV_USER_HEADER,
    PortalPatient,
    portal_db,
    portal_session,
)
from app.main import create_app

from .. import portal_api
from ..portal_repository import (
    PORTAL_STATUSES,
    OnlinePolicy,
    PortalAddressRow,
    PortalAppointmentRow,
)

CLINIC = UUID("0a000000-0000-4000-8000-0000000000c1")
OTHER_CLINIC = UUID("0a000000-0000-4000-8000-0000000000c2")
ANA = UUID("0c000000-0000-4000-8000-0000000000a1")  # patient A
BEN = UUID("0c000000-0000-4000-8000-0000000000b1")  # patient B, same clinic
URL = "/api/v1/portal/me/appointments"
NOW = datetime.now(UTC).replace(microsecond=0)


@dataclass
class FakePortalDb:
    """What portal_db yields here: the session's clinic and patient, as shri_portal's settings."""
    tenant_id: UUID
    patient_id: UUID


@dataclass
class World:
    rows: dict[UUID, list[PortalAppointmentRow]] = field(default_factory=dict)  # clinic → rows
    policy: OnlinePolicy | None = OnlinePolicy(cancel_cutoff_hours=24, reschedule_cutoff_hours=48)
    leaky: bool = False  # True: the "database" ignores the patient (a broken policy)


class FakeReads:
    """Shows only the session patient's listed appointments, as the policies and query do."""

    def __init__(self, world: World) -> None:
        self.world = world

    def _visible(self, db: FakePortalDb, patient_id: UUID) -> list[PortalAppointmentRow]:
        rows = self.world.rows.get(db.tenant_id, [])
        if not self.world.leaky:
            rows = [r for r in rows if r.patient_id == db.patient_id == patient_id]
        return [r for r in rows if r.status in PORTAL_STATUSES]

    async def list(self, db: FakePortalDb, patient_id: UUID, *, upcoming: bool, now: datetime,
                   limit: int, offset: int) -> list[PortalAppointmentRow]:
        over = ("fulfilled", "noshow")
        rows = [r for r in self._visible(db, patient_id)
                if (r.end > now and r.status not in over) == upcoming]
        rows.sort(key=lambda r: (r.start, str(r.id)), reverse=not upcoming)
        return rows[offset:offset + limit]

    async def get(self, db: FakePortalDb, patient_id: UUID, appointment_id: UUID
                  ) -> PortalAppointmentRow | None:
        return next((r for r in self._visible(db, patient_id) if r.id == appointment_id), None)

    async def policy(self, db: FakePortalDb) -> OnlinePolicy | None:
        return self.world.policy


def appointment(patient: UUID, *, hours: float, status: str = "booked",
                summary: UUID | None = None) -> PortalAppointmentRow:
    start = NOW + timedelta(hours=hours)
    return PortalAppointmentRow(
        id=uuid4(), patient_id=patient, status=status, start=start,
        end=start + timedelta(minutes=20), time_zone="America/Chicago", facility_id=uuid4(),
        facility_name="Main office (synthetic)",
        facility_address=PortalAddressRow(("100 Test Lane",), "Springfield", "IL", "62701",
                                          "US"),
        provider_id=uuid4(), provider_name="Dr. Avery401 Lindqvist58", type_id=uuid4(),
        type_name="Follow-up visit", telehealth=False, reason="Headache follow-up",
        patient_instruction="Please arrive 15 minutes early.", visit_summary_id=summary)


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def app(world: World) -> Iterator[FastAPI]:
    application = create_app(Settings(environment="test", auth_mode="dev_header",
                                       patient_auth_mode="dev_header"))

    async def fake_portal_db(patient: PortalPatient = Depends(portal_session)) -> FakePortalDb:
        return FakePortalDb(patient.organization_id, patient.patient_id)

    application.dependency_overrides[portal_db] = fake_portal_db
    application.dependency_overrides[portal_api.portal_appointments] = lambda: FakeReads(world)
    yield application
    application.dependency_overrides.clear()


def as_patient(app: FastAPI, patient: UUID, clinic: UUID = CLINIC) -> TestClient:
    c = TestClient(app, raise_server_exceptions=False)
    c.headers.update({DEV_PATIENT_HEADER: str(patient), DEV_PATIENT_CLINIC_HEADER: str(clinic)})
    return c


@pytest.fixture
def chart(world: World) -> dict[str, PortalAppointmentRow]:
    """A: an upcoming visit, a checked-in one today, a past one with its summary, a cancelled
    upcoming one. B: one upcoming and one past visit in the same clinic."""
    summary = uuid4()
    rows = {
        "a-next": appointment(ANA, hours=72),
        "a-today": appointment(ANA, hours=-0.1, status="arrived"),
        "a-past": appointment(ANA, hours=-24 * 30, status="fulfilled", summary=summary),
        "a-cancelled": appointment(ANA, hours=24 * 10, status="cancelled"),
        "a-proposed": appointment(ANA, hours=24 * 3, status="proposed"),
        "b-next": appointment(BEN, hours=48),
        "b-past": appointment(BEN, hours=-24 * 7, status="fulfilled", summary=uuid4()),
    }
    world.rows[CLINIC] = list(rows.values())
    return rows


def _ids(response: Any) -> list[str]:
    return [item["id"] for item in response.json()["items"]]


# --------------------------------------------------------------------------------- list (#269)
def test_a_patient_lists_their_upcoming_visits_soonest_first(
        app: FastAPI, chart: dict[str, PortalAppointmentRow]) -> None:
    r = as_patient(app, ANA).get(URL)
    assert r.status_code == 200, r.text
    assert _ids(r) == [str(chart[k].id) for k in ("a-today", "a-next", "a-cancelled")]
    today = r.json()["items"][0]
    assert today["status"] == "checked-in"  # arrived, as the patient sees it
    assert today["canCancel"] is False and today["canReschedule"] is False
    following = r.json()["items"][1]
    assert following == {
        "id": str(chart["a-next"].id), "startAt": following["startAt"],
        "endAt": following["endAt"], "timeZone": "America/Chicago", "status": "booked",
        "facility": {"id": str(chart["a-next"].facility_id), "name": "Main office (synthetic)",
                     "address": {"lines": ["100 Test Lane"], "city": "Springfield",
                                 "state": "IL", "postalCode": "62701", "country": "US"}},
        "provider": {"id": str(chart["a-next"].provider_id),
                     "displayName": "Dr. Avery401 Lindqvist58"},
        "appointmentType": {"id": str(chart["a-next"].type_id), "name": "Follow-up visit"},
        "telehealth": False, "reasonForVisit": "Headache follow-up",
        "patientInstruction": "Please arrive 15 minutes early.",
        "canCancel": True, "canReschedule": True}


def test_past_visits_are_newest_first_with_their_visit_summary(
        app: FastAPI, chart: dict[str, PortalAppointmentRow]) -> None:
    r = as_patient(app, ANA).get(URL, params={"when": "past"})
    assert r.status_code == 200, r.text
    assert _ids(r) == [str(chart["a-past"].id)]
    assert r.json()["items"][0]["visitSummaryId"] == str(chart["a-past"].visit_summary_id)
    assert r.json()["items"][0]["status"] == "fulfilled"


def test_patient_a_never_sees_patient_b_appointments(
        app: FastAPI, chart: dict[str, PortalAppointmentRow]) -> None:
    theirs = {str(chart["b-next"].id), str(chart["b-past"].id)}
    for when in ("upcoming", "past"):
        assert not theirs & set(_ids(as_patient(app, ANA).get(URL, params={"when": when})))
    assert _ids(as_patient(app, BEN).get(URL)) == [str(chart["b-next"].id)]


def test_requests_not_listed_by_staff_are_not_shown(
        app: FastAPI, chart: dict[str, PortalAppointmentRow]) -> None:
    listed = _ids(as_patient(app, ANA).get(URL)) + _ids(
        as_patient(app, ANA).get(URL, params={"when": "past"}))
    assert str(chart["a-proposed"].id) not in listed


def test_the_cut_off_decides_cancel_and_reschedule(
        app: FastAPI, world: World, chart: dict[str, PortalAppointmentRow]) -> None:
    world.policy = OnlinePolicy(cancel_cutoff_hours=24, reschedule_cutoff_hours=96)
    item = as_patient(app, ANA).get(f"{URL}/{chart['a-next'].id}").json()  # 72 hours away
    assert (item["canCancel"], item["canReschedule"]) == (True, False)
    world.policy = None  # no online booking rules: nothing online
    item = as_patient(app, ANA).get(f"{URL}/{chart['a-next'].id}").json()
    assert (item["canCancel"], item["canReschedule"]) == (False, False)


def test_pages_follow_the_cursor(app: FastAPI, chart: dict[str, PortalAppointmentRow]) -> None:
    client = as_patient(app, ANA)
    first = client.get(URL, params={"limit": 2})
    assert first.status_code == 200 and len(first.json()["items"]) == 2
    rest = client.get(URL, params={"limit": 2, "cursor": first.json()["nextCursor"]})
    assert _ids(rest) == [str(chart["a-cancelled"].id)] and "nextCursor" not in rest.json()


def test_a_broken_policy_still_never_shows_another_patients_rows(
        app: FastAPI, world: World, chart: dict[str, PortalAppointmentRow]) -> None:
    world.leaky = True
    listed = _ids(as_patient(app, ANA).get(URL))
    assert str(chart["b-next"].id) not in listed and str(chart["a-next"].id) in listed
    assert as_patient(app, ANA).get(f"{URL}/{chart['b-next'].id}").status_code == 404


# ---------------------------------------------------------------------------------- one (#271)
def test_a_patient_reads_their_own_appointment(
        app: FastAPI, chart: dict[str, PortalAppointmentRow]) -> None:
    r = as_patient(app, ANA).get(f"{URL}/{chart['a-past'].id}")
    assert r.status_code == 200, r.text
    assert r.json()["id"] == str(chart["a-past"].id)


@pytest.mark.parametrize("key", ["b-next", "b-past"])
def test_another_patients_appointment_is_not_found(
        app: FastAPI, chart: dict[str, PortalAppointmentRow], key: str) -> None:
    r = as_patient(app, ANA).get(f"{URL}/{chart[key].id}")
    assert r.status_code == 404
    unknown = as_patient(app, ANA).get(f"{URL}/{uuid4()}")
    assert unknown.status_code == 404
    assert r.json()["type"] == unknown.json()["type"]  # the same answer (D84)


def test_the_same_patient_id_in_another_clinic_sees_nothing(
        app: FastAPI, chart: dict[str, PortalAppointmentRow]) -> None:
    assert _ids(as_patient(app, ANA, OTHER_CLINIC).get(URL)) == []
    assert as_patient(app, ANA, OTHER_CLINIC).get(
        f"{URL}/{chart['a-next'].id}").status_code == 404


# ------------------------------------------------------------------- refusals and validation
@pytest.mark.parametrize("path", ["", "/{id}"])
def test_a_staff_session_is_refused(app: FastAPI, chart: dict[str, PortalAppointmentRow],
                                    path: str) -> None:
    c = TestClient(app, raise_server_exceptions=False)
    c.headers[DEV_USER_HEADER] = "fd"
    r = c.get(URL + path.format(id=chart["a-next"].id))
    assert r.status_code == 401


@pytest.mark.parametrize("path", ["", "/{id}"])
def test_without_the_permission_the_patient_is_refused(
        app: FastAPI, chart: dict[str, PortalAppointmentRow], path: str,
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(permissions, "PATIENT_PERMISSIONS",
                        permissions.PATIENT_PERMISSIONS - {"portal-appointments:read"})
    r = as_patient(app, ANA).get(URL + path.format(id=chart["a-next"].id))
    assert r.status_code == 403
    assert r.json()["type"].endswith("/permission-denied")


@pytest.mark.parametrize(("path", "params", "expected"), [
    ("", {"when": "someday"}, 422),
    ("", {"limit": 0}, 422),
    ("", {"limit": 101}, 422),
    ("", {"cursor": "bm90LWEtY3Vyc29y"}, 400),
    ("/not-a-uuid", {}, 422),
])
def test_invalid_requests_are_refused(app: FastAPI, chart: dict[str, PortalAppointmentRow],
                                      path: str, params: dict[str, Any], expected: int) -> None:
    r = as_patient(app, ANA).get(URL + path, params=params)
    assert r.status_code == expected, r.text

