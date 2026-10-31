"""Online pre-registration (D96) against a live database: Anand's ``admin.pre_registration`` and
``admin.submit_pre_registration`` (migration 0009, #101), the form's write as ``shri_public``, the
queue as ``shri_app`` through core's tenant_db, chart check and audit, and PR-1's registration
with the real FHIR write helpers.

Field encryption (#102) is the in-memory stand-in. Core's public-form guards (#110) run for real in
the ``guarded`` tests (a challenge from ``GET /portal/bot-challenge``, solved by proof of work);
elsewhere they are the stand-in. The
contract (#89) and the permissions (T47) are added as in test_pre_registration_api.py; ``public_db``
(core's placeholder) is replaced by a session as ``shri_public``. Skipped where the database has no
``admin.submit_pre_registration`` (before #101). Synthetic data only.
"""

from __future__ import annotations

import base64
import hashlib
import importlib
import json
import uuid
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.core import deps
from app.core.config import Settings
from app.core.deps import CLINIC_A, DEV_USER_HEADER, CurrentUser, current_user
from app.core.routing import API_PREFIX
from app.db.tests.conftest import TEST_DATABASE_URL, switch_to_role, sync_url
from app.main import create_app

from .. import public_form
from .pre_registration_fakes import PORTAL_ORIGIN, FakeCipher, FakeGuards
from .test_patients_live import clinics, users  # noqa: F401  (fixtures)
from .test_pre_registration_api import contract_and_permissions, form


def _has_submit_function() -> bool:
    if not TEST_DATABASE_URL:
        return False
    engine = create_engine(sync_url(), poolclass=NullPool)
    try:
        with engine.connect() as c:
            return c.execute(text(
                "SELECT to_regprocedure('admin.submit_pre_registration(text, uuid, text, jsonb, "
                "boolean, inet, text, text)') IS NOT NULL")).scalar_one() is True
    finally:
        engine.dispose()


pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not _has_submit_function(),
                       reason="needs a test database with migration 0009 (#101)"),
]


@pytest.fixture
def link(clinics: dict[UUID, UUID]) -> Iterator[str]:  # noqa: F811
    """Clinic A's pre-registration link, turned on (onboarding sets it, #101)."""
    code = f"test-link-{uuid.uuid4().hex}"
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.begin() as c:
        c.execute(text("UPDATE admin.tenant SET pre_registration_code = :c, "
                       "pre_registration_enabled = true WHERE id = :t"),
                  {"c": code, "t": clinics[CLINIC_A]})
    admin.dispose()
    yield code


def _running(users: dict[str, CurrentUser], monkeypatch: pytest.MonkeyPatch,  # noqa: F811
             tmp_path: Path, *, real_guards: bool) -> Iterator[Any]:
    """The app against the live database. With ``real_guards``, core's own public-form guards
    (Origin, rate limits, ALTCHA) run, configured as on a server; otherwise the stand-ins do."""
    contract_and_permissions(monkeypatch, tmp_path, roles=("FD", "ADM", "MD"))
    guarded: dict[str, Any] = {}
    if real_guards:
        guarded = {"portal_origin": PORTAL_ORIGIN, "public_form_secret": SecretStr("t" * 40),
                   "bot_check_max_number": 2000}
    app: FastAPI = create_app(Settings(environment="test", auth_mode="dev_header",
                                       database_url=TEST_DATABASE_URL, **guarded))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    module = importlib.import_module("app.modules.patients.pre_registration_api")
    app.include_router(module.router, prefix=API_PREFIX)
    public_engine = create_async_engine(TEST_DATABASE_URL or "", poolclass=NullPool)
    switch_to_role(public_engine.sync_engine, "shri_public", require_search_path=False)

    async def as_shri_public() -> AsyncIterator[AsyncSession]:
        async with AsyncSession(public_engine) as session:
            yield session

    def signed_in(request: Request) -> CurrentUser:
        return users[request.headers[DEV_USER_HEADER]]

    app.dependency_overrides[current_user] = signed_in
    app.dependency_overrides[deps.public_db] = as_shri_public
    if not real_guards:
        guards = FakeGuards()
        app.dependency_overrides[public_form.public_form_guards] = lambda: guards
    app.dependency_overrides[public_form.field_cipher] = FakeCipher
    with TestClient(app, raise_server_exceptions=False) as client:
        def as_user(name: str | None) -> TestClient:
            if name is None:
                client.headers.pop(DEV_USER_HEADER, None)
                client.headers["Origin"] = PORTAL_ORIGIN
            else:
                client.headers[DEV_USER_HEADER] = name
            return client
        yield as_user
        assert client.portal is not None
        client.portal.call(app.state.db.dispose)
        client.portal.call(public_engine.dispose)


