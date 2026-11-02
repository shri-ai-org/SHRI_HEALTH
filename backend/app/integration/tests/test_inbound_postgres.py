"""The partner callback receivers against the real schema, as shri_app, and the whole loop: a
message queued in a clinic, sent by the worker (as shri_integration) through the simulated payer,
whose signed reply comes back through /hooks/clearinghouse to the module's handler in the same
clinic. Needs TEST_DATABASE_URL, migrated to head; skipped otherwise. Synthetic data only."""

import json
import secrets
from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.db import Database
from app.core.partner_hooks import sign
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    make_tenant,
    switch_to_role,
)
from app.integration import inbound, outbound
from app.integration.inbound import Rejected
from app.integration.simulated import SimulatedPartner, payer_answer
from app.integration.worker import OutboxWorker
from app.main import create_app

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

SECRET_LOOKING = "Kaia401 Lindgren118"  # a handler's exception text must never be kept


def _settings() -> Settings:
    return Settings(environment="test", auth_mode="dev_header", database_url=TEST_DATABASE_URL,
                    hook_secret_clearinghouse=SecretStr(secrets.token_hex(32)),
                    hook_secret_erx=SecretStr(secrets.token_hex(32)),
                    simulated_partners=True, simulated_partner_callback_url="http://api.test")


@pytest.fixture
def app() -> Iterator[FastAPI]:
    found = create_app(_settings())
    switch_to_role(found.state.db.engine.sync_engine, "shri_app")
    yield found


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
        assert c.portal is not None
        c.portal.call(app.state.db.dispose)


@pytest.fixture
def filed(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """A stand-in for the eligibility module's 271 handler: records the clinic and message."""
    seen: list[tuple[str, dict[str, Any]]] = []

    async def file_271(db: AsyncSession, message: dict[str, Any]) -> None:
        clinic = (await db.execute(text(
            "SELECT current_setting('app.current_tenant_id', true)"))).scalar_one()
        seen.append((clinic, message))
        if message["correlationId"] == "00000000-0000-4000-8000-00000000dead":
            raise Rejected("unknown-correlation")
        if message["correlationId"] == "00000000-0000-4000-8000-0000000000ff":
            raise RuntimeError(f"bad reply about {SECRET_LOOKING}")

    monkeypatch.setitem(inbound._HANDLERS, ("clearinghouse", "271"), file_271)
    return seen


def _clinic(admin: Engine, kind: str = "clearinghouse",
            adapter: str = "simulated-clearinghouse") -> dict[str, UUID]:
    tenant = make_tenant(admin)
    endpoint = uuid4()
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.integration_endpoint (id, tenant_id, kind, adapter, name, "
            "environment, baa_on_file, is_active) VALUES (:i, :t, :k, :a, 'Simulated', "
            "'test', false, true)"), {"i": endpoint, "t": tenant, "k": kind, "a": adapter})
    return {"tenant": tenant, "endpoint": endpoint}


def _271(correlation: str | None = None) -> dict[str, Any]:
    return payer_answer({"correlationId": correlation or str(uuid4()),
                         "subscriber": {"memberId": "TEST-M0012345"}})


def _post(client: TestClient, app: FastAPI, clinic: UUID, message: dict[str, Any],
          partner: str = "clearinghouse", message_id: str | None = None) -> httpx.Response:
    body = json.dumps(message).encode()
    headers = sign(app.state.settings, partner, message_id or message["responseId"], clinic, body)
    response: httpx.Response = client.post(f"/hooks/{partner}", content=body, headers=headers)
    return response


def _inbound(admin: Engine, tenant: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT status, message_type, control_id, last_error, processed_at "
            "FROM admin.integration_message WHERE tenant_id = :t AND direction = 'inbound'"),
            {"t": tenant}))


def _audit(admin: Engine, tenant: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT actor_type, actor_display, action, category, entity_type "
            "FROM audit.audit_event WHERE tenant_id = :t"), {"t": tenant}))


def test_a_signed_reply_is_recorded_audited_and_filed_in_its_clinic(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any]]]) -> None:
    clinic = _clinic(admin_engine)
    message = _271()

    r = _post(client, app, clinic["tenant"], message)

    assert (r.status_code, r.content) == (200, b"")
    assert filed == [(str(clinic["tenant"]), message)]
    (row,) = _inbound(admin_engine, clinic["tenant"])
    assert (row.status, row.message_type, row.control_id) == ("processed", "271",
                                                              message["responseId"])
    assert row.processed_at is not None
    (entry,) = _audit(admin_engine, clinic["tenant"])
    assert tuple(entry) == ("partner", "clearinghouse", "create", "phi-write",
                            "integration-message")


