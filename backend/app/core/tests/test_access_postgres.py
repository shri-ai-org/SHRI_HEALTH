"""Restricted charts and the facility filter against the real schema, as shri_app.

Needs TEST_DATABASE_URL, migrated to head (app/db/tests/conftest.py). Skipped otherwise.
The routes are stand-ins with real contract operationIds, so they get those operations'
permission and audit rules.
"""

import datetime as dt
from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter, Depends, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.access import ensure_chart_access, facility_scope
from app.core.audit import audit_patients
from app.core.config import Settings
from app.core.deps import CurrentUser, current_user, require, tenant_db
from app.core.routing import API_PREFIX
from app.db.tests import builders as b
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    app_engine,
    db,
    switch_to_role,
    tenant,
)
from app.main import create_app

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

DB = Depends(tenant_db)
FACILITY = UUID("fa000000-0000-4000-8000-0000000000f1")
OTHER_FACILITY = UUID("fa000000-0000-4000-8000-0000000000f2")


def _router() -> APIRouter:
    router = APIRouter()

    @router.get("/patients/{patientId}", operation_id="getPatient")
    async def get_patient(patientId: UUID,  # noqa: N803 (contract name)
                          user: CurrentUser = Depends(require("patients:read")),
                          session: AsyncSession = DB) -> dict[str, Any]:
        await session.execute(text("UPDATE clinical.patient SET active = false WHERE id = :p"),
                              {"p": patientId})  # must never be saved by a refusal
        access = await ensure_chart_access(session, user, patientId)
        return {"access": access.value}

    @router.get("/appointments", operation_id="listAppointments")
    async def list_appointments(request: Request, facilityId: UUID | None = None,  # noqa: N803
                                user: CurrentUser = Depends(require("appointments:read")),
                                session: AsyncSession = DB) -> dict[str, Any]:
        await session.execute(text("SELECT 1"))
        audit_patients(request, [])
        return {"facilities": sorted(str(f) for f in facility_scope(user, facilityId))}

    return router


@pytest.fixture
def chart(db: Session, tenant: UUID) -> dict[str, Any]:  # noqa: F811
    staff = b.practitioner(db, "Rivera", "Elena")
    patient = b.patient(db)
    db.commit()
    return {"tenant": tenant, "user_id": staff["user"].id,
            "practitioner_id": staff["practitioner"].id, "patient": patient.id}


@pytest.fixture
def signed_in(chart: dict[str, Any]) -> dict[str, CurrentUser]:
    return {"user": CurrentUser(id=chart["user_id"], organization_id=chart["tenant"],
                                roles=frozenset({"FD", "MD"}), facility_ids=frozenset({FACILITY}),
                                display_name="Elena Rivera")}


@pytest.fixture
def client(signed_in: dict[str, CurrentUser]) -> Iterator[TestClient]:
    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    app.include_router(_router(), prefix=API_PREFIX)
    app.dependency_overrides[current_user] = lambda: signed_in["user"]
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
        assert c.portal is not None
        c.portal.call(app.state.db.dispose)


def _restrict(admin: Engine, patient_id: UUID) -> None:
    with admin.begin() as c:
        c.execute(text("UPDATE clinical.patient SET meta_security = '{R}' WHERE id = :p"),
                  {"p": patient_id})


def _grant(admin: Engine, chart: dict[str, Any], *, expired: bool = False) -> None:
    """A break-glass grant, written as the grant endpoint will (columns differ before and after
    migration 0005, D53)."""
    now = dt.datetime.now(dt.UTC)
    start = now - dt.timedelta(hours=5) if expired else now - dt.timedelta(minutes=1)
    with admin.begin() as c:
        has_code = c.execute(text(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'audit' "
            "AND table_name = 'break_glass_access' AND column_name = 'reason_code')")).scalar_one()
        reason = ("reason_code, reason_text", "'emergency-care', NULL") if has_code else (
            "reason", "'emergency care, patient unconscious'")
        c.execute(text(
            f"INSERT INTO audit.break_glass_access (id, tenant_id, patient_id, user_id, "  # noqa: S608
            f"{reason[0]}, granted_at, expires_at) VALUES (:i, :t, :p, :u, {reason[1]}, :g, :e)"),
            {"i": uuid4(), "t": chart["tenant"], "p": chart["patient"], "u": chart["user_id"],
             "g": start, "e": start + dt.timedelta(hours=4)})