@pytest.fixture
def live(users: dict[str, CurrentUser], monkeypatch: pytest.MonkeyPatch,  # noqa: F811
         tmp_path: Path) -> Iterator[Any]:
    yield from _running(users, monkeypatch, tmp_path, real_guards=False)


@pytest.fixture
def guarded(users: dict[str, CurrentUser], monkeypatch: pytest.MonkeyPatch,  # noqa: F811
            tmp_path: Path) -> Iterator[Any]:
    yield from _running(users, monkeypatch, tmp_path, real_guards=True)


def _rows(tenant: UUID) -> list[Any]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.connect() as c:
        rows = list(c.execute(text(
            "SELECT id, status, details, decided_by_user_id, patient_id, id_document_type, "
            "rejection_reason_code FROM admin.pre_registration WHERE tenant_id = :t "
            "ORDER BY created_at"), {"t": tenant}))
    admin.dispose()
    return rows


def _audit(tenant: UUID, entity: str) -> list[Any]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.connect() as c:
        rows = list(c.execute(text(
            "SELECT actor_type, actor_user_id, action, patient_id FROM audit.audit_event "
            "WHERE tenant_id = :t AND entity_type = :e ORDER BY id"), {"t": tenant, "e": entity}))
    admin.dispose()
    return rows


def _send(client: TestClient, link: str, body: dict[str, Any], key: str | None = None) -> Any:
    return client.post(f"/api/v1/portal/practices/{link}/pre-registrations", json=body,
                       headers={"Idempotency-Key": key or str(uuid.uuid4())})


def test_the_form_stores_once_with_its_anonymous_audit_row(
        live: Any, link: str, clinics: dict[UUID, UUID]) -> None:  # noqa: F811
    key = str(uuid.uuid4())
    first = _send(live(None), link, form(), key)
    assert first.status_code == 204, first.text
    replay = _send(live(None), link, form(), key)
    assert replay.status_code == 204 and replay.content == b""
    rows = _rows(clinics[CLINIC_A])
    assert len(rows) == 1 and rows[0].status == "pending"
    assert all(str(v).startswith("fake:") for v in rows[0].details.values())  # never in clear
    assert [(a.actor_type, a.actor_user_id) for a in _audit(clinics[CLINIC_A],
                                                             "PreRegistration")] == [
        ("anonymous", None)]  # written by the function, with the request
    reused = _send(live(None), link, form(family="Okafor73"), key)
    assert reused.status_code == 422 and reused.json()["code"] == "idempotency-key-reused"


def test_an_unknown_or_switched_off_link_is_404(live: Any, link: str,
                                                clinics: dict[UUID, UUID]) -> None:  # noqa: F811
    assert _send(live(None), link.replace("test", "nope"), form()).status_code == 404
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.begin() as c:
        c.execute(text("UPDATE admin.tenant SET pre_registration_enabled = false WHERE id = :t"),
                  {"t": clinics[CLINIC_A]})
    admin.dispose()
    off = _send(live(None), link, form())
    assert off.status_code == 404 and off.json()["code"] == "not-found"
    assert _rows(clinics[CLINIC_A]) == []


def test_the_queue_accepts_into_a_real_patient(live: Any, link: str,
                                               clinics: dict[UUID, UUID],  # noqa: F811
                                               users: dict[str, CurrentUser]) -> None:  # noqa: F811
    family = f"Lindqvist{uuid.uuid4().hex[:6]}"
    assert _send(live(None), link, form(family=family, name={
        "family": family, "given": ["Saga402"]})).status_code == 204
    items = live("fd").get("/api/v1/pre-registrations").json()["items"]
    assert [i["details"]["name"]["family"] for i in items] == [family]
    pre_id = items[0]["id"]
    accepted = live("fd").post(f"/api/v1/pre-registrations/{pre_id}/accept",
                               json={"identityVerified": True, "idDocumentType": "passport"})
    assert accepted.status_code == 200, accepted.text
    patient_id = accepted.json()["patientId"]
    chart = live("fd").get(f"/api/v1/patients/{patient_id}").json()
    assert chart["name"]["family"] == family and chart["mrn"].startswith("TST0-")
    (row,) = _rows(clinics[CLINIC_A])
    assert row.status == "accepted" and str(row.patient_id) == patient_id
    assert row.decided_by_user_id == users["fd"].id and row.id_document_type == "passport"
    # Core names the entity from the path ("pre-registrations"); the form's own row, written by
    # #101's function, says "PreRegistration".
    decision = [a for a in _audit(clinics[CLINIC_A], "pre-registrations")
                if a.actor_type == "user" and a.action == "update"]  # not the list read
    assert [str(a.patient_id) for a in decision] == [patient_id]  # x-audit patient "result"
    again = live("adm").post(f"/api/v1/pre-registrations/{pre_id}/accept",
                             json={"identityVerified": True, "idDocumentType": "passport"})
    assert again.status_code == 409 and again.json()["currentState"] == "accepted"


