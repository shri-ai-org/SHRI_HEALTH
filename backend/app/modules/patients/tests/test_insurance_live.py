"""PR-2 against a live database, as shri_app: coverages and consents through core's tenant_db,
chart check, audit and idempotency, Anand's FHIR write helpers and the real reads
(insurance_repository.py). The fixtures are PR-1's (test_patients_live.py): fresh clinics and a
real user per dev user name. Synthetic data only."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.deps import CLINIC_A, CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL, open_session, switch_to_role, sync_url

from .test_patients_live import _body, client, clinics, users  # noqa: F401 (fixtures)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
OPENBAO = pytest.mark.skipif(
    not os.environ.get("OPENBAO_TRANSIT_ADDR") and os.environ.get("REQUIRE_OPENBAO") != "1",
    reason="OPENBAO_TRANSIT_ADDR not set (the stored response is encrypted)")
MERGE = {"Content-Type": "application/merge-patch+json"}


@pytest.fixture
def payers(clinics: dict[UUID, UUID]) -> Iterator[dict[str, UUID]]:  # noqa: F811
    """An active payer the clinic uses, and one the directory has closed."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    found = {"active": uuid.uuid4(), "closed": uuid.uuid4()}
    with admin.begin() as c:
        for kind, payer_id in found.items():
            c.execute(text(
                "INSERT INTO admin.payer (id, name, payer_type, supports_eligibility, "
                "supports_claim_status, supports_era, is_active) VALUES (:i, :n, 'commercial', "
                "true, true, true, :a)"),
                {"i": payer_id, "n": f"{kind.title()} Health Plan (synthetic)",
                 "a": kind == "active"})
            c.execute(text("INSERT INTO admin.practice_payer (id, tenant_id, payer_id, is_active) "
                           "VALUES (:i, :t, :p, true)"),
                      {"i": uuid.uuid4(), "t": clinics[CLINIC_A], "p": payer_id})
    yield found
    admin.dispose()


def _patient(client: Any) -> dict[str, Any]:  # noqa: F811
    created = client("fd").post("/api/v1/patients",
                                json=_body(f"Haddad{uuid.uuid4().hex[:6]}", identifiers=[]))
    assert created.status_code == 201, created.text
    patient: dict[str, Any] = created.json()
    return patient


def _coverage(payer: UUID, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"order": 1, "payerId": str(payer), "memberId": "TEST-MEMBER-042",
                            "relationshipToSubscriber": "self", "groupNumber": "TEST-GRP-7",
                            "groupName": "Demo employer group", "planName": "Gold PPO",
                            "startDate": "2026-01-01"}
    body.update(overrides)
    return body


def _consent(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"kind": "treatment", "decision": "permit",
                            "signatureMethod": "electronic", "signedAt": "2026-11-03T15:05:00Z",
                            "policyVersion": "2026-10"}
    body.update(overrides)
    return body


def test_add_read_list_and_end_a_coverage(client: Any, payers: dict[str, UUID]) -> None:  # noqa: F811
    patient = _patient(client)
    base = f"/api/v1/patients/{patient['id']}/coverages"
    created = client("fd").post(base, json=_coverage(payers["active"]))
    assert created.status_code == 201, created.text
    coverage = created.json()
    assert created.headers["Location"] == f"{base}/{coverage['id']}"
    assert coverage["memberId"] == "TEST-MEMBER-042"
    assert coverage["payerId"] == str(payers["active"])
    assert coverage["payerName"] == "Active Health Plan (synthetic)"
    assert coverage["groupNumber"] == "TEST-GRP-7"
    assert coverage["groupName"] == "Demo employer group"
    assert coverage["planName"] == "Gold PPO" and coverage["relationshipToSubscriber"] == "self"
    assert coverage["status"] == "active" and coverage["startDate"] == "2026-01-01"
    read = client("ma").get(f"{base}/{coverage['id']}")
    assert read.status_code == 200 and read.headers["ETag"] == created.headers["ETag"]
    assert client("bil").get(base).json()["items"][0]["id"] == coverage["id"]
    path = f"{base}/{coverage['id']}"
    assert client("fd").patch(path, json={"endDate": "2026-12-31"}, headers=MERGE
                              ).status_code == 428
    stale = client("fd").patch(path, json={"endDate": "2026-12-31"},
                               headers={"If-Match": '"999"', **MERGE})
    assert stale.status_code == 412 and stale.headers["ETag"] == created.headers["ETag"]
    ended = client("fd").patch(path, json={"endDate": "2026-12-31", "planName": None},
                               headers={"If-Match": created.headers["ETag"], **MERGE})
    assert ended.status_code == 200, ended.text
    assert ended.json()["endDate"] == "2026-12-31" and "planName" not in ended.json()
    assert ended.json()["groupNumber"] == "TEST-GRP-7"  # untouched
    assert ended.headers["ETag"] != created.headers["ETag"]


