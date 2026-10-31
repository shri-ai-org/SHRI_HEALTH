"""The patient portal's visit summaries (B8a, D84, D86, D90; #278, #279) against an in-memory
stand-in for the shri_portal reads, which shows a session only its own patient's released
summaries and held markers, as the own-chart policies and ``admin.portal_held_items()`` do
(D93). test_portal_visit_summaries_live.py covers the real database. Patients sign in with the
development stand-in (X-Dev-Patient, D108). Synthetic data only."""

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
from ..portal_repository import HeldRow, SummaryRow

CLINIC = UUID("0a000000-0000-4000-8000-0000000000d1")
ANA = UUID("0c000000-0000-4000-8000-0000000000a2")
BEN = UUID("0c000000-0000-4000-8000-0000000000b2")
PROVIDER = UUID("0e000000-0000-4000-8000-0000000000e1")
URL = "/api/v1/portal/me/visit-summaries"
ZONE = "America/Chicago"


@dataclass
class FakePortalDb:
    tenant_id: UUID
    patient_id: UUID


@dataclass
class Summary:
    row: SummaryRow
    status: str = "current"  # or entered-in-error
    held: bool = False


@dataclass
class World:
    summaries: list[Summary] = field(default_factory=list)
    leaky: bool = False


class FakeReads:
    def __init__(self, world: World) -> None:
        self.world = world

    def _mine(self, db: FakePortalDb) -> list[Summary]:
        return [s for s in self.world.summaries
                if self.world.leaky or s.row.patient_id == db.patient_id]

    async def released(self, db: FakePortalDb, patient_id: UUID) -> list[SummaryRow]:
        return [s.row for s in self._mine(db)
                if s.status == "current" and not s.held
                and (self.world.leaky or s.row.patient_id == patient_id)]

    async def held(self, db: FakePortalDb) -> list[HeldRow]:
        return [HeldRow(s.row.id, s.row.available_at) for s in self.world.summaries
                if s.held and s.row.patient_id == db.patient_id]

    async def practice_time_zone(self, db: FakePortalDb) -> str:
        return ZONE

    async def provider_names(self, db: FakePortalDb, ids: list[UUID]) -> dict[UUID, str]:
        return {i: "Dr. Avery401 Lindqvist58" for i in ids if i == PROVIDER}


def summary(patient: UUID, visit: datetime, **kw: Any) -> Summary:
    return Summary(SummaryRow(uuid4(), patient, visit, ZONE, PROVIDER, "Main office (synthetic)",
                              visit + timedelta(hours=1)), **kw)


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
    application.dependency_overrides[portal_api.portal_summaries] = lambda: FakeReads(world)
    yield application
    application.dependency_overrides.clear()


def as_patient(app: FastAPI, patient: UUID) -> TestClient:
    c = TestClient(app, raise_server_exceptions=False)
    c.headers.update({DEV_PATIENT_HEADER: str(patient), DEV_PATIENT_CLINIC_HEADER: str(CLINIC)})
    return c


@pytest.fixture
def chart(world: World) -> dict[str, Summary]:
    """A: two released summaries, one held, one entered in error. B: one released, one held."""
    rows = {
        # 03:30 UTC on 2 October is still 1 October in Chicago (D40).
        "a-old": summary(ANA, datetime(2026, 10, 2, 3, 30, tzinfo=UTC)),
        "a-new": summary(ANA, datetime(2026, 10, 20, 15, 0, tzinfo=UTC)),
        "a-held": summary(ANA, datetime(2026, 10, 25, 15, 0, tzinfo=UTC), held=True),
        "a-wrong": summary(ANA, datetime(2026, 10, 26, 15, 0, tzinfo=UTC),
                           status="entered-in-error"),
        "b-one": summary(BEN, datetime(2026, 10, 21, 15, 0, tzinfo=UTC)),
        "b-held": summary(BEN, datetime(2026, 10, 22, 15, 0, tzinfo=UTC), held=True),
    }
    world.summaries = list(rows.values())
    return rows


def _ids(response: Any) -> list[str]:
    return [item["id"] for item in response.json()["items"]]


# ------------------------------------------------------------------------------- list (#278)
def test_a_patient_lists_their_summaries_newest_first_with_held_ones_marked(
        app: FastAPI, chart: dict[str, Summary]) -> None:
    r = as_patient(app, ANA).get(URL)
    assert r.status_code == 200, r.text
    assert _ids(r) == [str(chart[k].row.id) for k in ("a-held", "a-new", "a-old")]
    held, new, old = r.json()["items"]
    assert held == {"id": str(chart["a-held"].row.id), "visitDate": "2026-10-25",
                    "releaseStatus": "held"}  # nothing else: no provider, place or content
    assert new == {"id": str(chart["a-new"].row.id), "visitDate": "2026-10-20",
                   "providerDisplayName": "Dr. Avery401 Lindqvist58",
                   "facilityName": "Main office (synthetic)", "releaseStatus": "available",
                   "availableAt": "2026-10-20T16:00:00Z"}
    assert old["visitDate"] == "2026-10-01"  # the facility's day, not UTC's


