"""PR-1 endpoints: search, register, read, identifiers and related persons (patients.yaml).

Each endpoint: success, permission denied, a validation error, another clinic's patient (404),
a restricted chart (403 break-glass-required, then 200 with a grant), If-Match where the contract
requires it (428, 412), and the idempotent replay of a keyed POST. Runs on the fakes (fakes.py)
until the real pieces are on main. Synthetic data only.
"""

from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.deps import DEV_USERS

from .. import access
from .conftest import new_patient
from .fakes import MRN_SYSTEM, World

Client = Callable[[str], TestClient]


def register(as_user: Client, **overrides: Any) -> dict[str, Any]:
    response = as_user("fd").post("/api/v1/patients", json=new_patient(**overrides))
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def problem_code(response: Any) -> str:
    code: str = response.json()["code"]
    return code


# ----------------------------------------------------------------------------------- register
def test_register_assigns_the_mrn_and_returns_etag_and_location(as_user: Client) -> None:
    response = as_user("fd").post("/api/v1/patients", json=new_patient(
        identifiers=[{"type": "DL", "system": "urn:oid:2.16.840.1.113883.4.3.17",
                      "value": "TEST-DL-0001"}]))
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["mrn"] == "TEST-000001"
    assert response.headers["ETag"] == '"1"'
    assert response.headers["Location"] == f"/api/v1/patients/{body['id']}"
    types = {i["type"]: i for i in body["identifiers"]}
    assert types["MR"]["value"] == "TEST-000001" and types["MR"]["system"] == MRN_SYSTEM
    assert types["DL"]["value"] == "TEST-DL-0001"


def test_register_needs_patients_create(as_user: Client) -> None:
    assert as_user("ma").post("/api/v1/patients", json=new_patient()).status_code == 403
    assert as_user("none").post("/api/v1/patients", json=new_patient()).status_code == 403
    no_user = as_user("fd")
    del no_user.headers["X-Dev-User"]
    assert no_user.post("/api/v1/patients", json=new_patient()).status_code == 401


@pytest.mark.parametrize("change, code", [
    ({"birthDate": None}, "validation-failed"),
    ({"nickname": "Kai"}, "validation-failed"),  # unknown field: the body is closed
    ({"birthDate": "2999-01-01"}, "business-rule-violation"),
    ({"duplicateCheck": "override"}, "business-rule-violation"),  # override without a reason
    ({"identifiers": [{"type": "PI", "system": MRN_SYSTEM, "value": "TEST-000099"}]},
     "business-rule-violation"),  # an MRN only comes from the counter (D41)
])
def test_register_refuses_invalid_bodies(as_user: Client, change: dict[str, Any],
                                         code: str) -> None:
    body = new_patient(**change)
    if change.get("birthDate", "") is None:
        del body["birthDate"]
    response = as_user("fd").post("/api/v1/patients", json=body)
    assert response.status_code == 422, response.text
    assert problem_code(response) == code


def test_a_possible_duplicate_needs_an_override_with_a_reason(as_user: Client) -> None:
    first = register(as_user)
    again = as_user("fd").post("/api/v1/patients", json=new_patient(phones=[]))  # same name, DOB
    assert again.status_code == 409
    assert problem_code(again) == "possible-duplicate"
    assert again.json()["candidateIds"] == [first["id"]]
    override = as_user("fd").post("/api/v1/patients", json=new_patient(
        phones=[], duplicateCheck="override",
        duplicateOverrideReason="Different person: checked the ID at the desk."))
    assert override.status_code == 201
    assert override.json()["mrn"] == "TEST-000002"


@pytest.mark.xfail(strict=True, reason="Replay is core's idempotency middleware (T21, ADR-0007; "
                   "table in #52): not on main yet. Once it is, this passes and loses the mark.")
def test_a_keyed_registration_is_replayed_not_repeated(as_user: Client) -> None:
    fd = as_user("fd")
    headers = {"Idempotency-Key": str(uuid4())}  # one key, sent twice
    first = fd.post("/api/v1/patients", json=new_patient(), headers=headers)
    replay = fd.post("/api/v1/patients", json=new_patient(), headers=headers)
    assert first.status_code == replay.status_code == 201
    assert replay.json()["id"] == first.json()["id"]


# ------------------------------------------------------------------------------- read, search
def test_get_patient_with_etag(as_user: Client) -> None:
    created = register(as_user)
    response = as_user("ma").get(f"/api/v1/patients/{created['id']}")
    assert response.status_code == 200
    assert response.json()["mrn"] == created["mrn"]
    assert response.headers["ETag"] == '"1"'


def test_another_clinics_patient_is_not_found(as_user: Client) -> None:
    created = register(as_user)
    for path in ("", "/identifiers", "/related-persons"):
        response = as_user("md-b").get(f"/api/v1/patients/{created['id']}{path}")
        assert response.status_code == 404, path
        assert problem_code(response) == "not-found"


def test_a_restricted_chart_needs_break_glass(as_user: Client, world: World) -> None:
    created = register(as_user)
    patient_id = UUID(created["id"])
    next(iter(world.patients.values()))[patient_id].labels.add("R")
    refused = as_user("md").get(f"/api/v1/patients/{patient_id}")
    assert refused.status_code == 403
    assert problem_code(refused) == "break-glass-required"
    md = as_user("md")
    world.grants.add((DEV_USERS["md"].id, patient_id))
    assert md.get(f"/api/v1/patients/{patient_id}").status_code == 200