def test_coverage_rules_against_the_real_tables(client: Any, payers: dict[str, UUID]) -> None:  # noqa: F811
    patient = _patient(client)
    other = _patient(client)
    base = f"/api/v1/patients/{patient['id']}/coverages"
    assert client("fd").post(base, json=_coverage(payers["active"])).status_code == 201
    taken = client("fd").post(base, json=_coverage(payers["active"], memberId="TEST-M-2"))
    assert taken.status_code == 422 and taken.json()["errors"][0]["pointer"] == "/order"
    closed = client("fd").post(base, json=_coverage(payers["closed"], order=2))
    assert closed.status_code == 422 and closed.json()["errors"][0]["pointer"] == "/payerId"
    nobody = client("fd").post(base, json=_coverage(uuid.uuid4(), order=2))
    assert nobody.status_code == 422 and nobody.json()["errors"][0]["code"] == "invalid-reference"
    their_contact = client("fd").post(f"/api/v1/patients/{other['id']}/related-persons", json={
        "name": {"family": "Haddad", "given": ["Sami"]},
        "relationships": [{"system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
                           "code": "SPS", "display": "spouse"}]}).json()
    foreign = client("fd").post(base, json=_coverage(
        payers["active"], order=2, relationshipToSubscriber="spouse",
        subscriberRelatedPersonId=their_contact["id"]))
    assert foreign.status_code == 422
    assert foreign.json()["errors"][0]["pointer"] == "/subscriberRelatedPersonId"
    spouse = client("fd").post(f"/api/v1/patients/{patient['id']}/related-persons", json={
        "name": {"family": "Haddad", "given": ["Lina"]},
        "relationships": [{"system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
                           "code": "SPS", "display": "spouse"}]}).json()
    second = client("fd").post(base, json=_coverage(
        payers["active"], order=2, relationshipToSubscriber="spouse", subscriberId="TEST-SUB-9",
        subscriberRelatedPersonId=spouse["id"], groupNumber=None, groupName=None))
    assert second.status_code == 201, second.text
    assert second.json()["subscriberRelatedPersonId"] == spouse["id"]
    assert second.json()["subscriberId"] == "TEST-SUB-9"
    path = f"{base}/{second.json()['id']}"
    payer_change = client("fd").patch(path, json={"payerId": str(payers["closed"])},
                                      headers={"If-Match": second.headers["ETag"], **MERGE})
    assert payer_change.status_code == 422  # until Anand's update_coverage replaces the payer
    to_self = client("fd").patch(path, json={"relationshipToSubscriber": "self"},
                                 headers={"If-Match": second.headers["ETag"], **MERGE})
    assert to_self.status_code == 200, to_self.text
    assert "subscriberRelatedPersonId" not in to_self.json()  # becoming self clears it


def test_entered_in_error_frees_the_order_and_is_final(client: Any,  # noqa: F811
                                                       payers: dict[str, UUID]) -> None:
    patient = _patient(client)
    base = f"/api/v1/patients/{patient['id']}/coverages"
    first = client("fd").post(base, json=_coverage(payers["active"])).json()
    path = f"{base}/{first['id']}"
    marked = client("bil").post(f"{path}/entered-in-error", json={"reason": "Wrong patient."})
    assert marked.status_code == 200, marked.text
    assert marked.json()["status"] == "entered-in-error"
    again = client("fd").post(f"{path}/entered-in-error", json={"reason": "Again."})
    assert again.status_code == 409 and again.json()["currentState"] == "entered-in-error"
    edit = client("fd").patch(path, json={"endDate": "2026-12-31"},
                              headers={"If-Match": marked.headers["ETag"], **MERGE})
    assert edit.status_code == 422 and edit.json()["code"] == "business-rule-violation"
    replacement = client("fd").post(base, json=_coverage(payers["active"], memberId="TEST-M-3"))
    assert replacement.status_code == 201  # the active-order index ignores it now
    statuses = {c["id"]: c["status"] for c in client("fd").get(base).json()["items"]}
    assert statuses[first["id"]] == "entered-in-error"


def test_permissions_other_clinic_and_restricted_chart(client: Any, payers: dict[str, UUID],  # noqa: F811
                                                       clinics: dict[UUID, UUID],  # noqa: F811
                                                       users: dict[str, CurrentUser]) -> None:  # noqa: F811
    patient = _patient(client)
    base = f"/api/v1/patients/{patient['id']}/coverages"
    coverage = client("fd").post(base, json=_coverage(payers["active"])).json()
    consents = f"/api/v1/patients/{patient['id']}/consents"
    assert client("ma").post(base, json=_coverage(payers["active"], order=2)).status_code == 403
    assert client("none").get(base).status_code == 403
    assert client("bil").post(consents, json=_consent()).status_code == 403
    for path in (base, f"{base}/{coverage['id']}", consents):
        assert client("md-b").get(path).status_code == 404, path
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_app")
    session = open_session(engine, clinics[CLINIC_A], users["fd"].id)
    session.execute(text("UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :i"),
                    {"i": patient["id"]})
    session.commit()
    session.close()
    engine.dispose()
    for response in (client("bil").get(base), client("bil").get(f"{base}/{coverage['id']}"),
                     client("fd").post(base, json=_coverage(payers["active"], order=2)),
                     client("md").get(consents), client("md").post(consents, json=_consent())):
        assert response.status_code == 403 and response.json()["code"] == "break-glass-required"


