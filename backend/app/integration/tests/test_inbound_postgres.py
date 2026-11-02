"""The partner callback receivers against the real schema, as shri_app, and the whole loop: a
message queued in a clinic, sent by the worker (as shri_integration) through the simulated payer,
whose signed reply comes back through /hooks/clearinghouse to the module's handler in the same
clinic. Needs TEST_DATABASE_URL, migrated to head; skipped otherwise. Synthetic data only."""

import json
import secrets
from collections.abc import Iterator
from dataclasses import dataclass
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
from app.core.errors import NotFound, ValidationFailed
from app.core.partner_hooks import sign
from app.db.tests import builders as b
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    app_engine,
    make_tenant,
    open_session,
    switch_to_role,
)
from app.integration import inbound, outbound
from app.integration.inbound import Rejected
from app.integration.simulated import SimulatedPartner, payer_answer
from app.integration.worker import DeliveryError, OutboxWorker

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

SECRET_LOOKING = "Kaia401 Lindgren118"  # a handler's exception text must never be kept
PATIENTS: dict[str, UUID] = {}  # clinic -> the synthetic patient its handler files for
REFUSE = {"00000000-0000-4000-8000-00000000dead": Rejected("not-ours"),
          "00000000-0000-4000-8000-0000000000aa": NotFound(),
          "00000000-0000-4000-8000-0000000000bb": ValidationFailed(),
          "00000000-0000-4000-8000-0000000000ff": RuntimeError(f"bad reply: {SECRET_LOOKING}")}


@dataclass(frozen=True)
class Filed:
    patient_id: UUID


def _patient(engine: Engine, tenant: UUID) -> UUID:
    s = open_session(engine, tenant)
    try:
        patient: UUID = b.patient(s, "Lindgren118", "Kaia401").id
        s.commit()
    finally:
        connection = s.bind
        s.close()
        connection.close()  # type: ignore[union-attr]
    PATIENTS[str(tenant)] = patient
    return patient


def _settings() -> Settings:
    return Settings(environment="test", auth_mode="dev_header", database_url=TEST_DATABASE_URL,
                    hook_secret_clearinghouse=SecretStr(secrets.token_hex(32)),
                    hook_secret_erx=SecretStr(secrets.token_hex(32)),
                    simulated_partners=True, simulated_partner_callback_url="http://api.test")


@pytest.fixture
def app() -> Iterator[FastAPI]:
    from app.main import create_app

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
def filed(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
    """A stand-in for the eligibility module's 271 handler: records the clinic, the message and
    our request; for some correlation IDs it writes something, then refuses or fails."""
    seen: list[tuple[str, dict[str, Any], dict[str, Any]]] = []

    async def file_271(db: AsyncSession, message: dict[str, Any],
                       request: dict[str, Any]) -> object:
        clinic = (await db.execute(text(
            "SELECT current_setting('app.current_tenant_id', true)"))).scalar_one()
        seen.append((clinic, message, request))
        refusal = REFUSE.get(message["correlationId"])
        if refusal is not None:
            await db.execute(text("UPDATE admin.integration_endpoint SET name = 'changed'"))
            raise refusal
        patient = PATIENTS.get(clinic)
        return Filed(patient) if patient else object()  # any result; a patient_id is optional

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


def _asked(admin: Engine, clinic: dict[str, UUID], correlation: str | None = None) -> str:
    """Our outbound 270 in this clinic, whose payload names the check the reply answers."""
    check = correlation or str(uuid4())
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.integration_message (id, tenant_id, endpoint_id, direction, "
            "message_type, status, idempotency_key, payload, attempts, max_attempts) "
            "VALUES (:i, :t, :e, 'outbound', '270', 'sent', :k, CAST(:p AS jsonb), 1, 8)"),
            {"i": uuid4(), "t": clinic["tenant"], "e": clinic["endpoint"], "k": f"270:{check}",
             "p": json.dumps({"eligibilityCheckId": check, "operationId": str(uuid4())})})
    return check


def _271(correlation: str) -> dict[str, Any]:
    return payer_answer({"correlationId": correlation,
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
            "FROM admin.integration_message WHERE tenant_id = :t AND direction = 'inbound' "
            "ORDER BY created_at"), {"t": tenant}))


def _audit(admin: Engine, tenant: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT actor_type, actor_display, action, category, entity_type, outcome, "
            "patient_id, reason FROM audit.audit_event WHERE tenant_id = :t ORDER BY id"),
            {"t": tenant}))


def _endpoint_name(admin: Engine, clinic: dict[str, UUID]) -> str:
    with admin.connect() as c:
        return str(c.execute(text("SELECT name FROM admin.integration_endpoint WHERE id = :i"),
                             {"i": clinic["endpoint"]}).scalar_one())


