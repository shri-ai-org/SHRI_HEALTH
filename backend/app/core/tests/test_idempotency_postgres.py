"""Safe retries (Idempotency-Key) against the real schema, as shri_app (forced RLS, no DELETE).

Needs TEST_DATABASE_URL, migrated to head (app/db/tests/conftest.py). Skipped otherwise. Field
encryption uses the real OpenBao when OPENBAO_TRANSIT_ADDR and OPENBAO_TRANSIT_TOKEN are set (CI),
otherwise a fake Transit. The routes are test stand-ins with real contract operationIds, so
they get those operations' x-idempotency and x-audit. Synthetic values only.
"""

import json
import os
from collections.abc import Iterator
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import APIRouter, Depends, Response
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.crypto import FieldCrypto
from app.core.deps import CurrentUser, current_user, require, tenant_db
from app.core.errors import AppError, Conflict, ServiceUnavailable
from app.core.idempotency import IN_PROGRESS_LEASE, RETENTION, fingerprint
from app.core.routing import API_PREFIX
from app.core.tests.stand_ins import include_first
from app.db.tests import builders as b
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    app_engine,
    db,
    make_tenant,
    open_session,
    switch_to_role,
    tenant,
)
from app.main import create_app

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

ATTEMPT = str(uuid4())  # made at run time: no key-like literal in the source
FACILITIES = f"{API_PREFIX}/facilities"
BODY = {"name": "Synthetic Clinic", "beds": 2}
DB = Depends(tenant_db)


class _RateLimited(AppError):
    default_code = "rate-limited"


class Stand:
    """What the stand-in endpoints did, and what they do next."""

    def __init__(self) -> None:
        self.calls = 0
        self.outcomes: list[str] = []
        self.user: CurrentUser | None = None


def _router(stand: Stand) -> APIRouter:
    router = APIRouter()

    # tenant_db before require(): the key must still be claimed only after the permission check.
    @router.post("/facilities", operation_id="createFacility", status_code=201)
    async def create_facility(body: dict[str, Any], response: Response,
                              session: AsyncSession = DB,
                              user: CurrentUser = Depends(require("practice-setup:create")),
                              ) -> dict[str, Any]:
        stand.calls += 1
        outcome = stand.outcomes.pop(0) if stand.outcomes else "created"
        if outcome == "crash":
            raise RuntimeError("synthetic failure")
        if outcome == "unavailable":
            raise ServiceUnavailable()
        if outcome == "busy":
            raise _RateLimited()
        if outcome == "conflict":
            raise Conflict()
        facility = uuid4()
        response.headers["Location"] = f"{FACILITIES}/{facility}"
        response.headers["X-Per-Request"] = "not stored"
        return {"id": str(facility), "name": body.get("name")}

    @router.post("/patients/{patientId}/payments", operation_id="recordPayment",
                 status_code=201)
    async def record_payment(patientId: UUID, body: dict[str, Any],  # noqa: N803
                             user: CurrentUser = Depends(require("payments:create")),
                             session: AsyncSession = DB) -> dict[str, Any]:
        stand.calls += 1
        return {"id": str(uuid4())}

    @router.post("/encounters", operation_id="createEncounter", status_code=201)
    async def create_encounter(body: dict[str, Any],
                               user: CurrentUser = Depends(require("encounters:create")),
                               session: AsyncSession = DB) -> dict[str, Any]:
        stand.calls += 1  # no audit_patients(): its audit fails, so the response is a 500
        return {}

    return router


