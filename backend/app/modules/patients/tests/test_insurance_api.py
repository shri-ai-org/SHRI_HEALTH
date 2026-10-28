"""PR-2 endpoints: coverages and consents (patients.yaml; D45), on the fakes (fakes.py,
insurance_fakes.py). Each: success, permission denied, validation, another clinic's patient (404),
a restricted chart (403 break-glass-required, then 200 with a grant), If-Match on the PATCH (428,
412), and the business rules. None takes a facilityId, so the facility filter doesn't apply. The
same operations run against the real tables, with the idempotent replays, in
test_insurance_live.py. Synthetic data only."""

from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.core.deps import DEV_USERS

from ..insurance import CATEGORIES
from .conftest import new_patient
from .fakes import World

Client = Callable[[str], TestClient]
PAYER, INACTIVE_PAYER = uuid4(), uuid4()


@pytest.fixture(autouse=True)
def payers(world: World) -> None:
    world.payers[PAYER] = ("Example Health Plan (synthetic)", True)
    world.payers[INACTIVE_PAYER] = ("Closed Plan (synthetic)", False)


_SEQ = iter(range(10, 99))


def register(as_user: Client) -> str:
    n = next(_SEQ)  # a distinct synthetic person each time, so the duplicate check stays quiet
    response = as_user("fd").post("/api/v1/patients", json=new_patient(
        name={"family": f"Okafor{n}", "given": [f"Ade{n}"]}, birthDate=f"19{n}-02-11",
        phones=[{"number": f"+121755501{n}", "use": "mobile"}]))
    assert response.status_code == 201, response.text
    patient_id: str = response.json()["id"]
    return patient_id


def coverage_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"order": 1, "payerId": str(PAYER), "memberId": "TEST-MEMBER-001",
                            "relationshipToSubscriber": "self", "groupNumber": "TEST-GRP-7",
                            "groupName": "Demo employer group", "planName": "Gold PPO",
                            "startDate": "2026-01-01"}
    body.update(overrides)
    return body


def add(as_user: Client, patient_id: str, **overrides: Any) -> Any:
    return as_user("fd").post(f"/api/v1/patients/{patient_id}/coverages",
                              json=coverage_body(**overrides))


def code(response: Any) -> str:
    found: str = response.json()["code"]
    return found


def pointer(response: Any) -> str:
    found: str = response.json()["errors"][0]["pointer"]
    return found


MERGE = {"Content-Type": "application/merge-patch+json"}


# -------------------------------------------------------------------------------- coverages
def test_add_list_and_read_a_coverage(as_user: Client) -> None:
    patient_id = register(as_user)
    created = add(as_user, patient_id)
    assert created.status_code == 201, created.text
    body = created.json()
    assert created.headers["ETag"] == '"1"'
    assert created.headers["Location"] == f"/api/v1/patients/{patient_id}/coverages/{body['id']}"
    assert body["order"] == 1 and body["memberId"] == "TEST-MEMBER-001"
    assert body["groupNumber"] == "TEST-GRP-7" and body["groupName"] == "Demo employer group"
    assert body["planName"] == "Gold PPO" and body["status"] == "active"
    assert body["payerName"] == "Example Health Plan (synthetic)"
    listed = as_user("ma").get(f"/api/v1/patients/{patient_id}/coverages")
    assert listed.status_code == 200 and [c["id"] for c in listed.json()["items"]] == [body["id"]]
    one = as_user("bil").get(f"/api/v1/patients/{patient_id}/coverages/{body['id']}")
    assert one.status_code == 200 and one.headers["ETag"] == '"1"'


def test_coverage_permissions(as_user: Client) -> None:
    patient_id = register(as_user)
    cid = add(as_user, patient_id).json()["id"]
    base = f"/api/v1/patients/{patient_id}/coverages"
    assert as_user("ma").post(base, json=coverage_body(order=2)).status_code == 403
    assert as_user("none").get(base).status_code == 403
    assert as_user("ma").patch(f"{base}/{cid}", json={"endDate": "2026-12-31"},
                               headers={"If-Match": '"1"', **MERGE}).status_code == 403
    assert as_user("ma").post(f"{base}/{cid}/entered-in-error",
                              json={"reason": "Test."}).status_code == 403