def test_reject_and_another_clinic(live: Any, link: str,
                                   clinics: dict[UUID, UUID]) -> None:  # noqa: F811
    assert _send(live(None), link, form()).status_code == 204
    pre_id = live("fd").get("/api/v1/pre-registrations").json()["items"][0]["id"]
    assert live("md-b").get(f"/api/v1/pre-registrations/{pre_id}").status_code == 404  # RLS
    rejected = live("adm").post(f"/api/v1/pre-registrations/{pre_id}/reject",
                                json={"reasonCode": "other", "reasonText": "Test reason."})
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["rejection"]["reasonCode"] == "other"
    (row,) = _rows(clinics[CLINIC_A])
    assert row.status == "rejected" and row.rejection_reason_code == "other"


# ------------------------------------------------ core's real guards: Origin, limits and ALTCHA
def _solved(client: TestClient) -> str:
    """A challenge from GET /portal/bot-challenge, solved as the browser's widget does."""
    issued = client.get(f"{API_PREFIX}/portal/bot-challenge")
    assert issued.status_code == 200, issued.text
    assert issued.headers["Cache-Control"] == "no-store"
    challenge = issued.json()
    number = next(n for n in range(challenge["maxnumber"] + 1)
                  if hashlib.sha256(f"{challenge['salt']}{n}".encode()).hexdigest()
                  == challenge["challenge"])
    answer = {"algorithm": challenge["algorithm"], "challenge": challenge["challenge"],
              "number": number, "salt": challenge["salt"], "signature": challenge["signature"]}
    return base64.b64encode(json.dumps(answer).encode()).decode()


def _with_answer(answer: str, **details: Any) -> dict[str, Any]:
    body = form(**details)
    body["botCheck"] = answer
    return body


def test_core_guards_accept_a_solved_challenge_once_per_request(
        guarded: Any, link: str, clinics: dict[UUID, UUID]) -> None:  # noqa: F811
    client = guarded(None)
    answer = _solved(client)
    key = str(uuid.uuid4())
    first = _send(client, link, _with_answer(answer), key)
    assert first.status_code == 204, first.text
    retry = _send(client, link, _with_answer(answer), key)  # the same request again: same key
    assert retry.status_code == 204
    assert len(_rows(clinics[CLINIC_A])) == 1
    reused = _send(client, link, _with_answer(answer, family="Okafor73"))  # another request
    assert reused.status_code == 422 and reused.json()["errors"][0]["pointer"] == "/botCheck"
    assert len(_rows(clinics[CLINIC_A])) == 1


def test_core_guards_refuse_in_the_agreed_order(guarded: Any, link: str,
                                                clinics: dict[UUID, UUID]) -> None:  # noqa: F811
    """Origin (403), then the bot check (422 at /botCheck) before the body's fields."""
    client = guarded(None)
    elsewhere = client.post(f"{API_PREFIX}/portal/practices/{link}/pre-registrations",
                            json=form(), headers={"Origin": "https://evil.example.test",
                                                  "Idempotency-Key": str(uuid.uuid4())})
    assert elsewhere.status_code == 403 and elsewhere.json()["code"] == "csrf-check-failed"
    unsolved = _with_answer(base64.b64encode(b'{"number": 1}').decode())
    del unsolved["details"]["name"]
    bot_first = _send(client, link, unsolved)
    assert bot_first.status_code == 422
    assert bot_first.json()["errors"][0]["pointer"] == "/botCheck"
    solved = _with_answer(_solved(client))
    del solved["details"]["name"]
    then_body = _send(client, link, solved)
    assert then_body.status_code == 422 and then_body.json()["code"] == "validation-failed"
    assert _rows(clinics[CLINIC_A]) == []