def test_a_reply_to_our_request_is_filed_and_audited_naming_the_patient(
        client: TestClient, app: FastAPI, admin_engine: Engine, app_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any], dict[str, Any]]]) -> None:
    clinic = _clinic(admin_engine)
    patient = _patient(app_engine, clinic["tenant"])
    check = _asked(admin_engine, clinic)
    message = _271(check)

    r = _post(client, app, clinic["tenant"], message)

    assert (r.status_code, r.content) == (200, b"")
    ((seen_clinic, seen_message, request),) = filed
    assert (seen_clinic, seen_message) == (str(clinic["tenant"]), message)
    assert request["eligibilityCheckId"] == check and "operationId" in request  # our IDs
    (row,) = _inbound(admin_engine, clinic["tenant"])
    assert (row.status, row.message_type, row.control_id) == ("processed", "271",
                                                              message["responseId"])
    (entry,) = _audit(admin_engine, clinic["tenant"])
    assert tuple(entry) == ("partner", "clearinghouse", "create", "phi-write",
                            "integration-message", "success", patient, None)


def test_a_repeat_is_accepted_and_ignored(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any], dict[str, Any]]]) -> None:
    clinic = _clinic(admin_engine)
    message = _271(_asked(admin_engine, clinic))
    assert _post(client, app, clinic["tenant"], message).status_code == 200
    assert _post(client, app, clinic["tenant"], message).status_code == 200
    assert len(filed) == 1
    assert len(_inbound(admin_engine, clinic["tenant"])) == 1
    assert len(_audit(admin_engine, clinic["tenant"])) == 1


def test_a_message_left_unfiled_is_filed_on_the_partners_retry(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any], dict[str, Any]]]) -> None:
    clinic = _clinic(admin_engine)
    message = _271(_asked(admin_engine, clinic))
    with admin_engine.begin() as c:  # recorded, then the database went away before filing
        c.execute(text(
            "INSERT INTO admin.integration_message (id, tenant_id, endpoint_id, direction, "
            "message_type, status, control_id, received_at, attempts, max_attempts) VALUES "
            "(:i, :t, :e, 'inbound', '271', 'received', :c, now(), 0, 1)"),
            {"i": uuid4(), "t": clinic["tenant"], "e": clinic["endpoint"],
             "c": message["responseId"]})

    assert _post(client, app, clinic["tenant"], message).status_code == 200

    assert len(filed) == 1
    (row,) = _inbound(admin_engine, clinic["tenant"])
    assert row.status == "processed"


def test_a_reply_that_names_no_request_of_this_clinic_is_not_filed(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any], dict[str, Any]]]) -> None:
    mine, other = _clinic(admin_engine), _clinic(admin_engine)
    theirs = _asked(admin_engine, other)  # another clinic's check, posted naming this clinic

    for correlation in (str(uuid4()), theirs):
        assert _post(client, app, mine["tenant"], _271(correlation)).status_code == 200

    assert filed == []
    rows = _inbound(admin_engine, mine["tenant"])
    assert [(r.status, r.last_error) for r in rows] == [("failed", "unknown-correlation")] * 2
    assert {(a.outcome, a.reason, a.patient_id) for a in _audit(admin_engine, mine["tenant"])} \
        == {("failure", "unknown-correlation", None)}


@pytest.mark.parametrize(("correlation", "code"), [
    ("00000000-0000-4000-8000-00000000dead", "not-ours"),
    ("00000000-0000-4000-8000-0000000000aa", "unknown-correlation"),
    ("00000000-0000-4000-8000-0000000000bb", "invalid-message"),
    ("00000000-0000-4000-8000-0000000000ff", "internal-error"),
])
def test_a_refusal_or_failure_undoes_the_handlers_writes_and_keeps_a_code_only(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any], dict[str, Any]]], correlation: str,
        code: str) -> None:
    clinic = _clinic(admin_engine)
    _asked(admin_engine, clinic, correlation)

    assert _post(client, app, clinic["tenant"], _271(correlation)).status_code == 200

    assert len(filed) == 1
    (row,) = _inbound(admin_engine, clinic["tenant"])
    assert (row.status, row.last_error) == ("failed", code)
    assert SECRET_LOOKING not in (row.last_error or "")
    assert _endpoint_name(admin_engine, clinic) == "Simulated"  # the handler's write is undone
    (entry,) = _audit(admin_engine, clinic["tenant"])
    assert (entry.outcome, entry.reason) == ("failure", code)