def test_coverage_validation(as_user: Client) -> None:
    patient_id = register(as_user)
    missing = as_user("fd").post(f"/api/v1/patients/{patient_id}/coverages",
                                 json={"order": 1, "payerId": str(PAYER)})
    assert missing.status_code == 422 and code(missing) == "validation-failed"
    for bad in ({"order": 10}, {"relationshipToSubscriber": "cousin"}, {"memberId": ""},
                {"unknownField": True}):
        response = add(as_user, patient_id, **bad)
        assert response.status_code == 422 and code(response) == "validation-failed", bad


def test_coverage_business_rules(as_user: Client, world: World) -> None:
    patient_id = register(as_user)
    assert add(as_user, patient_id).status_code == 201
    taken = add(as_user, patient_id, memberId="TEST-MEMBER-002")  # order 1 again
    assert taken.status_code == 422 and code(taken) == "business-rule-violation"
    assert pointer(taken) == "/order"
    unknown = add(as_user, patient_id, order=2, payerId=str(uuid4()))
    assert unknown.status_code == 422 and pointer(unknown) == "/payerId"
    inactive = add(as_user, patient_id, order=2, payerId=str(INACTIVE_PAYER))
    assert inactive.status_code == 422 and pointer(inactive) == "/payerId"
    self_and_other = add(as_user, patient_id, order=2, subscriberRelatedPersonId=str(uuid4()))
    assert self_and_other.status_code == 422
    assert pointer(self_and_other) == "/subscriberRelatedPersonId"
    not_related = add(as_user, patient_id, order=2, relationshipToSubscriber="spouse",
                      subscriberRelatedPersonId=str(uuid4()))
    assert not_related.status_code == 422
    assert not_related.json()["errors"][0]["code"] == "invalid-reference"
    no_number = add(as_user, patient_id, order=2, groupNumber=None, groupName="A group")
    assert no_number.status_code == 422 and pointer(no_number) == "/groupNumber"
    backwards = add(as_user, patient_id, order=2, startDate="2026-06-01", endDate="2026-01-01")
    assert backwards.status_code == 422 and pointer(backwards) == "/endDate"


def test_a_spouse_subscriber_must_be_the_patients_related_person(as_user: Client) -> None:
    patient_id = register(as_user)
    related = as_user("fd").post(f"/api/v1/patients/{patient_id}/related-persons", json={
        "name": {"family": "Lindgren118", "given": ["Erik"]},
        "relationships": [{"system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
                           "code": "SPS", "display": "spouse"}]}).json()
    created = add(as_user, patient_id, relationshipToSubscriber="spouse",
                  subscriberRelatedPersonId=related["id"], subscriberId="TEST-SUB-9")
    assert created.status_code == 201, created.text
    assert created.json()["subscriberRelatedPersonId"] == related["id"]


def test_end_a_coverage_with_end_date_and_if_match(as_user: Client) -> None:
    patient_id = register(as_user)
    cid = add(as_user, patient_id).json()["id"]
    path = f"/api/v1/patients/{patient_id}/coverages/{cid}"
    missing = as_user("fd").patch(path, json={"endDate": "2026-12-31"}, headers=MERGE)
    assert missing.status_code == 428
    stale = as_user("fd").patch(path, json={"endDate": "2026-12-31"},
                                headers={"If-Match": '"9"', **MERGE})
    assert stale.status_code == 412 and stale.headers["ETag"] == '"1"'
    ended = as_user("fd").patch(path, json={"endDate": "2026-12-31", "groupName": None,
                                            "groupNumber": None},
                                headers={"If-Match": '"1"', **MERGE})
    assert ended.status_code == 200, ended.text
    assert ended.headers["ETag"] == '"2"'
    assert ended.json()["endDate"] == "2026-12-31" and "groupNumber" not in ended.json()
    assert ended.json()["planName"] == "Gold PPO"  # untouched


