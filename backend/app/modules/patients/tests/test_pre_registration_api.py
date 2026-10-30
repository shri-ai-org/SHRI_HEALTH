"""Online pre-registration (D96, #89): the public form and the front desk's queue, against the
in-memory fakes (pre_registration_fakes.py, fakes.py).

Until #89 is in the operations map and core has the ``pre-registrations:*`` permissions (T47),
``api.py`` leaves these routes out, so the ``pre_app`` fixture stands in for both: it adds #89's
five operations to a copy of the map and the three permissions to FD and ADM, as T47 specifies,
then mounts the router. Synthetic data only.
"""

from __future__ import annotations

import importlib
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import deps, permissions
from app.core.deps import CLINIC_A, DEV_USERS
from app.core.operations import OPERATIONS_PATH_ENV, operations_file
from app.core.routing import API_PREFIX

from .. import public_form
from .conftest import new_patient
from .fakes import FakeSession, World
from .pre_registration_fakes import (
    PORTAL_ORIGIN,
    FakeCipher,
    FakeGuards,
    FakePreRegistrations,
    stored_plaintext,
)

LINK = "riverbend-front-door-7Qx2"
FORM = f"/api/v1/portal/practices/{LINK}/pre-registrations"
QUEUE = "/api/v1/pre-registrations"
PERMISSIONS = frozenset({"pre-registrations:read", "pre-registrations:accept",
                         "pre-registrations:reject"})

# #89's five operations, as the bundle step writes them into operations.json.
OPERATIONS = {
    "submitPreRegistration": {
        "audit": {"action": "C", "category": "phi-write", "actor": "anonymous"},
        "idempotency": "required", "method": "POST",
        "path": "/api/v1/portal/practices/{practiceLinkId}/pre-registrations",
        "permission": "public"},
    "listPreRegistrations": {
        "audit": {"action": "R", "category": "phi-read"}, "method": "GET",
        "path": "/api/v1/pre-registrations", "permission": "pre-registrations:read"},
    "getPreRegistration": {
        "audit": {"action": "R", "category": "phi-read"}, "method": "GET",
        "path": "/api/v1/pre-registrations/{preRegistrationId}",
        "permission": "pre-registrations:read"},
    "acceptPreRegistration": {
        "audit": {"action": "E", "category": "phi-write", "patient": "result"},
        "idempotency": "supported", "method": "POST",
        "path": "/api/v1/pre-registrations/{preRegistrationId}/accept",
        "permission": "pre-registrations:accept"},
    "rejectPreRegistration": {
        "audit": {"action": "E", "category": "phi-write"}, "method": "POST",
        "path": "/api/v1/pre-registrations/{preRegistrationId}/reject",
        "permission": "pre-registrations:reject"},
}


def contract_and_permissions(monkeypatch: pytest.MonkeyPatch, folder: Path,
                             roles: tuple[str, ...] = ("FD", "ADM")) -> None:
    """Stands in for #89 in the operations map and for core's T47 permission rows."""
    data = json.loads(operations_file().read_text(encoding="utf-8"))
    data["operations"].update(OPERATIONS)
    extended = folder / "operations.json"
    extended.write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setenv(OPERATIONS_PATH_ENV, str(extended))
    monkeypatch.setattr(permissions, "CATALOGUE", permissions.CATALOGUE | PERMISSIONS)
    for role in roles:
        monkeypatch.setitem(permissions.ROLE_PERMISSIONS, role,
                            permissions.ROLE_PERMISSIONS[role] | PERMISSIONS)


@pytest.fixture
def table() -> FakePreRegistrations:
    return FakePreRegistrations(links={LINK: CLINIC_A})


@pytest.fixture
def guards() -> FakeGuards:
    return FakeGuards()