def test_consents_latest_of_a_kind_grantor_and_signed_form(client: Any,  # noqa: F811
                                                           clinics: dict[UUID, UUID]) -> None:  # noqa: F811
    patient = _patient(client)
    base = f"/api/v1/patients/{patient['id']}/consents"
    first = client("ma").post(base, json=_consent())
    assert first.status_code == 201, first.text
    assert first.json()["status"] == "active" and first.json()["policyVersion"] == "2026-10"
    second = client("md").post(base, json=_consent(decision="deny",
                                                   signedAt="2026-11-04T09:00:00Z"))
    assert second.status_code == 201
    assert client("fd").post(base, json=_consent(kind="ambient-recording")).status_code == 201
    treatment = client("fd").get(base, params={"kind": "treatment"}).json()["items"]
    assert [(c["id"], c["status"], c["decision"]) for c in treatment] == [
        (second.json()["id"], "active", "deny"), (first.json()["id"], "inactive", "permit")]
    assert len(client("fd").get(base).json()["items"]) == 3
    stranger = client("fd").post(base, json=_consent(grantorRelatedPersonId=str(uuid.uuid4())))
    assert stranger.status_code == 422
    assert stranger.json()["errors"][0]["code"] == "invalid-reference"
    guardian = client("fd").post(f"/api/v1/patients/{patient['id']}/related-persons", json={
        "name": {"family": "Haddad", "given": ["Omar"]},
        "relationships": [{"system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
                           "code": "GUARD", "display": "guardian"}]}).json()
    signed = client("fd").post(base, json=_consent(kind="financial",
                                                   grantorRelatedPersonId=guardian["id"]))
    assert signed.status_code == 201 and signed.json()["grantorRelatedPersonId"] == guardian["id"]
    missing_file = client("fd").post(base, json=_consent(signedFormFileId=str(uuid.uuid4())))
    assert missing_file.status_code == 422 and missing_file.json()["code"] == "file-not-ready"
    clean, card = uuid.uuid4(), uuid.uuid4()
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.begin() as c:
        insert = text("INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, "
                      "content_type, size_bytes, sha256, scan_status, scanned_at, purpose, state) "
                      "VALUES (:i, :t, 'docs', :k, 'application/pdf', 10, :h, 'clean', now(), "
                      ":p, 'clean')")
        for file_id, purpose in ((clean, "document"), (card, "insurance-card")):
            c.execute(insert, {"i": file_id, "t": clinics[CLINIC_A], "k": f"k/{file_id}.pdf",
                               "h": "c" * 64, "p": purpose})
    admin.dispose()
    with_form = client("fd").post(base, json=_consent(kind="privacy-notice",
                                                      signedFormFileId=str(clean)))
    assert with_form.status_code == 201, with_form.text
    assert with_form.json()["signedFormFileId"] == str(clean)
    wrong_purpose = client("fd").post(base, json=_consent(kind="privacy-notice",
                                                          signedFormFileId=str(card)))
    assert wrong_purpose.status_code == 422 and wrong_purpose.json()["code"] == "file-not-ready"


@OPENBAO
def test_keyed_coverage_and_consent_are_replayed_not_repeated(client: Any,  # noqa: F811
                                                              payers: dict[str, UUID]) -> None:
    patient = _patient(client)
    coverages = f"/api/v1/patients/{patient['id']}/coverages"
    key = {"Idempotency-Key": str(uuid.uuid4())}
    body = _coverage(payers["active"])
    first = client("fd").post(coverages, json=body, headers=key)
    assert first.status_code == 201, first.text
    replay = client("fd").post(coverages, json=body, headers=key)
    assert replay.status_code == 201 and replay.headers["Idempotent-Replayed"] == "true"
    assert replay.json() == first.json()
    assert len(client("fd").get(coverages).json()["items"]) == 1  # added once
    reused = client("fd").post(coverages, json=_coverage(payers["active"], order=2), headers=key)
    assert reused.status_code == 422 and reused.json()["code"] == "idempotency-key-reused"
    consents = f"/api/v1/patients/{patient['id']}/consents"
    consent_key = {"Idempotency-Key": str(uuid.uuid4())}
    once = client("fd").post(consents, json=_consent(), headers=consent_key)
    twice = client("fd").post(consents, json=_consent(), headers=consent_key)
    assert once.status_code == twice.status_code == 201 and twice.json() == once.json()
    assert twice.headers["Idempotent-Replayed"] == "true"
    assert [c["status"] for c in client("fd").get(consents).json()["items"]] == ["active"]