def test_update_coverage_refusals(as_user: Client) -> None:
    patient_id = register(as_user)
    first = add(as_user, patient_id).json()["id"]
    second = add(as_user, patient_id, order=2, memberId="TEST-MEMBER-002").json()["id"]
    path = f"/api/v1/patients/{patient_id}/coverages/{second}"
    headers = {"If-Match": '"1"', **MERGE}
    taken = as_user("fd").patch(path, json={"order": 1}, headers=headers)
    assert taken.status_code == 422 and pointer(taken) == "/order"
    payer = as_user("fd").patch(path, json={"payerId": str(uuid4())}, headers=headers)
    assert payer.status_code == 422 and pointer(payer) == "/payerId"  # not yet: Anand's helper
    nulled = as_user("fd").patch(path, json={"memberId": None}, headers=headers)
    assert nulled.status_code == 422 and code(nulled) == "validation-failed"
    swapped = as_user("fd").patch(f"/api/v1/patients/{patient_id}/coverages/{first}",
                                  json={"order": 3}, headers=headers)
    assert swapped.status_code == 200  # order 1 is free now
    assert as_user("fd").patch(path, json={"order": 1}, headers=headers).status_code == 200


def test_entered_in_error_is_final(as_user: Client) -> None:
    patient_id = register(as_user)
    cid = add(as_user, patient_id).json()["id"]
    path = f"/api/v1/patients/{patient_id}/coverages/{cid}"
    no_reason = as_user("fd").post(f"{path}/entered-in-error", json={"reason": ""})
    assert no_reason.status_code == 422
    marked = as_user("bil").post(f"{path}/entered-in-error", json={"reason": "Wrong patient."})
    assert marked.status_code == 200 and marked.json()["status"] == "entered-in-error"
    assert marked.headers["ETag"] == '"2"'
    again = as_user("fd").post(f"{path}/entered-in-error", json={"reason": "Again."})
    assert again.status_code == 409 and code(again) == "invalid-state-transition"
    assert again.json()["currentState"] == "entered-in-error"
    edit = as_user("fd").patch(path, json={"endDate": "2026-12-31"},
                               headers={"If-Match": '"2"', **MERGE})
    assert edit.status_code == 422 and code(edit) == "business-rule-violation"
    still = as_user("fd").get(path)
    assert still.status_code == 200 and still.json()["status"] == "entered-in-error"
    reused = add(as_user, patient_id)  # its order is free again
    assert reused.status_code == 201


def test_another_clinics_coverages_are_not_found(as_user: Client) -> None:
    patient_id = register(as_user)
    cid = add(as_user, patient_id).json()["id"]
    base = f"/api/v1/patients/{patient_id}/coverages"
    assert as_user("md-b").get(base).status_code == 404
    assert as_user("md-b").get(f"{base}/{cid}").status_code == 404
    other = register(as_user)
    assert as_user("fd").get(f"/api/v1/patients/{other}/coverages/{cid}").status_code == 404


def test_coverages_of_a_restricted_chart_need_break_glass(as_user: Client, world: World) -> None:
    patient_id = register(as_user)
    cid = add(as_user, patient_id).json()["id"]
    next(iter(world.patients.values()))[UUID(patient_id)].labels.add("R")
    base = f"/api/v1/patients/{patient_id}/coverages"
    for response in (as_user("bil").get(base), as_user("bil").get(f"{base}/{cid}"),
                     as_user("fd").post(base, json=coverage_body(order=2))):
        assert response.status_code == 403 and code(response) == "break-glass-required"
    world.grants.add((DEV_USERS["bil"].id, UUID(patient_id)))
    assert as_user("bil").get(base).status_code == 200


