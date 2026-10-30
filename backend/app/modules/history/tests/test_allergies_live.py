"""Allergies against a live database (demo step 7), as shri_app, with core's tenant_db, chart check,
audit and idempotency and Anand's allergy helpers running for real. Uses scheduling's live
fixtures (conftest.py): a fresh clinic with synthetic patients and a user per role. Synthetic
data only."""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import (
    _check_in,
    _sql,
    _today_appointment,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
MERGE = {"Content-Type": "application/merge-patch+json"}
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
SNOMED = "http://snomed.info/sct"
PENICILLIN: dict[str, Any] = {
    "code": {"codings": [{"system": RXNORM, "code": "7980", "display": "Penicillin G"}]},
    "type": "allergy", "categories": ["medication"], "criticality": "high",
    "reactions": [{"manifestations": [{"codings": [{"system": SNOMED, "code": "247472004",
                                                    "display": "Hives"}]}],
                   "severity": "moderate"}],
    "note": "Reported by the patient at rooming.",
}


def _base(practice: Practice, patient: str = "kaia") -> str:
    return f"{API}/patients/{practice.patients[patient]}/allergies"


def test_add_read_edit_and_mark_an_allergy(client: Any, practice: Practice) -> None:
    appointment = _today_appointment(practice)
    encounter = _check_in(client, appointment, selfPay=True).json()["encounterId"]
    base = _base(practice)
    created = client("ma").post(base, json={**PENICILLIN, "encounterId": encounter},
                                headers={"Idempotency-Key": str(uuid.uuid4())})
    assert created.status_code == 201, created.text
    allergy = created.json()
    assert allergy["encounterId"] == encounter
    assert allergy["code"]["codings"] == [{"system": RXNORM, "code": "7980",
                                          "display": "Penicillin G"}]
    assert allergy["categories"] == ["medication"] and allergy["criticality"] == "high"
    assert allergy["reactions"][0]["manifestations"][0]["codings"][0]["code"] == "247472004"
    assert allergy["note"] == "Reported by the patient at rooming."
    assert allergy["entrySource"] == "clinician"
    path = f"{base}/{allergy['id']}"
    assert created.headers["Location"] == path
    read = client("md").get(path)
    assert read.status_code == 200 and read.headers["ETag"] == created.headers["ETag"]
    assert [a["id"] for a in client("rn").get(base).json()["items"]] == [allergy["id"]]

    assert client("ma").patch(path, json={"note": None}, headers=MERGE).status_code == 428
    edited = client("ma").patch(path, json={"criticality": "low", "note": None},
                                headers={"If-Match": created.headers["ETag"], **MERGE})
    assert edited.status_code == 200, edited.text
    assert edited.json()["criticality"] == "low" and "note" not in edited.json()
    assert edited.headers["ETag"] != created.headers["ETag"]
    stale = client("ma").patch(path, json={"criticality": "high"},
                               headers={"If-Match": created.headers["ETag"], **MERGE})
    assert stale.status_code == 412 and stale.headers["ETag"] == edited.headers["ETag"]

    nurse = client("rn").post(f"{path}/entered-in-error", json={"reason": "Wrong patient."})
    assert nurse.status_code == 403  # entered by the MA, not this nurse
    marked = client("md").post(f"{path}/entered-in-error",
                               json={"reason": "Recorded on the wrong patient."})
    assert marked.status_code == 200, marked.text
    assert marked.json()["verificationStatus"] == "entered-in-error"
    assert "clinicalStatus" not in marked.json()
    assert [tuple(r) for r in _sql(
        practice, "SELECT activity_code, reason_text FROM clinical.provenance "
        "WHERE target_id = :a", a=allergy["id"])] == [("NULLIFY",
                                                       "Recorded on the wrong patient.")]
    assert client("md").get(base).json()["items"] == []
    kept = client("md").get(base, params={"includeEnteredInError": "true"}).json()["items"]
    assert [a["id"] for a in kept] == [allergy["id"]]
    again = client("md").post(f"{path}/entered-in-error", json={"reason": "Twice."})
    assert again.status_code == 409
    audit = _sql(practice, "SELECT action FROM audit.audit_event WHERE entity_id = :a "
                 "AND patient_id = :p", a=allergy["id"],
                 p=practice.patients["kaia"])
    assert {r[0] for r in audit} >= {"read", "update"}


def test_allergies_are_refused(client: Any, practice: Practice) -> None:
    base = _base(practice)
    assert client("fd").post(base, json=PENICILLIN).status_code == 403
    assert client("fd").get(base).status_code == 403
    assert client("md-b").get(base).status_code == 404
    assert client("ma").post(base, json={"type": "allergy"}).status_code == 422
    loinc = client("ma").post(base, json={
        **PENICILLIN, "code": {"codings": [{"system": "http://loinc.org", "code": "1-8"}]}})
    assert loinc.status_code == 422 and loinc.json()["errors"][0] == {
        "in": "body", "pointer": "/code/codings/0/system", "code": "not-allowed-value"}
    assert client("ma").post(base, json={**PENICILLIN, "encounterId": str(uuid.uuid4())}
                             ).status_code == 422
    restricted = client("ma").get(_base(practice, "restricted"))
    assert restricted.status_code == 403 and restricted.json()["code"] == "break-glass-required"
    _sql(practice, "INSERT INTO clinical.patient_link (id, tenant_id, patient_id, "
         "other_patient_id, type) VALUES (:i, :t, :p, :o, 'replaced-by')",
         i=uuid.uuid4(), t=practice.clinic, p=practice.patients["marcus"],
         o=practice.patients["kaia"])
    merged = client("ma").post(_base(practice, "marcus"), json=PENICILLIN)
    assert merged.status_code == 409 and merged.json()["code"] == "patient-merged"
    assert _sql(practice, "SELECT count(*) FROM clinical.allergy_intolerance "
                "WHERE tenant_id = :t", t=practice.clinic)[0][0] == 0


def test_a_text_only_allergy_and_a_nurse_marking_her_own(client: Any,
                                                       practice: Practice) -> None:
    base = _base(practice)
    created = client("rn").post(base, json={"code": {"text": "Adhesive tape"},
                                            "categories": ["environment"],
                                            "onsetDate": "2018-06-01"})
    assert created.status_code == 201, created.text
    assert created.json()["code"] == {"codings": [], "text": "Adhesive tape"}
    assert created.json()["onsetDate"] == "2018-06-01"
    marked = client("rn").post(f"{base}/{created.json()['id']}/entered-in-error",
                               json={"reason": "Not this patient."})
    assert marked.status_code == 200, marked.text
