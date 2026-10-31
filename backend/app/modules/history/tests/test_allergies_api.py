"""The allergy operations with the in-memory fakes (fakes.py): each with a success, a
permission-denied and a validation-error case, plus the rules (substance systems, dates, merged
charts, If-Match, the nurse's own entries). Synthetic data only."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient

from .fakes import World

Client = Callable[[str], TestClient]
API = "/api/v1"
MERGE = {"Content-Type": "application/merge-patch+json"}
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
PENICILLIN: dict[str, Any] = {
    "code": {"codings": [{"system": RXNORM, "code": "7980", "display": "Penicillin G"}]},
    "type": "allergy", "categories": ["medication"], "criticality": "high",
    "reactions": [{"manifestations": [{"text": "Hives"}], "severity": "moderate"}],
}


def _add(as_user: Client, patient: uuid.UUID, user: str = "ma", **body: Any) -> Any:
    return as_user(user).post(f"{API}/patients/{patient}/allergies", json={**PENICILLIN, **body})


def _errors(response: Any) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = response.json()["errors"]
    return errors


def test_add_read_and_list(as_user: Client, world: World) -> None:
    patient = world.patient()
    created = _add(as_user, patient)
    assert created.status_code == 201, created.text
    allergy = created.json()
    assert created.headers["Location"] == f"{API}/patients/{patient}/allergies/{allergy['id']}"
    assert created.headers["ETag"] == '"1"'
    assert allergy["code"]["codings"][0]["code"] == "7980"
    assert allergy["clinicalStatus"] == "active" and allergy["verificationStatus"] == "confirmed"
    assert allergy["reactions"] == [{"manifestations": [{"codings": [], "text": "Hives"}],
                                     "severity": "moderate"}]
    one = as_user("md").get(f"{API}/patients/{patient}/allergies/{allergy['id']}")
    assert one.status_code == 200 and one.headers["ETag"] == '"1"'
    listed = as_user("md").get(f"{API}/patients/{patient}/allergies")
    assert listed.status_code == 200 and [a["id"] for a in listed.json()["items"]] == [
        allergy["id"]]


def test_reads_are_refused(as_user: Client, world: World) -> None:
    patient = world.patient()
    allergy = _add(as_user, patient).json()["id"]
    assert as_user("fd").get(f"{API}/patients/{patient}/allergies").status_code == 403
    assert as_user("none").get(f"{API}/patients/{patient}/allergies/{allergy}"
                               ).status_code == 403
    assert as_user("md-b").get(f"{API}/patients/{patient}/allergies").status_code == 404
    assert as_user("md").get(f"{API}/patients/{patient}/allergies/{uuid.uuid4()}"
                             ).status_code == 404
    assert as_user("md").get(f"{API}/patients/{patient}/allergies/nope").status_code == 422
    assert as_user("md").get(f"{API}/patients/{patient}/allergies",
                             params={"limit": 0}).status_code == 422
    world.restricted.add(patient)
    refused = as_user("md").get(f"{API}/patients/{patient}/allergies")
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"


def test_add_is_refused(as_user: Client, world: World) -> None:
    patient = world.patient()
    assert _add(as_user, patient, "fd").status_code == 403
    assert _add(as_user, patient, "none").status_code == 403
    missing = as_user("ma").post(f"{API}/patients/{patient}/allergies", json={"type": "allergy"})
    assert missing.status_code == 422 and missing.json()["code"] == "validation-failed"
    cases: list[tuple[dict[str, Any], str, str]] = [
        ({"code": {"codings": [{"system": "http://loinc.org", "code": "1-8"}]}},
         "/code/codings/0/system", "not-allowed-value"),
        ({"code": {"codings": [{"system": RXNORM, "code": "7980"},
                               {"system": RXNORM, "code": "733"}]}},
         "/code/codings/1", "out-of-range"),
        ({"code": {}}, "/code", "required"),
        ({"onsetDate": "2999-01-01"}, "/onsetDate", "out-of-range"),
        ({"onsetDate": "2019"}, "/onsetDate", "not-allowed-value"),
        ({"reactions": [{"manifestations": []}]}, "/reactions/0/manifestations", "required"),
        ({"encounterId": str(uuid.uuid4())}, "/encounterId", "invalid-reference"),
    ]
    for body, pointer, code in cases:
        refused = _add(as_user, patient, **body)
        assert refused.status_code == 422, body
        assert refused.json()["code"] == "business-rule-violation"
        assert {"in": "body", "pointer": pointer, "code": code} in _errors(refused), body
    world.merged.add(patient)
    merged = _add(as_user, patient)
    assert merged.status_code == 409 and merged.json()["code"] == "patient-merged"
    assert world.allergies == {}


def test_an_allergy_recorded_at_the_visit(as_user: Client, world: World) -> None:
    patient = world.patient()
    visit = uuid.uuid4()
    world.visits[visit] = (patient, "triaged")
    done = _add(as_user, patient, encounterId=str(visit), onsetDate="2019-05-03")
    assert done.status_code == 201, done.text
    assert done.json()["encounterId"] == str(visit) and done.json()["onsetDate"] == "2019-05-03"
    world.visits[visit] = (world.patient(), "triaged")  # another patient's visit
    assert _add(as_user, patient, encounterId=str(visit)).status_code == 422


def test_update_with_if_match(as_user: Client, world: World) -> None:
    patient = world.patient()
    allergy = _add(as_user, patient).json()["id"]
    path = f"{API}/patients/{patient}/allergies/{allergy}"
    done = as_user("ma").patch(path, json={"criticality": None, "note": "Since childhood."},
                               headers={"If-Match": '"1"', **MERGE})
    assert done.status_code == 200, done.text
    assert "criticality" not in done.json() and done.json()["note"] == "Since childhood."
    assert done.headers["ETag"] == '"2"'
    assert done.json()["code"]["codings"][0]["code"] == "7980"  # untouched


def test_update_is_refused(as_user: Client, world: World) -> None:
    patient = world.patient()
    allergy = _add(as_user, patient).json()["id"]
    path = f"{API}/patients/{patient}/allergies/{allergy}"
    tag = {"If-Match": '"1"', **MERGE}
    assert as_user("fd").patch(path, json={"note": "x"}, headers=tag).status_code == 403
    assert as_user("none").patch(path, json={"note": "x"}, headers=tag).status_code == 403
    assert as_user("ma").patch(path, json={"note": "x"}, headers=MERGE).status_code == 428
    stale = as_user("ma").patch(path, json={"note": "x"}, headers={"If-Match": '"5"', **MERGE})
    assert stale.status_code == 412 and stale.headers["ETag"] == '"1"'
    code = as_user("ma").patch(path, json={"code": {"text": "Peanut"}}, headers=tag)
    assert code.status_code == 422  # the substance never changes
    null = as_user("ma").patch(path, json={"clinicalStatus": None}, headers=tag)
    assert null.status_code == 422 and _errors(null)[0]["pointer"] == "/clinicalStatus"
    assert as_user("ma").patch(path, json={"criticality": "extreme"}, headers=tag
                               ).status_code == 422


def test_entered_in_error(as_user: Client, world: World) -> None:
    patient = world.patient()
    allergy = _add(as_user, patient, "md").json()["id"]
    path = f"{API}/patients/{patient}/allergies/{allergy}/entered-in-error"
    assert as_user("ma").post(path, json={"reason": "Wrong patient."}).status_code == 403
    assert as_user("none").post(path, json={"reason": "Wrong patient."}).status_code == 403
    assert as_user("md").post(path, json={}).status_code == 422
    assert as_user("md").post(path, json={"reason": ""}).status_code == 422
    nurse = as_user("rn").post(path, json={"reason": "Wrong patient."})
    assert nurse.status_code == 403  # RN marks only their own entries
    done = as_user("md").post(path, json={"reason": "Recorded on the wrong patient."})
    assert done.status_code == 200, done.text
    assert done.json()["verificationStatus"] == "entered-in-error"
    assert "clinicalStatus" not in done.json()
    again = as_user("md").post(path, json={"reason": "Twice."})
    assert again.status_code == 409 and again.json()["currentState"] == "entered-in-error"
    listed = as_user("md").get(f"{API}/patients/{patient}/allergies").json()["items"]
    assert listed == []
    marked = as_user("md").get(f"{API}/patients/{patient}/allergies",
                               params={"includeEnteredInError": True}).json()["items"]
    assert [a["id"] for a in marked] == [allergy]


def test_a_nurse_marks_her_own_entry(as_user: Client, world: World) -> None:
    patient = world.patient()
    allergy = _add(as_user, patient, "rn").json()["id"]
    done = as_user("rn").post(f"{API}/patients/{patient}/allergies/{allergy}/entered-in-error",
                              json={"reason": "Typed on the wrong chart."})
    assert done.status_code == 200, done.text