def _care_team(admin: Engine, chart: dict[str, Any], **member: Any) -> None:
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.care_team_member (id, tenant_id, patient_id, practitioner_id, "
            "user_id, role_code, period_start, period_end) "
            "VALUES (:i, :t, :p, :pr, :u, 'PCP', :start, :end)"),
            {"i": uuid4(), "t": chart["tenant"], "p": chart["patient"],
             "pr": member.get("practitioner_id"), "u": member.get("user_id"),
             "start": member.get("start", dt.date.today() - dt.timedelta(days=30)),
             "end": member.get("end")})


def _audit(admin: Engine, tenant_id: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT action, outcome, patient_id, purpose_of_use, reason FROM audit.audit_event "
            "WHERE tenant_id = :t ORDER BY id"), {"t": tenant_id}))


def _active(admin: Engine, patient_id: UUID) -> bool:
    with admin.connect() as c:
        return bool(c.execute(text("SELECT active FROM clinical.patient WHERE id = :p"),
                              {"p": patient_id}).scalar_one())


def test_an_open_chart_is_read_and_audited(client: TestClient, chart: dict[str, Any],
                                           admin_engine: Engine) -> None:  # noqa: F811
    r = client.get(f"{API_PREFIX}/patients/{chart['patient']}")
    assert (r.status_code, r.json()) == (200, {"access": "open"})
    (row,) = _audit(admin_engine, chart["tenant"])
    assert (row.action, row.purpose_of_use) == ("read", None)


def test_a_restricted_chart_needs_break_glass_and_the_refusal_is_kept(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])
    r = client.get(f"{API_PREFIX}/patients/{chart['patient']}")
    assert r.status_code == 403 and r.json()["code"] == "break-glass-required"
    (row,) = _audit(admin_engine, chart["tenant"])
    assert (row.action, row.outcome, row.patient_id) == ("access-denied", "denied",
                                                         chart["patient"])
    assert row.reason == "break-glass-required: restricted chart"
    assert _active(admin_engine, chart["patient"])  # the endpoint's own change was not saved


def test_a_current_grant_opens_it_and_marks_emergency_access(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])
    _grant(admin_engine, chart)
    r = client.get(f"{API_PREFIX}/patients/{chart['patient']}")
    assert (r.status_code, r.json()) == (200, {"access": "break-glass"})
    (row,) = _audit(admin_engine, chart["tenant"])
    assert (row.action, row.patient_id, row.purpose_of_use) == ("read", chart["patient"], "ETREAT")


def test_an_expired_grant_does_not(client: TestClient, chart: dict[str, Any],
                                   admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])
    _grant(admin_engine, chart, expired=True)
    assert client.get(f"{API_PREFIX}/patients/{chart['patient']}").status_code == 403


@pytest.mark.parametrize("by", ["user", "practitioner"])
def test_the_care_team_opens_it_without_break_glass(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine, by: str) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])
    _care_team(admin_engine, chart, **{f"{by}_id": chart[f"{by}_id"]})
    r = client.get(f"{API_PREFIX}/patients/{chart['patient']}")
    assert (r.status_code, r.json()) == (200, {"access": "care-team"})


def test_a_past_care_team_member_needs_break_glass(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])
    _care_team(admin_engine, chart, user_id=chart["user_id"],
               start=dt.date.today() - dt.timedelta(days=60),
               end=dt.date.today() - dt.timedelta(days=1))
    assert client.get(f"{API_PREFIX}/patients/{chart['patient']}").status_code == 403


def test_an_unknown_patient_is_not_found_and_not_audited_as_a_chart(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    assert client.get(f"{API_PREFIX}/patients/{uuid4()}").status_code == 404
    assert _audit(admin_engine, chart["tenant"]) == []


def test_a_facility_filter_the_user_is_not_assigned_to_is_not_found(
        client: TestClient) -> None:
    ok = client.get(f"{API_PREFIX}/appointments", params={"facilityId": str(FACILITY)})
    assert (ok.status_code, ok.json()) == (200, {"facilities": [str(FACILITY)]})
    assert client.get(f"{API_PREFIX}/appointments").json() == {"facilities": [str(FACILITY)]}
    other = client.get(f"{API_PREFIX}/appointments", params={"facilityId": str(OTHER_FACILITY)})
    assert other.status_code == 404


def test_a_missing_permission_is_reported_before_the_facility(
        client: TestClient, chart: dict[str, Any], signed_in: dict[str, CurrentUser]) -> None:
    signed_in["user"] = CurrentUser(id=chart["user_id"], organization_id=chart["tenant"],
                                    roles=frozenset({"DSP"}), facility_ids=frozenset({FACILITY}))
    r = client.get(f"{API_PREFIX}/appointments", params={"facilityId": str(OTHER_FACILITY)})
    assert r.status_code == 403 and r.json()["code"] == "permission-denied"