def _fake_transit(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    if request.url.path.endswith("/encrypt/shri-fields"):
        return httpx.Response(200, json={"data": {"ciphertext": f"vault:v1:{body['plaintext']}"}})
    return httpx.Response(200, json={"data": {
        "plaintext": body["ciphertext"].removeprefix("vault:v1:")}})


def _down(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


def _crypto(handler: Any = None) -> FieldCrypto:
    addr, token = os.environ.get("OPENBAO_TRANSIT_ADDR"), os.environ.get("OPENBAO_TRANSIT_TOKEN")
    if handler is None and addr and token:
        return FieldCrypto(Settings(environment="test", openbao_transit_addr=addr,
                                    openbao_transit_token=SecretStr(token)))
    return FieldCrypto(Settings(environment="test", openbao_transit_addr="http://bao.test:8200",
                                openbao_transit_token=SecretStr("fake")),
                       transport=httpx.MockTransport(handler or _fake_transit))


def _user(user_id: UUID, tenant_id: UUID, roles: set[str]) -> CurrentUser:
    return CurrentUser(id=user_id, organization_id=tenant_id, roles=frozenset(roles),
                       display_name="Synthetic User")


@pytest.fixture
def people(db: Session, tenant: UUID, admin_engine: Engine,  # noqa: F811
           app_engine: Engine) -> dict[str, Any]:  # noqa: F811
    first = b.practitioner(db, "Rivera", "Elena")["user"]
    second = b.practitioner(db, "Okafor", "Ada")["user"]
    patient = b.patient(db)
    db.commit()
    other_tenant = make_tenant(admin_engine)
    other_db = open_session(app_engine, other_tenant)
    other_id = b.practitioner(other_db, "Lund", "Sami")["user"].id
    other_db.commit()
    other_db.close()
    roles = {"ADM", "FD", "MD"}
    return {"tenant": tenant, "patient": patient.id,
            "user": _user(first.id, tenant, roles), "colleague": _user(second.id, tenant, roles),
            "other_clinic": _user(other_id, other_tenant, roles),
            "no_rights": _user(first.id, tenant, {"MA"})}


@pytest.fixture
def stand(people: dict[str, Any]) -> Stand:
    s = Stand()
    s.user = people["user"]
    return s


@pytest.fixture
def client(stand: Stand) -> Iterator[TestClient]:
    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    app.state.crypto = _crypto()
    include_first(app, _router(stand), prefix=API_PREFIX)  # ahead of the real module routes
    app.dependency_overrides[current_user] = lambda: stand.user
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _post(client: TestClient, body: Any = BODY, key: str | None = ATTEMPT,
          url: str = FACILITIES) -> httpx.Response:
    headers = {"Idempotency-Key": key} if key is not None else {}
    content = body if isinstance(body, str) else json.dumps(body)
    response: httpx.Response = client.post(
        url, content=content, headers={**headers, "Content-Type": "application/json"})
    return response


def _records(admin: Engine, tenant_id: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT user_id, method, path, key, request_hash, state, response_status, "
            "response_headers, response_body_enc, expires_at - now() AS remaining "
            "FROM admin.idempotency_record WHERE tenant_id = :t ORDER BY created_at"),
            {"t": tenant_id}))


def _audited(admin: Engine, tenant_id: UUID, action: str) -> int:
    with admin.connect() as c:
        return int(c.execute(text("SELECT count(*) FROM audit.audit_event WHERE tenant_id = :t "
                                  "AND action = :a"), {"t": tenant_id, "a": action}).scalar_one())


