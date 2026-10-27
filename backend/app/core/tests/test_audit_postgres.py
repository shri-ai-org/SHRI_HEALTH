"""Audit from x-audit against the real schema, as shri_app (forced RLS, insert-only audit table).

Needs TEST_DATABASE_URL, migrated to head (app/db/tests/conftest.py). Skipped otherwise.
The routes are test stand-ins that use real contract operationIds, so they get those
operations' x-audit; they do nothing a real endpoint would.
"""

from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter, Depends, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.audit import audit_patients
from app.core.config import Settings
from app.core.deps import CurrentUser, current_user, require, tenant_db
from app.core.routing import API_PREFIX
from app.db.models import FHIR_RESOURCES
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

REQUEST_ID = "6f1c2a7e-3b4d-4c5e-8f9a-0b1c2d3e4f50"
Patient = FHIR_RESOURCES["Patient"]
DB = Depends(tenant_db)
DEACTIVATE = text("UPDATE clinical.patient SET active = false WHERE id = :p")


def _router() -> APIRouter:
    router = APIRouter()

    @router.get("/patients/{patientId}", operation_id="getPatient")
    async def get_patient(patientId: UUID, request: Request,  # noqa: N803 (contract name)
                          user: CurrentUser = Depends(require("patients:read")),
                          session: AsyncSession = DB) -> dict[str, Any]:
        await session.execute(DEACTIVATE, {"p": patientId})  # never committed: must not be saved
        return {}

    @router.patch("/patients/{patientId}", operation_id="updatePatient")
    async def update_patient(patientId: UUID,  # noqa: N803
                             user: CurrentUser = Depends(require("patients:update")),
                             session: AsyncSession = DB) -> dict[str, Any]:
        await session.execute(DEACTIVATE, {"p": patientId})
        await session.commit()
        return {}

    @router.post("/patients/search", operation_id="searchPatients")
    async def search(request: Request, body: dict[str, Any],
                     user: CurrentUser = Depends(require("patients:search")),
                     session: AsyncSession = DB) -> dict[str, Any]:
        audit_patients(request, [UUID(i) for i in body["ids"]])
        return {}

    @router.post("/patients", operation_id="registerPatient")
    async def register(request: Request, body: dict[str, Any],
                       user: CurrentUser = Depends(require("patients:create")),
                       session: AsyncSession = DB) -> dict[str, Any]:
        await session.execute(DEACTIVATE, {"p": body["id"]})
        await session.commit()  # without audit_patients(): the commit must be refused
        return {}

    @router.post("/patients/{patientId}/allergies", operation_id="addAllergy")
    async def commit_twice(patientId: UUID, second: str,  # noqa: N803
                           user: CurrentUser = Depends(require("allergies:create")),
                           session: AsyncSession = DB) -> dict[str, Any]:
        await session.execute(DEACTIVATE, {"p": patientId})
        await session.commit()  # the change and its audit row
        if second == "text":
            await session.execute(text("UPDATE clinical.patient SET gender = 'male' WHERE id = :p"),
                                  {"p": patientId})
        elif second == "core":
            await session.execute(update(Patient).where(Patient.id == patientId)
                                  .values(gender="male"))
        elif second in ("orm", "flushed"):
            patient = await session.get(Patient, patientId)
            assert patient is not None
            patient.gender = "male"
            if second == "flushed":
                await session.flush()  # out of session.dirty before the commit
        await session.commit()  # refused with changes; allowed with none
        return {}

    return router


@pytest.fixture
def chart(db: Session, tenant: UUID) -> dict[str, Any]:  # noqa: F811
    user = b.practitioner(db, "Rivera", "Elena")["user"]
    patient = b.patient(db)
    db.commit()
    return {"tenant": tenant, "user_id": user.id, "patient": patient.id}


@pytest.fixture
def signed_in(chart: dict[str, Any]) -> dict[str, CurrentUser]:
    return {"user": CurrentUser(id=chart["user_id"], organization_id=chart["tenant"],
                                roles=frozenset({"FD", "MA", "MD"}), display_name="Elena Rivera")}


@pytest.fixture
def client(signed_in: dict[str, CurrentUser]) -> Iterator[TestClient]:
    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    app.include_router(_router(), prefix=API_PREFIX)
    app.dependency_overrides[current_user] = lambda: signed_in["user"]
    with TestClient(app, raise_server_exceptions=False,
                    headers={"X-Request-ID": REQUEST_ID}) as c:
        yield c
        assert c.portal is not None
        c.portal.call(app.state.db.dispose)


