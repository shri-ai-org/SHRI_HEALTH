"""Safe retries (Idempotency-Key) on portal writes: portal_db claims the key, keyed by the
session's clinic and patient, in the API's memory (idempotency.PortalKeys), as shri_portal.

Needs TEST_DATABASE_URL, migrated to head (app/db/tests/conftest.py). Skipped otherwise. The
operation is a stand-in shaped like the portal's booking (x-idempotency: required, x-audit
patient: session), added to a copy of the contract's operations map. Synthetic values only.
"""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter, Depends
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.deps import PortalPatient, current_patient, portal_db, portal_session
from app.core.idempotency import fingerprint, portal_keys
from app.core.operations import OPERATIONS_PATH_ENV, operations_file
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

ATTEMPT = str(uuid4())  # made at run time: no key-like literal in the source
PATH = f"{API_PREFIX}/portal/me/test-bookings"
BODY = {"slot": "synthetic-slot-1"}
FAKE_OPERATIONS = {
    "bookTestPortalSlot": {
        "method": "POST", "path": PATH, "permission": "public", "idempotency": "required",
        "audit": {"action": "C", "category": "phi-write", "patient": "session",
                  "actor": "patient"}},
}


class Stand:
    """Who is signed in, what the endpoint did, and what it does next."""

    def __init__(self, patient: PortalPatient) -> None:
        self.patient = patient
        self.calls = 0
        self.outcomes: list[str] = []


def _router(stand: Stand) -> APIRouter:
    router = APIRouter()

    @router.post("/portal/me/test-bookings", operation_id="bookTestPortalSlot",
                 status_code=201)
    async def book(body: dict[str, Any], patient: PortalPatient = Depends(portal_session),
                   session: AsyncSession = Depends(portal_db)) -> dict[str, Any]:
        stand.calls += 1
        if (stand.outcomes.pop(0) if stand.outcomes else "") == "crash":
            raise RuntimeError("synthetic failure")
        role = (await session.execute(text("SELECT current_user"))).scalar_one()
        await session.commit()  # the audit row goes in with it, as shri_portal
        return {"call": stand.calls, "patient": str(patient.patient_id), "role": role}

    return router


@pytest.fixture
def chart(db: Session, tenant: UUID) -> dict[str, Any]:  # noqa: F811
    me, other = b.patient(db), b.patient(db)
    db.commit()
    return {"tenant": tenant, "patient": me.id, "other": other.id}


@pytest.fixture
def stand(chart: dict[str, Any]) -> Stand:
    return Stand(PortalPatient(patient_id=chart["patient"], organization_id=chart["tenant"]))


@pytest.fixture
def client(stand: Stand, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    current = json.loads(operations_file().read_text(encoding="utf-8"))
    current["operations"].update(FAKE_OPERATIONS)
    path = tmp_path / "operations.json"
    path.write_text(json.dumps(current), encoding="utf-8")
    monkeypatch.setenv(OPERATIONS_PATH_ENV, str(path))

    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              database_url=TEST_DATABASE_URL,
                              portal_database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    switch_to_role(app.state.portal_db.engine.sync_engine, "shri_portal")
    include_first(app, _router(stand), prefix=API_PREFIX)  # ahead of the real module routes
    app.dependency_overrides[current_patient] = lambda: stand.patient
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
        assert c.portal is not None
        c.portal.call(app.state.db.dispose)
        c.portal.call(app.state.portal_db.dispose)


def _post(client: TestClient, body: Any = BODY, key: str | None = ATTEMPT) -> Any:
    headers = {"Idempotency-Key": key} if key is not None else {}
    return client.post(PATH, content=json.dumps(body),
                       headers={**headers, "Content-Type": "application/json"})


def _stored_rows(admin: Engine, tenant_id: UUID) -> int:
    with admin.connect() as c:
        return int(c.execute(text("SELECT count(*) FROM admin.idempotency_record "
                                  "WHERE tenant_id = :t"), {"t": tenant_id}).scalar_one())


def test_a_retry_gets_the_stored_response_and_the_booking_runs_once(
        client: TestClient, stand: Stand, chart: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    first = _post(client)
    assert first.status_code == 201, first.text
    assert first.json() == {"call": 1, "patient": str(chart["patient"]), "role": "shri_portal"}
    again = _post(client)
    assert (again.status_code, again.json()) == (201, first.json())
    assert again.headers["Idempotent-Replayed"] == "true"
    assert stand.calls == 1
    assert _stored_rows(admin_engine, chart["tenant"]) == 0  # memory only, not the staff table


def test_the_same_key_with_a_different_body_is_refused(client: TestClient, stand: Stand) -> None:
    assert _post(client).status_code == 201
    reused = _post(client, body={"slot": "synthetic-slot-2"})
    assert (reused.status_code, reused.json()["code"]) == (422, "idempotency-key-reused")
    assert stand.calls == 1


def test_a_required_key_that_is_missing_is_400(client: TestClient, stand: Stand) -> None:
    missing = _post(client, key=None)
    assert (missing.status_code, missing.json()["code"]) == (400, "idempotency-key-missing")
    assert stand.calls == 0


def test_a_key_that_isnt_a_uuid_is_422_naming_the_header(client: TestClient,
                                                        stand: Stand) -> None:
    bad = _post(client, key="not-a-uuid")
    assert bad.status_code == 422
    assert bad.json()["errors"] == [
        {"in": "header", "name": "Idempotency-Key", "code": "invalid-format"}]
    assert stand.calls == 0


def test_the_key_is_scoped_to_the_sessions_patient(client: TestClient, stand: Stand,
                                                   chart: dict[str, Any]) -> None:
    assert _post(client).json()["call"] == 1
    stand.patient = PortalPatient(patient_id=chart["other"], organization_id=chart["tenant"])
    theirs = _post(client)  # the same key from another patient is their own request
    assert theirs.status_code == 201
    assert theirs.json()["call"] == 2 and "Idempotent-Replayed" not in theirs.headers
    assert theirs.json()["patient"] == str(chart["other"])


def test_a_key_still_in_progress_is_409_and_runs_nothing(client: TestClient, stand: Stand,
                                                         chart: dict[str, Any]) -> None:
    from datetime import UTC, datetime

    app: Any = client.app
    portal_keys(app).find_or_claim(
        (chart["tenant"], chart["patient"], "POST", PATH, ATTEMPT),
        fingerprint(json.dumps(BODY).encode()), datetime.now(UTC))
    busy = _post(client)
    assert (busy.status_code, busy.json()["code"]) == (409, "idempotency-request-in-progress")
    assert stand.calls == 0


def test_a_500_is_not_stored_so_a_retry_runs_again(client: TestClient, stand: Stand) -> None:
    stand.outcomes = ["crash"]
    assert _post(client).status_code == 500
    retried = _post(client)
    assert retried.status_code == 201 and "Idempotent-Replayed" not in retried.headers
    assert stand.calls == 2