def test_patient_a_never_sees_patient_b_summaries(app: FastAPI,
                                                   chart: dict[str, Summary]) -> None:
    listed = set(_ids(as_patient(app, ANA).get(URL)))
    assert not listed & {str(chart["b-one"].row.id), str(chart["b-held"].row.id)}
    assert _ids(as_patient(app, BEN).get(URL)) == [
        str(chart["b-held"].row.id), str(chart["b-one"].row.id)]


def test_entered_in_error_summaries_never_appear(app: FastAPI,
                                                  chart: dict[str, Summary]) -> None:
    assert str(chart["a-wrong"].row.id) not in _ids(as_patient(app, ANA).get(URL))
    assert as_patient(app, ANA).get(f"{URL}/{chart['a-wrong'].row.id}").status_code == 404


def test_pages_follow_the_cursor(app: FastAPI, chart: dict[str, Summary]) -> None:
    client = as_patient(app, ANA)
    first = client.get(URL, params={"limit": 2})
    assert len(first.json()["items"]) == 2
    rest = client.get(URL, params={"limit": 2, "cursor": first.json()["nextCursor"]})
    assert _ids(rest) == [str(chart["a-old"].row.id)] and "nextCursor" not in rest.json()


def test_a_broken_policy_still_never_shows_another_patients_summary(
        app: FastAPI, world: World, chart: dict[str, Summary]) -> None:
    world.leaky = True
    listed = _ids(as_patient(app, ANA).get(URL))
    assert str(chart["b-one"].row.id) not in listed and str(chart["a-new"].row.id) in listed
    assert as_patient(app, ANA).get(f"{URL}/{chart['b-one'].row.id}").status_code == 404


# -------------------------------------------------------------------------------- one (#279)
def test_a_patient_reads_their_own_summary(app: FastAPI, chart: dict[str, Summary]) -> None:
    r = as_patient(app, ANA).get(f"{URL}/{chart['a-new'].row.id}")
    assert r.status_code == 200, r.text
    assert r.json()["releaseStatus"] == "available"


def test_a_held_summary_reads_as_held_without_content(app: FastAPI,
                                                      chart: dict[str, Summary]) -> None:
    r = as_patient(app, ANA).get(f"{URL}/{chart['a-held'].row.id}")
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"id", "visitDate", "releaseStatus"}
    assert r.json()["releaseStatus"] == "held"


@pytest.mark.parametrize("key", ["b-one", "b-held"])
def test_another_patients_summary_is_not_found(app: FastAPI, chart: dict[str, Summary],
                                               key: str) -> None:
    r = as_patient(app, ANA).get(f"{URL}/{chart[key].row.id}")
    unknown = as_patient(app, ANA).get(f"{URL}/{uuid4()}")
    assert r.status_code == unknown.status_code == 404
    assert r.json()["type"] == unknown.json()["type"]


# ------------------------------------------------------------------- refusals and validation
@pytest.mark.parametrize("path", ["", "/{id}"])
def test_a_staff_session_is_refused(app: FastAPI, chart: dict[str, Summary], path: str) -> None:
    c = TestClient(app, raise_server_exceptions=False)
    c.headers[DEV_USER_HEADER] = "md"
    assert c.get(URL + path.format(id=chart["a-new"].row.id)).status_code == 401


@pytest.mark.parametrize("path", ["", "/{id}"])
def test_without_the_permission_the_patient_is_refused(
        app: FastAPI, chart: dict[str, Summary], path: str,
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(permissions, "PATIENT_PERMISSIONS",
                        permissions.PATIENT_PERMISSIONS - {"portal-records:read"})
    r = as_patient(app, ANA).get(URL + path.format(id=chart["a-new"].row.id))
    assert r.status_code == 403
    assert r.json()["code"] == "permission-denied"


@pytest.mark.parametrize(("path", "params", "expected"), [
    ("", {"limit": 0}, 422),
    ("", {"limit": 101}, 422),
    ("", {"cursor": "bm90LWEtY3Vyc29y"}, 400),
    ("", {"cursor": "not a cursor!"}, 422),
    ("/not-a-uuid", {}, 422),
])
def test_invalid_requests_are_refused(app: FastAPI, chart: dict[str, Summary], path: str,
                                      params: dict[str, Any], expected: int) -> None:
    r = as_patient(app, ANA).get(URL + path, params=params)
    assert r.status_code == expected, r.text