def _audit_rows(admin: Engine, tenant_id: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT action, outcome, patient_id, entity_type, entity_id, actor_user_id, "
            "correlation_id, reason, chain_seq FROM audit.audit_event WHERE tenant_id = :t "
            "ORDER BY id"), {"t": tenant_id}))


def _active(admin: Engine, patient_id: UUID) -> bool:
    with admin.connect() as c:
        return bool(c.execute(text("SELECT active IS DISTINCT FROM false FROM clinical.patient "
                                   "WHERE id = :p"), {"p": patient_id}).scalar_one())


def test_a_read_is_audited_and_its_uncommitted_writes_are_dropped(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    pt = chart["patient"]
    assert client.get(f"{API_PREFIX}/patients/{pt}").status_code == 200
    (row,) = _audit_rows(admin_engine, chart["tenant"])
    assert (row.action, row.outcome, row.patient_id) == ("read", "success", pt)
    assert (row.entity_type, row.entity_id) == ("patients", str(pt))
    assert row.actor_user_id == chart["user_id"]
    assert row.correlation_id == REQUEST_ID
    assert row.chain_seq is not None  # the hash chain trigger ran
    assert _active(admin_engine, pt)


def test_a_write_and_its_audit_row_commit_together(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    pt = chart["patient"]
    assert client.patch(f"{API_PREFIX}/patients/{pt}", json={}).status_code == 200
    (row,) = _audit_rows(admin_engine, chart["tenant"])
    assert (row.action, row.patient_id) == ("update", pt)
    assert not _active(admin_engine, pt)


def test_a_write_whose_audit_fails_is_not_saved(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    pt = chart["patient"]
    assert client.post(f"{API_PREFIX}/patients", json={"id": str(pt)}).status_code == 500
    assert _audit_rows(admin_engine, chart["tenant"]) == []
    assert _active(admin_engine, pt)


def test_a_search_records_every_patient_returned(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    pt = chart["patient"]
    response = client.post(f"{API_PREFIX}/patients/search", json={"ids": [str(pt)]})
    assert response.status_code == 200
    assert [r.patient_id for r in _audit_rows(admin_engine, chart["tenant"])] == [pt]
    client.post(f"{API_PREFIX}/patients/search", json={"ids": []})
    assert [r.patient_id for r in _audit_rows(admin_engine, chart["tenant"])] == [pt, None]


def test_a_refused_permission_is_a_security_event(
        client: TestClient, chart: dict[str, Any], signed_in: dict[str, CurrentUser],
        admin_engine: Engine) -> None:  # noqa: F811
    signed_in["user"] = CurrentUser(id=chart["user_id"], organization_id=chart["tenant"],
                                    roles=frozenset({"DSP"}))  # no patients:read
    stranger = uuid4()
    assert client.get(f"{API_PREFIX}/patients/{stranger}").status_code == 403
    (row,) = _audit_rows(admin_engine, chart["tenant"])
    assert (row.action, row.outcome, row.patient_id) == ("access-denied", "denied", None)
    assert (row.entity_type, row.entity_id) == ("patients", str(stranger))
    assert row.reason == "permission-denied: requires patients:read"


def _gender(admin: Engine, patient_id: UUID) -> str:
    with admin.connect() as c:
        return str(c.execute(text("SELECT gender FROM clinical.patient WHERE id = :p"),
                             {"p": patient_id}).scalar_one())


@pytest.mark.parametrize("second", ["text", "core", "orm", "flushed"])
def test_a_second_commit_with_changes_is_refused_and_not_saved(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine,  # noqa: F811
        second: str) -> None:
    pt = chart["patient"]
    r = client.post(f"{API_PREFIX}/patients/{pt}/allergies", params={"second": second})
    assert r.status_code == 500 and r.json()["code"] == "internal-error"
    assert _gender(admin_engine, pt) == "female"  # the second change was never saved
    assert not _active(admin_engine, pt)  # the first, with its audit row, was
    assert [row.action for row in _audit_rows(admin_engine, chart["tenant"])] == ["create"]


def test_a_second_commit_with_nothing_to_save_is_fine(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    pt = chart["patient"]
    assert client.post(f"{API_PREFIX}/patients/{pt}/allergies",
                       params={"second": "none"}).status_code == 200
    assert [row.action for row in _audit_rows(admin_engine, chart["tenant"])] == ["create"]