def test_list_coverages_pages_and_refuses_a_bad_cursor(as_user: Client) -> None:
    patient_id = register(as_user)
    for order in (1, 2, 3):
        assert add(as_user, patient_id, order=order, memberId=f"TEST-MEMBER-00{order}"
                   ).status_code == 201
    base = f"/api/v1/patients/{patient_id}/coverages"
    first = as_user("fd").get(base, params={"limit": 2}).json()
    assert [c["order"] for c in first["items"]] == [1, 2]
    rest = as_user("fd").get(base, params={"limit": 2, "cursor": first["nextCursor"]}).json()
    assert [c["order"] for c in rest["items"]] == [3] and "nextCursor" not in rest
    assert as_user("fd").get(base, params={"cursor": "bogus"}).status_code == 400


# --------------------------------------------------------------------------------- consents
def consent_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"kind": "treatment", "decision": "permit",
                            "signatureMethod": "electronic", "signedAt": "2026-11-03T15:05:00Z",
                            "policyVersion": "2026-10"}
    body.update(overrides)
    return body


def test_record_and_list_consents_the_latest_of_a_kind_is_active(as_user: Client) -> None:
    patient_id = register(as_user)
    base = f"/api/v1/patients/{patient_id}/consents"
    first = as_user("ma").post(base, json=consent_body())
    assert first.status_code == 201, first.text
    assert first.headers["ETag"] == '"1"' and first.headers["Location"] == base
    assert first.json()["status"] == "active" and first.json()["decision"] == "permit"
    second = as_user("fd").post(base, json=consent_body(signedAt="2026-11-04T09:00:00Z",
                                                        decision="deny"))
    assert second.status_code == 201
    as_user("fd").post(base, json=consent_body(kind="privacy-notice"))
    treatment = as_user("co").get(base, params={"kind": "treatment"}).json()["items"]
    assert [c["id"] for c in treatment] == [second.json()["id"], first.json()["id"]]  # newest
    assert [c["status"] for c in treatment] == ["active", "inactive"]
    assert len(as_user("co").get(base).json()["items"]) == 3


def test_consent_refusals(as_user: Client, world: World) -> None:
    patient_id = register(as_user)
    base = f"/api/v1/patients/{patient_id}/consents"
    assert as_user("bil").post(base, json=consent_body()).status_code == 403
    assert as_user("dsp").get(base).status_code == 403
    for bad in ({"kind": "marketing"}, {"decision": "maybe"}, {"signedAt": "yesterday"},
                {"extra": 1}):
        response = as_user("fd").post(base, json=consent_body(**bad))
        assert response.status_code == 422 and code(response) == "validation-failed", bad
    stranger = as_user("fd").post(base, json=consent_body(grantorRelatedPersonId=str(uuid4())))
    assert stranger.status_code == 422 and code(stranger) == "business-rule-violation"
    assert stranger.json()["errors"][0]["code"] == "invalid-reference"
    not_ready = as_user("fd").post(base, json=consent_body(signedFormFileId=str(uuid4())))
    assert not_ready.status_code == 422 and code(not_ready) == "file-not-ready"
    clean = uuid4()
    world.clean_files.add(clean)
    ready = as_user("fd").post(base, json=consent_body(signedFormFileId=str(clean)))
    assert ready.status_code == 201 and ready.json()["signedFormFileId"] == str(clean)
    assert as_user("md-b").get(base).status_code == 404
    next(iter(world.patients.values()))[UUID(patient_id)].labels.add("V")
    restricted = as_user("fd").get(base)
    assert restricted.status_code == 403 and code(restricted) == "break-glass-required"


def test_every_consent_kind_has_its_agreed_category() -> None:
    kinds = {"treatment", "privacy-notice", "ambient-recording", "telehealth", "research",
             "information-sharing", "financial"}
    assert set(CATEGORIES) == kinds
    assert [c.code for c in CATEGORIES["financial"]] == ["59284-0"]  # one fixed code (#88)
    assert [c.code for c in CATEGORIES["ambient-recording"]] == ["ICOL"]