def test_get_patient_needs_patients_read(as_user: Client) -> None:
    created = register(as_user)
    assert as_user("dsp").get(f"/api/v1/patients/{created['id']}").status_code == 403


def test_search_by_family_and_birth_date(as_user: Client) -> None:
    created = register(as_user)
    response = as_user("fd").post("/api/v1/patients/search", json={
        "criteria": {"family": "Lind", "birthDate": "1990-03-14"}})
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [i["id"] for i in items] == [created["id"]]
    assert items[0]["phoneLast4"] == "0142"


def test_search_needs_an_identifier_or_two_criteria(as_user: Client) -> None:
    response = as_user("fd").post("/api/v1/patients/search", json={"criteria": {"family": "Lind"}})
    assert response.status_code == 422
    assert problem_code(response) == "business-rule-violation"


def test_search_refuses_a_bad_cursor_and_needs_patients_search(as_user: Client) -> None:
    bad = as_user("fd").post("/api/v1/patients/search", json={
        "criteria": {"mrn": "TEST-000001"}, "cursor": "bm90LWFuLW9mZnNldA"})
    assert bad.status_code == 400
    assert problem_code(bad) == "invalid-cursor"
    assert as_user("dsp").post("/api/v1/patients/search",
                               json={"criteria": {"mrn": "TEST-000001"}}).status_code == 403


# -------------------------------------------------------------------------------- identifiers
def test_add_and_list_identifiers(as_user: Client) -> None:
    created = register(as_user)
    path = f"/api/v1/patients/{created['id']}/identifiers"
    added = as_user("fd").post(path, json={"type": "PI", "system": "urn:oid:2.16.840.1.113883.3.0",
                                           "value": "TEST-PI-77"})
    assert added.status_code == 201, added.text
    assert added.json()["value"] == "TEST-PI-77"
    listed = as_user("fd").get(path)
    assert {i["type"] for i in listed.json()["items"]} == {"MR", "PI"}


def test_add_identifier_refusals(as_user: Client) -> None:
    created = register(as_user)
    path = f"/api/v1/patients/{created['id']}/identifiers"
    assert as_user("ma").post(path, json={"type": "PI", "value": "X"}).status_code == 403
    mr = as_user("fd").post(path, json={"type": "MR", "value": "TEST-000050"})
    assert mr.status_code == 422  # MR is not an accepted type
    mrn_system = as_user("fd").post(path, json={"type": "PI", "system": MRN_SYSTEM,
                                                "value": "TEST-000050"})
    assert mrn_system.status_code == 422
    assert problem_code(mrn_system) == "business-rule-violation"
    other = as_user("md-b").post(path, json={"type": "PI", "value": "X"})
    assert other.status_code in (403, 404)  # md-b may not update; either way nothing leaks


# ---------------------------------------------------------------------------- related persons
def _add_contact(as_user: Client, patient_id: str) -> Any:
    return as_user("fd").post(f"/api/v1/patients/{patient_id}/related-persons", json={
        "name": {"family": "Lindgren118", "given": ["Mats22"]},
        "relationships": [{"system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
                           "code": "EMC", "display": "emergency contact"}],
        "phones": [{"number": "+12175550199"}]})


def test_add_list_and_update_a_related_person(as_user: Client) -> None:
    created = register(as_user)
    added = _add_contact(as_user, created["id"])
    assert added.status_code == 201, added.text
    assert added.headers["ETag"] == '"1"'
    related_id = added.json()["id"]
    path = f"/api/v1/patients/{created['id']}/related-persons/{related_id}"
    assert len(as_user("fd").get(f"/api/v1/patients/{created['id']}/related-persons")
               .json()["items"]) == 1
    patched = as_user("fd").patch(path, json={"phones": [{"number": "+12175550123"}]},
                                  headers={"If-Match": '"1"',
                                           "Content-Type": "application/merge-patch+json"})
    assert patched.status_code == 200, patched.text
    assert patched.headers["ETag"] == '"2"'
    assert patched.json()["phones"] == [{"number": "+12175550123", "textMessages": False}]


def test_update_related_person_needs_a_current_if_match(as_user: Client) -> None:
    created = register(as_user)
    related_id = _add_contact(as_user, created["id"]).json()["id"]
    path = f"/api/v1/patients/{created['id']}/related-persons/{related_id}"
    patch = {"phones": []}
    missing = as_user("fd").patch(path, json=patch)
    assert missing.status_code == 428
    assert problem_code(missing) == "precondition-required"
    stale = as_user("fd").patch(path, json=patch, headers={"If-Match": '"7"'})
    assert stale.status_code == 412
    assert stale.headers["ETag"] == '"1"'
    assert as_user("ma").patch(path, json=patch, headers={"If-Match": '"1"'}).status_code == 403


def test_related_person_validation_and_other_clinic(as_user: Client) -> None:
    created = register(as_user)
    path = f"/api/v1/patients/{created['id']}/related-persons"
    no_relationship = as_user("fd").post(path, json={"name": {"family": "Lindgren118"},
                                                     "relationships": []})
    assert no_relationship.status_code == 422
    assert as_user("md-b").get(path).status_code == 404


# ------------------------------------------------------------------------------ fail closed
def test_without_the_real_chart_check_patient_reads_fail_closed(app: FastAPI,
                                                                as_user: Client) -> None:
    created = register(as_user)
    del app.dependency_overrides[access.chart_check]
    response = as_user("md").get(f"/api/v1/patients/{created['id']}")
    assert response.status_code == 503  # until core's ensure_chart_access (#83) is on main