@pytest.fixture
def pre_app(app: FastAPI, table: FakePreRegistrations, guards: FakeGuards,
            monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[FastAPI]:
    contract_and_permissions(monkeypatch, tmp_path)
    module = importlib.import_module("app.modules.patients.pre_registration_api")
    app.include_router(module.router, prefix=API_PREFIX)
    app.dependency_overrides[module.pre_registrations] = lambda: table
    app.dependency_overrides[public_form.public_form_guards] = lambda: guards
    app.dependency_overrides[public_form.field_cipher] = FakeCipher
    app.dependency_overrides[deps.public_db] = lambda: FakeSession(uuid4())
    yield app


Client = Callable[[str], TestClient]


@pytest.fixture
def staff(pre_app: FastAPI) -> Client:
    def client(name: str) -> TestClient:
        c = TestClient(pre_app, raise_server_exceptions=False)
        c.headers["X-Dev-User"] = name
        return c
    return client


@pytest.fixture
def public(pre_app: FastAPI) -> TestClient:
    c = TestClient(pre_app, raise_server_exceptions=False)
    c.headers["Origin"] = PORTAL_ORIGIN
    return c


def form(family: str = "Lindqvist58", **details: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "details": {
            "name": {"family": family, "given": ["Saga402"]},
            "birthDate": "1991-07-22",
            "gender": "female",
            "phones": [{"number": "+12175550163", "use": "mobile"}],
            "email": "saga.lindqvist@example.com",
            "address": {"lines": ["42 Sample Avenue"], "city": "Springfield", "state": "IL",
                        "postalCode": "62704", "country": "US"},
            "insurance": {"payerName": "Example Health Plan", "memberId": "TEST-MEMBER-042"},
            "reasonForVisit": "New patient, annual checkup.",
        },
        "contactConsent": True,
        "botCheck": "mock-altcha-payload",
    }
    body["details"].update(details)
    return body


def send(public: TestClient, body: dict[str, Any], key: str | None = None,
         path: str = FORM) -> Any:
    return public.post(path, json=body, headers={"Idempotency-Key": key or str(uuid4())})


def pending(table: FakePreRegistrations) -> list[UUID]:
    return [r.id for r in table.rows.get(CLINIC_A, {}).values() if r.status == "pending"]


# ------------------------------------------------------------------------------ the public form
def test_a_submission_is_stored_encrypted_and_answers_204(public: TestClient,
                                                          table: FakePreRegistrations) -> None:
    r = send(public, form())
    assert r.status_code == 204, r.text
    assert r.content == b""
    assert len(pending(table)) == 1
    stored = stored_plaintext(table.rows)
    assert "Lindqvist58" not in stored and "1991-07-22" not in stored  # encrypted at rest
    row = table.rows[CLINIC_A][pending(table)[0]]
    assert {"name", "birthDate", "phones", "email"} <= row.details.keys()  # the shape check
    assert table.submissions[0].practice_code == LINK  # the clinic comes from the link only


def _answer(r: Any) -> tuple[int, bytes, tuple[tuple[str, str], ...]]:
    """Everything the caller sees, but the request ID, which differs on every request."""
    headers = sorted((k.lower(), v) for k, v in r.headers.items() if k.lower() != "x-request-id")
    return r.status_code, r.content, tuple(headers)


def test_the_answer_is_the_same_whoever_submits(public: TestClient, staff: Client,
                                                world: World, table: FakePreRegistrations
                                                ) -> None:
    existing = staff("fd").post("/api/v1/patients", json=new_patient())
    assert existing.status_code == 201
    patients_before = len(world.clinic(FakeSession(CLINIC_A)))
    key = str(uuid4())
    answers = [
        send(public, form()),  # someone new
        send(public, form(family="Lindgren118", name={"family": "Lindgren118",
                                                      "given": ["Kaia401"]},
                          birthDate="1990-03-14")),  # already a patient here
        send(public, form(family="Okafor73"), key=key),
        send(public, form(family="Okafor73"), key=key),  # a replay
    ]
    assert len({_answer(a) for a in answers}) == 1
    assert answers[0].status_code == 204
    assert len(pending(table)) == 3  # the replay stored nothing
    assert len(world.clinic(FakeSession(CLINIC_A))) == patients_before  # no patient looked up


def test_an_unknown_link_is_404_and_says_nothing_about_anyone(public: TestClient) -> None:
    r = send(public, form(), path="/api/v1/portal/practices/no-such-practice-0000/"
                                  "pre-registrations")
    assert r.status_code == 404 and r.json()["code"] == "not-found"
    too_short = send(public, form(), path="/api/v1/portal/practices/short/pre-registrations")
    assert too_short.status_code == 422


def test_another_origin_is_refused_before_the_body_is_checked(
        public: TestClient, table: FakePreRegistrations) -> None:
    """Only a body that isn't JSON at all is answered first (400, by the framework)."""
    for origin in ("https://evil.example.test", None):
        headers = {"Idempotency-Key": str(uuid4())}
        if origin:
            headers["Origin"] = origin
        else:
            public.headers.pop("Origin", None)
        for body in ({}, form()):
            r = public.post(FORM, json=body, headers=headers)
            assert r.status_code == 403 and r.json()["code"] == "csrf-check-failed", origin
    assert table.submissions == []


def test_rate_limits_per_ip_and_per_email_hash(public: TestClient, guards: FakeGuards) -> None:
    guards.limits["email"] = 1
    assert send(public, form()).status_code == 204
    again = send(public, form(email="Saga.LINDQVIST@Example.com"))  # the same address
    assert again.status_code == 429 and again.json()["code"] == "rate-limited"
    assert again.headers["Retry-After"] == "60"
    email_keys = [k for scope, k in guards.keys_seen if scope == "email"]
    assert len(set(email_keys)) == 1 and all("@" not in k for k in email_keys)  # hashed only
    guards.limits["ip"] = 2
    assert send(public, form(email="other.person@example.com")).status_code == 429


def test_a_failed_bot_check_is_422_naming_bot_check(public: TestClient,
                                                    table: FakePreRegistrations) -> None:
    body = form()
    body["botCheck"] = "mock-altcha-failed"
    r = send(public, body)
    assert r.status_code == 422 and r.json()["code"] == "business-rule-violation"
    assert r.json()["errors"][0]["pointer"] == "/botCheck"
    assert table.submissions == []


def test_the_bot_check_comes_before_the_body(public: TestClient,
                                            table: FakePreRegistrations) -> None:
    """The contract's order: Origin (403), rate limit (429), bot check (422 at /botCheck), then
    the body's fields (422 validation-failed)."""
    bad_body = form()
    del bad_body["details"]["name"]
    bad_body["botCheck"] = "mock-altcha-failed"
    first = send(public, bad_body)
    assert first.status_code == 422 and first.json()["errors"][0]["pointer"] == "/botCheck"
    no_answer = form()
    del no_answer["botCheck"]
    del no_answer["details"]["name"]
    missing = send(public, no_answer)
    assert missing.status_code == 422 and missing.json()["errors"][0]["pointer"] == "/botCheck"
    good_answer = form()
    del good_answer["details"]["name"]
    then_body = send(public, good_answer)
    assert then_body.status_code == 422 and then_body.json()["code"] == "validation-failed"
    assert table.submissions == []


def test_the_bot_check_is_given_the_idempotency_key(public: TestClient,
                                                    guards: FakeGuards) -> None:
    """Core accepts an answer once, but again for a retry of the same request (same key)."""
    key = str(uuid4())
    assert send(public, form(), key=key).status_code == 204
    assert send(public, form(), key=key).status_code == 204  # the retry
    assert [k for _, k in guards.bot_checks] == [key, key]
    quoted = send(public, form(), key=f'"{uuid4()}"')
    assert quoted.status_code == 204 and guards.bot_checks[-1][1] is not None
    assert '"' not in str(guards.bot_checks[-1][1])  # bare UUID, as core keys it


def test_validation_and_the_idempotency_key(public: TestClient) -> None:
    no_contact = form()
    del no_contact["details"]["phones"]
    del no_contact["details"]["email"]
    assert send(public, no_contact).status_code == 422  # a phone or an email
    no_consent = form()
    no_consent["contactConsent"] = False
    assert send(public, no_consent).status_code == 422
    extra = form()
    extra["details"]["ssn"] = "000-00-0000"
    assert send(public, extra).status_code == 422  # closed body
    missing = public.post(FORM, json=form())
    assert missing.status_code == 400 and missing.json()["code"] == "idempotency-key-missing"


def test_a_reused_key_with_another_body_is_422(public: TestClient) -> None:
    key = str(uuid4())
    assert send(public, form(), key=key).status_code == 204
    r = send(public, form(family="Okafor73"), key=key)
    assert r.status_code == 422 and r.json()["code"] == "idempotency-key-reused"


def test_unconfigured_guards_fail_closed(pre_app: FastAPI, public: TestClient) -> None:
    """Core's real guards, with no PORTAL_ORIGIN or PUBLIC_FORM_SECRET in this app: 503, never
    an unguarded form."""
    del pre_app.dependency_overrides[public_form.public_form_guards]
    r = send(public, form())
    assert r.status_code == 503


# ------------------------------------------------------------------------------- the staff queue
def _submitted(public: TestClient, table: FakePreRegistrations, **details: Any) -> UUID:
    before = set(pending(table))
    assert send(public, form(**details)).status_code == 204
    (new,) = set(pending(table)) - before
    return new


def test_the_queue_lists_pending_oldest_first_with_the_details(
        public: TestClient, staff: Client, table: FakePreRegistrations) -> None:
    first = _submitted(public, table)
    second = _submitted(public, table, email="second.person@example.com")
    r = staff("fd").get(QUEUE)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [i["id"] for i in items] == [str(first), str(second)]
    assert items[0]["details"]["name"] == {"family": "Lindqvist58", "given": ["Saga402"]}
    assert items[0]["entrySource"] == "patient-reported" and "deleteAfter" in items[0]
    page = staff("adm").get(QUEUE, params={"limit": 1}).json()
    assert len(page["items"]) == 1 and "nextCursor" in page
    assert staff("fd").get(QUEUE, params={"status": "accepted"}).json()["items"] == []
    assert staff("ma").get(QUEUE).status_code == 403
    assert staff("fd").get(QUEUE, params={"status": "lost"}).status_code == 422


def test_one_request_reads_back(public: TestClient, staff: Client,
                                table: FakePreRegistrations) -> None:
    pre_id = _submitted(public, table)
    r = staff("fd").get(f"{QUEUE}/{pre_id}")
    assert r.status_code == 200 and r.json()["status"] == "pending"
    assert r.json()["details"]["insurance"]["memberId"] == "TEST-MEMBER-042"
    assert staff("fd").get(f"{QUEUE}/{uuid4()}").status_code == 404
    assert staff("md").get(f"{QUEUE}/{pre_id}").status_code == 403
    assert staff("fd").get(f"{QUEUE}/not-a-uuid").status_code == 422


ACCEPT = {"identityVerified": True, "idDocumentType": "drivers-license"}


def test_accept_creates_the_patient_through_the_registration_rules(
        public: TestClient, staff: Client, world: World, table: FakePreRegistrations) -> None:
    pre_id = _submitted(public, table)
    r = staff("fd").post(f"{QUEUE}/{pre_id}/accept", json=ACCEPT)
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["status"] == "accepted" and "deleteAfter" not in got
    assert got["identityCheck"]["idDocumentType"] == "drivers-license"
    assert got["identityCheck"]["verifiedBy"] == str(DEV_USERS["fd"].id)
    patient_id = UUID(got["patientId"])
    created = world.clinic(FakeSession(CLINIC_A))[patient_id]
    assert created.data.entry_source == "patient-reported"  # FR-PAT-02
    assert any(i.type == "MR" for i in created.identifiers)  # the practice's counter (D41)
    assert world.audited[-1] == [patient_id]  # x-audit patient "result"
    chart = staff("fd").get(f"/api/v1/patients/{patient_id}").json()
    assert chart["name"]["family"] == "Lindqvist58"
    assert chart["emails"] == [{"address": "saga.lindqvist@example.com"}]


def test_accept_finds_possible_duplicates_then_takes_an_override(
        public: TestClient, staff: Client, world: World, table: FakePreRegistrations) -> None:
    existing = staff("fd").post("/api/v1/patients", json=new_patient()).json()
    pre_id = _submitted(public, table, name={"family": "Lindgren118", "given": ["Kaia401"]},
                        birthDate="1990-03-14", phones=[{"number": "+12175550142"}])
    dup = staff("fd").post(f"{QUEUE}/{pre_id}/accept", json=ACCEPT)
    assert dup.status_code == 409 and dup.json()["code"] == "possible-duplicate"
    assert existing["id"] in dup.json()["candidateIds"]
    assert staff("fd").get(f"{QUEUE}/{pre_id}").json()["status"] == "pending"
    no_reason = staff("fd").post(f"{QUEUE}/{pre_id}/accept",
                                 json={**ACCEPT, "duplicateCheck": "override"})
    assert no_reason.status_code == 422
    overridden = staff("fd").post(f"{QUEUE}/{pre_id}/accept", json={
        **ACCEPT, "duplicateCheck": "override",
        "duplicateOverrideReason": "Different person, checked at the desk."})
    assert overridden.status_code == 200 and overridden.json()["patientId"] != existing["id"]
    assert world.details[-1] == ("create", "Different person, checked at the desk.")


def test_accept_can_link_an_existing_chart(public: TestClient, staff: Client, world: World,
                                           table: FakePreRegistrations) -> None:
    existing = staff("fd").post("/api/v1/patients", json=new_patient()).json()
    count = len(world.clinic(FakeSession(CLINIC_A)))
    pre_id = _submitted(public, table)
    unknown = staff("fd").post(f"{QUEUE}/{pre_id}/accept",
                               json={**ACCEPT, "patientId": str(uuid4())})
    assert unknown.status_code == 422 and unknown.json()["errors"][0]["pointer"] == "/patientId"
    world.clinic(FakeSession(CLINIC_A))[UUID(existing["id"])].labels.add("R")
    restricted = staff("fd").post(f"{QUEUE}/{pre_id}/accept",
                                  json={**ACCEPT, "patientId": existing["id"]})
    assert restricted.status_code == 403 and restricted.json()["code"] == "break-glass-required"
    world.clinic(FakeSession(CLINIC_A))[UUID(existing["id"])].labels.clear()
    linked = staff("fd").post(f"{QUEUE}/{pre_id}/accept",
                              json={**ACCEPT, "patientId": existing["id"]})
    assert linked.status_code == 200 and linked.json()["patientId"] == existing["id"]
    assert len(world.clinic(FakeSession(CLINIC_A))) == count  # nothing created


def test_linking_records_no_override_and_refuses_a_merged_chart(
        public: TestClient, staff: Client, world: World, table: FakePreRegistrations) -> None:
    """Thulasi's review of #105: a link creates nothing, so an override reason sent with it is not
    recorded as a create; and a chart merged into another can't be linked (D103)."""
    merged = staff("fd").post("/api/v1/patients", json=new_patient()).json()
    survivor = uuid4()
    world.clinic(FakeSession(CLINIC_A))[UUID(merged["id"])].merged_into_id = survivor
    pre_id = _submitted(public, table)
    before = len(world.details)
    refused = staff("fd").post(f"{QUEUE}/{pre_id}/accept", json={
        **ACCEPT, "patientId": merged["id"], "duplicateCheck": "override",
        "duplicateOverrideReason": "Same person, checked at the desk."})
    assert refused.status_code == 409 and refused.json()["code"] == "patient-merged"
    assert staff("fd").get(f"{QUEUE}/{pre_id}").json()["status"] == "pending"
    world.clinic(FakeSession(CLINIC_A))[UUID(merged["id"])].merged_into_id = None
    linked = staff("fd").post(f"{QUEUE}/{pre_id}/accept", json={
        **ACCEPT, "patientId": merged["id"], "duplicateCheck": "override",
        "duplicateOverrideReason": "Same person, checked at the desk."})
    assert linked.status_code == 200 and linked.json()["patientId"] == merged["id"]
    assert len(world.details) == before  # no override recorded for a link


def test_accept_needs_the_identity_check_and_the_permission(
        public: TestClient, staff: Client, table: FakePreRegistrations) -> None:
    pre_id = _submitted(public, table)
    path = f"{QUEUE}/{pre_id}/accept"
    assert staff("fd").post(path, json={"idDocumentType": "passport"}).status_code == 422
    assert staff("fd").post(path, json={**ACCEPT, "identityVerified": False}).status_code == 422
    assert staff("fd").post(path, json={"identityVerified": True}).status_code == 422
    assert staff("ma").post(path, json=ACCEPT).status_code == 403
    assert staff("fd").post(path, json=ACCEPT).status_code == 200
    again = staff("adm").post(path, json=ACCEPT)
    assert again.status_code == 409 and again.json()["code"] == "invalid-state-transition"
    assert again.json()["currentState"] == "accepted"


def test_reject_with_a_reason(public: TestClient, staff: Client,
                              table: FakePreRegistrations) -> None:
    pre_id = _submitted(public, table)
    path = f"{QUEUE}/{pre_id}/reject"
    other = staff("fd").post(path, json={"reasonCode": "other"})
    assert other.status_code == 422 and other.json()["errors"][0]["pointer"] == "/reasonText"
    assert staff("fd").post(path, json={"reasonCode": "lost"}).status_code == 422
    assert staff("md").post(path, json={"reasonCode": "spam"}).status_code == 403
    r = staff("fd").post(path, json={"reasonCode": "other", "reasonText": "Test reason."})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["status"] == "rejected" and got["rejection"] == {
        "reasonCode": "other", "reasonText": "Test reason."}
    assert "deleteAfter" in got  # 30 days after the rejection (Anand's purge)
    again = staff("fd").post(path, json={"reasonCode": "spam"})
    assert again.status_code == 409 and again.json()["currentState"] == "rejected"
    accept = staff("fd").post(f"{QUEUE}/{pre_id}/accept", json=ACCEPT)
    assert accept.status_code == 409