def test_a_message_no_module_handles_is_dead_lettered(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(inbound._HANDLERS, ("clearinghouse", "271"), raising=False)
    clinic = _clinic(admin_engine)
    assert _post(client, app, clinic["tenant"], _271(_asked(admin_engine, clinic))) \
        .status_code == 200
    (row,) = _inbound(admin_engine, clinic["tenant"])
    assert (row.status, row.last_error) == ("dead-letter", "no-handler")


def test_a_clinic_without_that_partner_or_a_bad_signature_is_401_and_nothing_is_kept(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any], dict[str, Any]]]) -> None:
    pharmacy_only = _clinic(admin_engine, "erx", "simulated-erx")
    assert _post(client, app, pharmacy_only["tenant"], _271(str(uuid4()))).status_code == 401
    assert _post(client, app, uuid4(), _271(str(uuid4()))).status_code == 401  # no such clinic
    clinic = _clinic(admin_engine)
    body = json.dumps(_271(_asked(admin_engine, clinic))).encode()
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
    {"benefits": [{"benefitType": "copay"}] * 201},  # over the partner schema's 200
])
def test_a_message_outside_the_envelope_is_400(client: TestClient, app: FastAPI,
                                                admin_engine: Engine,  # noqa: F811
                                                change: dict[str, Any]) -> None:
    clinic = _clinic(admin_engine)
    r = _post(client, app, clinic["tenant"], _271(str(uuid4())) | change)
    assert (r.status_code, r.json()["code"]) == (400, "malformed-request")
    assert _inbound(admin_engine, clinic["tenant"]) == []


def test_two_hundred_benefit_lines_are_accepted(
        client: TestClient, app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any], dict[str, Any]]]) -> None:
    clinic = _clinic(admin_engine)
    message = _271(_asked(admin_engine, clinic)) | {"benefits": [{"benefitType": "copay"}] * 200}
    assert _post(client, app, clinic["tenant"], message).status_code == 200
    assert len(filed) == 1


async def test_the_whole_loop_from_the_outbox_to_the_module(
        app: FastAPI, admin_engine: Engine,  # noqa: F811
        filed: list[tuple[str, dict[str, Any], dict[str, Any]]],
        monkeypatch: pytest.MonkeyPatch) -> None:
    clinic = _clinic(admin_engine)
    check_id = str(uuid4())
    sent: list[tuple[str, dict[str, Any], str]] = []

    async def build_270(db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        return {"messageType": "270", "schemaVersion": "1.0",
                "correlationId": payload["eligibilityCheckId"],
                "subscriber": {"memberId": "TEST-M0012345"}}

    async def told_sent(db: AsyncSession, payload: dict[str, Any], control: str) -> None:
        sent.append(("sent", payload, control))

    monkeypatch.setitem(outbound._BUILDERS, ("clearinghouse", "270"), build_270)
    monkeypatch.setitem(outbound._HOOKS, ("sent", "clearinghouse", "270"), told_sent)
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

    mine = [(c, m) for c, m, _ in filed if m["correlationId"] == check_id]
    assert len(mine) == 1 and mine[0] == (str(clinic["tenant"]), mine[0][1])
    assert mine[0][1]["result"] == "active"
    assert [s for s in sent if s[1]["eligibilityCheckId"] == check_id][0][2].startswith("SIM-271-")
    (row,) = _inbound(admin_engine, clinic["tenant"])
    assert row.status == "processed"


async def test_a_message_that_cant_be_built_is_dead_lettered_and_the_module_told(
        admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: F811
    clinic = _clinic(admin_engine)
    told: list[tuple[dict[str, Any], str]] = []

    async def build_270(db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        raise DeliveryError("coverage-ended", permanent=True)

    async def told_dead(db: AsyncSession, payload: dict[str, Any], code: str) -> None:
        told.append((payload, code))
        raise RuntimeError(f"hook bug about {SECRET_LOOKING}")  # must not undo the outcome

    monkeypatch.setitem(outbound._BUILDERS, ("clearinghouse", "270"), build_270)
    monkeypatch.setitem(outbound._HOOKS, ("dead-letter", "clearinghouse", "270"), told_dead)
    message_id = uuid4()
    with admin_engine.begin() as c:
        c.execute(text(
            "INSERT INTO admin.integration_message (id, tenant_id, endpoint_id, direction, "
            "message_type, status, idempotency_key, payload, attempts, max_attempts) "
            "VALUES (:i, :t, :e, 'outbound', '270', 'queued', :k, CAST(:p AS jsonb), 0, 8)"),
            {"i": message_id, "t": clinic["tenant"], "e": clinic["endpoint"],
             "k": f"270:{message_id}", "p": json.dumps({"eligibilityCheckId": str(message_id)})})
    worker_db = Database(Settings(environment="test", database_url=TEST_DATABASE_URL))
    switch_to_role(worker_db.engine.sync_engine, "shri_integration")
    partner = SimulatedPartner(_settings(), "clearinghouse", delay=0)
    try:
        await OutboxWorker(worker_db, {"simulated-clearinghouse": partner}, batch=500).run_once()
    finally:
        await partner.aclose()
        await worker_db.dispose()

    assert told == [({"eligibilityCheckId": str(message_id)}, "coverage-ended")]
    with admin_engine.connect() as c:
        row = c.execute(text("SELECT status, last_error FROM admin.integration_message "
                             "WHERE id = :i"), {"i": message_id}).one()
    assert (row.status, row.last_error) == ("dead-letter", "coverage-ended")
