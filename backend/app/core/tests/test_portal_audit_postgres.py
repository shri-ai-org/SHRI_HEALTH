"""Portal audit rows against the real schema, with a fake portal session (patient sign-in and
the shri_portal role don't exist yet: ADR-0013, D93).

Needs TEST_DATABASE_URL, migrated to head (app/db/tests/conftest.py). Skipped otherwise.
The two operations are stand-ins shaped like #73's portal operations (x-audit patient:
session, actor: patient), added to a copy of the contract's operations map.
"""

import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter, Depends, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core import audit
from app.core.config import Settings
from app.core.deps import CurrentUser, PortalPatient, current_patient, portal_db, portal_session
from app.core.operations import OPERATIONS_PATH_ENV, operations_file
from app.core.request_id import current_request_id
from app.core.routing import API_PREFIX
from app.core.tests.stand_ins import include_first
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

PORTAL_AUDIT = {"patient": "session", "actor": "patient"}
FAKE_OPERATIONS = {
    "requestMyProfileChange": {
        "method": "POST", "path": f"{API_PREFIX}/portal/me/profile/change-requests",
        "permission": "public", "idempotency": None,
        "audit": {"action": "C", "category": "phi-write", **PORTAL_AUDIT}},
    "getMyVisitSummaries": {
        "method": "GET", "path": f"{API_PREFIX}/portal/me/visit-summaries",
        "permission": "public", "idempotency": None,
        "audit": {"action": "R", "category": "phi-read", **PORTAL_AUDIT}},
}


async def fake_portal_db(request: Request, patient: PortalPatient = Depends(portal_session)
                         ) -> AsyncIterator[AsyncSession]:
    """Stands in for the shri_portal session (D93): a clinic session that starts the portal
    audit trail, as the real portal_db will."""
    session = request.app.state.db.tenant_session(patient.organization_id, patient.patient_id,
                                                  current_request_id())
    audit.start_portal_trail(request, patient, session)
    async with session:
        yield session


async def staff_db(request: Request) -> AsyncIterator[AsyncSession]:
    """A session with no portal session behind it: what a misbuilt portal route would have."""
    user = request.app.state.test_staff
    session = request.app.state.db.tenant_session(user.organization_id, user.id,
                                                  current_request_id())
    audit.start_trail(request, user, session)
    async with session:
        yield session


def _router() -> APIRouter:
    router = APIRouter()

    @router.post("/portal/me/profile/change-requests", operation_id="requestMyProfileChange")
    async def change(body: dict[str, Any], patientId: UUID | None = None,  # noqa: N803
                     patient: PortalPatient = Depends(portal_session),
                     session: AsyncSession = Depends(portal_db)) -> dict[str, Any]:
        return {"patient": str(patient.patient_id)}

    @router.get("/portal/me/visit-summaries", operation_id="getMyVisitSummaries")
    async def summaries(session: AsyncSession = Depends(staff_db)) -> dict[str, Any]:
        return {}

    return router


@pytest.fixture
def chart(db: Session, tenant: UUID) -> dict[str, Any]:  # noqa: F811
    staff = b.practitioner(db, "Rivera", "Elena")["user"]
    patient = b.patient(db)
    db.commit()
    return {"tenant": tenant, "patient": patient.id, "staff": staff.id}


@pytest.fixture
def client(chart: dict[str, Any], tmp_path: Path,
           monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    current = json.loads(operations_file().read_text(encoding="utf-8"))
    current["operations"].update(FAKE_OPERATIONS)
    path = tmp_path / "operations.json"
    path.write_text(json.dumps(current), encoding="utf-8")
    monkeypatch.setenv(OPERATIONS_PATH_ENV, str(path))

    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    include_first(app, _router(), prefix=API_PREFIX)  # ahead of the real module routes
    app.state.test_staff = CurrentUser(id=chart["staff"], organization_id=chart["tenant"],
                                       roles=frozenset({"FD"}))
    app.dependency_overrides[current_patient] = lambda: PortalPatient(
        patient_id=chart["patient"], organization_id=chart["tenant"])
    app.dependency_overrides[portal_db] = fake_portal_db
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
        assert c.portal is not None
        c.portal.call(app.state.db.dispose)


def _rows(admin: Engine, tenant_id: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT actor_type, actor_user_id, patient_id, action, entity_type "
            "FROM audit.audit_event WHERE tenant_id = :t ORDER BY id"), {"t": tenant_id}))


def test_the_patient_and_the_actor_come_from_the_portal_session(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    r = client.post(f"{API_PREFIX}/portal/me/profile/change-requests", json={})
    assert r.status_code == 200
    (row,) = _rows(admin_engine, chart["tenant"])
    assert (row.actor_type, row.actor_user_id, row.patient_id) == (
        "patient", None, chart["patient"])
    assert (row.action, row.entity_type) == ("create", "portal")


def test_a_patient_named_in_the_body_or_query_is_ignored(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    other = str(uuid4())
    r = client.post(f"{API_PREFIX}/portal/me/profile/change-requests",
                    params={"patientId": other}, json={"patientId": other})
    assert r.status_code == 200 and r.json() == {"patient": str(chart["patient"])}
    assert [row.patient_id for row in _rows(admin_engine, chart["tenant"])] == [chart["patient"]]


def test_without_a_portal_session_the_request_fails_closed(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    r = client.get(f"{API_PREFIX}/portal/me/visit-summaries")
    assert r.status_code == 500 and r.json()["code"] == "internal-error"
    assert _rows(admin_engine, chart["tenant"]) == []


def test_without_portal_sign_in_the_request_is_refused(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    del client.app.dependency_overrides[current_patient]  # type: ignore[attr-defined]
    r = client.post(f"{API_PREFIX}/portal/me/profile/change-requests", json={})
    assert r.status_code == 401
    assert _rows(admin_engine, chart["tenant"]) == []