def test_a_retry_gets_the_stored_response_and_the_endpoint_runs_once(
        client: TestClient, stand: Stand, people: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    first = _post(client)
    assert first.status_code == 201
    assert "Idempotent-Replayed" not in first.headers
    # The same request, serialised differently and with the key quoted.
    retry = _post(client, '{"beds":2,  "name":"Synthetic Clinic"}', key=f'"{ATTEMPT.upper()}"')
    assert retry.status_code == 201
    assert retry.json() == first.json()  # the same facility, not a second one
    assert retry.headers["Idempotent-Replayed"] == "true"
    assert retry.headers["Location"] == first.headers["Location"]
    assert retry.headers["Content-Type"] == first.headers["Content-Type"]
    assert "X-Per-Request" not in retry.headers  # only content-type, location and etag replay
    assert stand.calls == 1
    (row,) = _records(admin_engine, people["tenant"])
    assert (row.user_id, row.method, row.path, row.key) == (
        people["user"].id, "POST", FACILITIES, ATTEMPT)
    assert row.request_hash == fingerprint(json.dumps(BODY).encode())
    assert (row.state, row.response_status) == ("done", 201)
    assert row.response_body_enc.startswith("vault:v")  # only ciphertext is stored
    assert "Synthetic Clinic" not in row.response_body_enc
    assert set(row.response_headers) == {"content-type", "location"}
    assert RETENTION - timedelta(minutes=1) < row.remaining <= RETENTION
    assert _audited(admin_engine, people["tenant"], "config-change") == 1  # replay: no new row


def test_the_same_key_with_a_different_body_is_refused(
        client: TestClient, stand: Stand) -> None:
    assert _post(client).status_code == 201
    reused = _post(client, {**BODY, "beds": 3})
    assert reused.status_code == 422
    assert reused.json()["code"] == "idempotency-key-reused"
    assert stand.calls == 1


def test_a_key_still_in_progress_is_409_and_runs_nothing(
        client: TestClient, stand: Stand, people: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    _claimed(admin_engine, people, expires_in="5 minutes")  # another request holds the key
    busy = _post(client)
    assert busy.status_code == 409
    assert busy.json()["code"] == "idempotency-request-in-progress"
    assert stand.calls == 0


def test_a_claim_whose_lease_ran_out_is_taken_over(
        client: TestClient, stand: Stand, people: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    _claimed(admin_engine, people, expires_in="-1 second")  # its request died mid-way
    assert _post(client).status_code == 201
    assert stand.calls == 1
    (row,) = _records(admin_engine, people["tenant"])
    assert (row.state, row.response_status) == ("done", 201)


def _claimed(admin: Engine, people: dict[str, Any], expires_in: str) -> None:
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.idempotency_record (id, tenant_id, user_id, method, path, key, "
            "request_hash, state, expires_at) VALUES (:id, :t, :u, 'POST', :p, :k, :h, "
            "'in-progress', now() + CAST(:e AS interval))"),
            {"id": uuid4(), "t": people["tenant"], "u": people["user"].id, "p": FACILITIES,
             "k": ATTEMPT, "h": fingerprint(json.dumps(BODY).encode()), "e": expires_in})


@pytest.mark.parametrize(("outcome", "status"), [
    ("crash", 500), ("unavailable", 503), ("busy", 429)])
def test_5xx_and_429_are_not_stored_so_a_retry_runs_again(
        client: TestClient, stand: Stand, people: dict[str, Any], admin_engine: Engine,  # noqa: F811
        outcome: str, status: int) -> None:
    stand.outcomes = [outcome]
    assert _post(client).status_code == status
    (row,) = _records(admin_engine, people["tenant"])
    assert row.state == "in-progress" and row.remaining <= timedelta(0)  # released
    retry = _post(client)
    assert retry.status_code == 201
    assert "Idempotent-Replayed" not in retry.headers
    assert stand.calls == 2


def test_a_4xx_is_stored_and_replayed(client: TestClient, stand: Stand) -> None:
    stand.outcomes = ["conflict"]
    first = _post(client)
    assert first.status_code == 409 and first.json()["code"] == "invalid-state-transition"
    retry = _post(client)
    assert retry.status_code == 409
    assert retry.headers["Idempotent-Replayed"] == "true"
    assert retry.headers["Content-Type"] == "application/problem+json"
    assert stand.calls == 1


def test_a_failed_audit_is_a_500_that_is_not_stored(
        client: TestClient, stand: Stand, people: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    url = f"{API_PREFIX}/encounters"
    body = {"patientId": str(people["patient"])}
    assert _post(client, body, url=url).status_code == 500
    assert _post(client, body, url=url).status_code == 500
    assert stand.calls == 2  # the second attempt ran again: nothing was stored


def test_a_required_key_that_is_missing_is_400(
        client: TestClient, stand: Stand, people: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    url = f"{API_PREFIX}/patients/{people['patient']}/payments"
    missing = _post(client, {"amount": "20.00"}, key=None, url=url)
    assert missing.status_code == 400
    assert missing.json()["code"] == "idempotency-key-missing"
    assert stand.calls == 0
    assert _post(client, {"amount": "20.00"}, url=url).status_code == 201
    assert stand.calls == 1


def test_a_supported_key_that_is_missing_runs_without_protection(
        client: TestClient, stand: Stand, people: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    assert _post(client, key=None).status_code == 201
    assert _post(client, key=None).status_code == 201
    assert stand.calls == 2
    assert _records(admin_engine, people["tenant"]) == []


def test_a_key_that_isnt_a_uuid_is_422_naming_the_header(
        client: TestClient, stand: Stand, people: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    refused = _post(client, key="retry-1")
    assert refused.status_code == 422
    assert refused.json()["errors"] == [
        {"in": "header", "name": "Idempotency-Key", "code": "invalid-format"}]
    assert stand.calls == 0
    assert _records(admin_engine, people["tenant"]) == []


def test_a_caller_without_the_permission_claims_nothing(
        client: TestClient, stand: Stand, people: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    stand.user = people["no_rights"]
    denied = _post(client)
    assert denied.status_code == 403
    assert stand.calls == 0
    assert _records(admin_engine, people["tenant"]) == []
    assert _audited(admin_engine, people["tenant"], "access-denied") == 1


def test_the_key_is_scoped_to_the_user_and_the_clinic(
        client: TestClient, stand: Stand, people: dict[str, Any], admin_engine: Engine,  # noqa: F811
        app_engine: Engine) -> None:  # noqa: F811
    assert _post(client).status_code == 201
    stand.user = people["colleague"]  # same clinic, another user, the same key
    assert "Idempotent-Replayed" not in _post(client).headers
    stand.user = people["other_clinic"]
    assert "Idempotent-Replayed" not in _post(client).headers
    assert stand.calls == 3
    assert len(_records(admin_engine, people["tenant"])) == 2
    # Row-level security: the other clinic's session sees only its own record.
    other = open_session(app_engine, people["other_clinic"].organization_id)
    try:
        seen = other.execute(text("SELECT tenant_id FROM admin.idempotency_record")).all()
    finally:
        other.close()
    assert [r.tenant_id for r in seen] == [people["other_clinic"].organization_id]


def test_when_the_response_cant_be_encrypted_it_is_never_stored_or_run_twice(
        client: TestClient, stand: Stand, people: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    client.app.state.crypto = _crypto(_down)  # type: ignore[attr-defined]
    first = _post(client)
    assert first.status_code == 201  # the work is done, so the client gets its answer
    (row,) = _records(admin_engine, people["tenant"])
    assert (row.state, row.response_status, row.response_body_enc) == ("in-progress", None, None)
    assert row.remaining > IN_PROGRESS_LEASE  # held for the retention period
    retry = _post(client)
    assert retry.status_code == 409  # not run again
    assert stand.calls == 1


def test_a_4xx_that_cant_be_encrypted_is_released(
        client: TestClient, stand: Stand, people: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    client.app.state.crypto = _crypto(_down)  # type: ignore[attr-defined]
    stand.outcomes = ["conflict"]
    assert _post(client).status_code == 409
    (row,) = _records(admin_engine, people["tenant"])
    assert row.state == "in-progress" and row.remaining <= timedelta(0)
    client.app.state.crypto = _crypto()  # type: ignore[attr-defined]
    assert _post(client).status_code == 201
    assert stand.calls == 2


def test_a_replay_that_cant_be_decrypted_fails_closed(
        client: TestClient, stand: Stand) -> None:
    assert _post(client).status_code == 201
    client.app.state.crypto = _crypto(_down)  # type: ignore[attr-defined]
    replay = _post(client)
    assert replay.status_code == 500
    assert replay.json()["code"] == "internal-error"
    assert stand.calls == 1