def test_a_repeat_is_accepted_and_ignored(client: TestClient, app: FastAPI,
                                          admin_engine: Engine,  # noqa: F811
                                          filed: list[tuple[str, dict[str, Any]]]) -> None:
    clinic = _clinic(admin_engine)
    message = _271()
    assert _post(client, app, clinic["tenant"], message).status_code == 200
    assert _post(client, app, clinic["tenant"], message).status_code == 200
    assert len(filed) == 1
    assert len(_inbound(admin_engine, clinic["tenant"])) == 1


def test_a_refused_or_failing_message_is_kept_with_a_code_only(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any]]]) -> None:
    clinic = _clinic(admin_engine)
    assert _post(client, app, clinic["tenant"],
                 _271("00000000-0000-4000-8000-00000000dead")).status_code == 200
    assert _post(client, app, clinic["tenant"],
                 _271("00000000-0000-4000-8000-0000000000ff")).status_code == 200
    rows = _inbound(admin_engine, clinic["tenant"])
    assert sorted((r.status, r.last_error) for r in rows) == [
        ("failed", "internal-error"), ("failed", "unknown-correlation")]
    assert all(SECRET_LOOKING not in (r.last_error or "") for r in rows)


def test_a_message_no_module_handles_is_dead_lettered(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(inbound._HANDLERS, ("clearinghouse", "271"), raising=False)
    clinic = _clinic(admin_engine)
    assert _post(client, app, clinic["tenant"], _271()).status_code == 200
    (row,) = _inbound(admin_engine, clinic["tenant"])
    assert (row.status, row.last_error) == ("dead-letter", "no-handler")


def test_a_clinic_without_that_partner_or_a_bad_signature_is_401_and_nothing_is_kept(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any]]]) -> None:
    pharmacy_only = _clinic(admin_engine, "erx", "simulated-erx")
    assert _post(client, app, pharmacy_only["tenant"], _271()).status_code == 401
    assert _post(client, app, uuid4(), _271()).status_code == 401  # no such clinic
    clinic = _clinic(admin_engine)
    body = json.dumps(_271()).encode()
    headers = sign(app.state.settings, "clearinghouse", "SIM-1", clinic["tenant"], body)
    headers["webhook-signature"] = "v1," + "A" * 44
    assert client.post("/hooks/clearinghouse", content=body, headers=headers).status_code == 401
    assert filed == []
    assert _inbound(admin_engine, clinic["tenant"]) == []
    assert _inbound(admin_engine, pharmacy_only["tenant"]) == []


@pytest.mark.parametrize("change", [
    {"messageType": "RxStatus"},  # a pharmacy message on the clearinghouse
    {"unexpected": "field"},
    {"correlationId": "not-a-uuid"},
])
def test_a_message_outside_the_envelope_is_400(client: TestClient, app: FastAPI,
                                                admin_engine: Engine,  # noqa: F811
                                                change: dict[str, str]) -> None:
    clinic = _clinic(admin_engine)
    r = _post(client, app, clinic["tenant"], _271() | change)
    assert (r.status_code, r.json()["code"]) == (400, "malformed-request")
    assert _inbound(admin_engine, clinic["tenant"]) == []


async def test_the_whole_loop_from_the_outbox_to_the_module(
        app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any]]], monkeypatch: pytest.MonkeyPatch) -> None:
    clinic = _clinic(admin_engine)
    check_id = str(uuid4())

    async def build_270(db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        return {"messageType": "270", "schemaVersion": "1.0",
                "correlationId": payload["eligibilityCheckId"],
                "subscriber": {"memberId": "TEST-M0012345"}}

    monkeypatch.setitem(outbound._BUILDERS, ("clearinghouse", "270"), build_270)
    with admin_engine.begin() as c:
        c.execute(text(
            "INSERT INTO admin.integration_message (id, tenant_id, endpoint_id, direction, "
            "message_type, status, idempotency_key, payload, attempts, max_attempts) "
            "VALUES (:i, :t, :e, 'outbound', '270', 'queued', :k, CAST(:p AS jsonb), 0, 8)"),
            {"i": uuid4(), "t": clinic["tenant"], "e": clinic["endpoint"], "k": f"270:{check_id}",
             "p": json.dumps({"eligibilityCheckId": check_id})})
    worker_db = Database(Settings(environment="test", database_url=TEST_DATABASE_URL))
    switch_to_role(worker_db.engine.sync_engine, "shri_integration")
    to_api = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api.test")
    partner = SimulatedPartner(app.state.settings, "clearinghouse", client=to_api, delay=0)
    try:
        await OutboxWorker(worker_db, {"simulated-clearinghouse": partner}, batch=500).run_once()
        await partner.drain()
    finally:
        await partner.aclose()
        await worker_db.dispose()
        await app.state.db.dispose()

    mine = [m for clinic_id, m in filed if m["correlationId"] == check_id]
    assert len(mine) == 1 and mine[0]["result"] == "active"
    assert [c for c, m in filed if m["correlationId"] == check_id] == [str(clinic["tenant"])]
    (row,) = _inbound(admin_engine, clinic["tenant"])
    assert row.status == "processed"
