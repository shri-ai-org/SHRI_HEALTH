"""The reads of problems, family, social and surgical history (inventory #90, #249, #98, #101,
#104) against a live database, as shri_app with core's tenant_db, chart check and audit running
for real. The records are written through Anand's helpers (history_seed.py), as the demo seed
writes them. Synthetic data only."""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import _sql

from .history_seed import Seeded, seed_history

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
READS = ("problems", "family-history", "social-history", "surgical-history")


def _seeded(practice: Practice, users: dict[str, CurrentUser]) -> tuple[str, Seeded]:
    patient = practice.patients["kaia"]
    return f"{API}/patients/{patient}", seed_history(practice.clinic, users["md"].id, patient)


def test_problems_list_and_one_problem(client: Any, practice: Practice,
                                      users: dict[str, CurrentUser]) -> None:
    base, seeded = _seeded(practice, users)
    listed = client("md").get(f"{base}/problems")
    assert listed.status_code == 200, listed.text
    items = listed.json()["items"]
    assert [p["id"] for p in items] == [str(seeded.problem)]  # entered-in-error left out
    problem = items[0]
    assert problem["code"]["codings"] == [{"system": "http://hl7.org/fhir/sid/icd-10-cm",
                                           "code": "I10",
                                           "display": "Essential (primary) hypertension"}]
    assert (problem["clinicalStatus"], problem["verificationStatus"]) == ("active", "confirmed")
    assert problem["onsetDate"] == "2019-04" and problem["note"] == "Home readings reviewed."
    assert problem["entrySource"] == "clinician" and problem["recordedBy"]["displayName"]
    marked = client("ma").get(f"{base}/problems", params={"includeEnteredInError": "true"})
    assert {p["id"]: p["verificationStatus"] for p in marked.json()["items"]} == {
        str(seeded.problem): "confirmed", str(seeded.asthma): "entered-in-error"}
    one = client("rn").get(f"{base}/problems/{seeded.problem}")
    assert one.status_code == 200 and one.json() == problem
    assert one.headers["ETag"].strip('"').isdigit()
    assert client("md").get(f"{base}/problems/{uuid.uuid4()}").status_code == 404


def test_family_social_and_surgical_history(client: Any, practice: Practice,
                                            users: dict[str, CurrentUser]) -> None:
    base, seeded = _seeded(practice, users)
    family = client("md").get(f"{base}/family-history")
    assert family.status_code == 200, family.text
    assert family.json()["items"] == [{
        "id": str(seeded.family), "patientId": str(practice.patients["kaia"]),
        "status": "completed",
        "relationship": {"codings": [{"system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
                                      "code": "MTH", "display": "mother"}]},
        "sex": "female", "deceased": False,
        "conditions": [{"code": {"codings": [{"system": "http://hl7.org/fhir/sid/icd-10-cm",
                                              "code": "I10",
                                              "display": "Essential (primary) hypertension"}]},
                        "onsetAge": 52}],
        "note": "Reported by the patient.", "entrySource": "clinician",
        "recordedAt": family.json()["items"][0]["recordedAt"],
        "recordedBy": family.json()["items"][0]["recordedBy"]}]
    social = client("ma").get(f"{base}/social-history").json()["items"]
    assert [s["id"] for s in social] == [str(seeded.social)]
    assert social[0]["code"]["codings"][0]["code"] == "72166-2"
    assert social[0]["value"] == {"codeableConcept": {"codings": [{
        "system": "http://snomed.info/sct", "code": "266919005",
        "display": "Never smoked tobacco"}]}}
    assert social[0]["effectiveDate"] == "2026-01-15" and social[0]["status"] == "final"
    surgical = client("rn").get(f"{base}/surgical-history").json()["items"]
    assert [s["id"] for s in surgical] == [str(seeded.surgical)]
    assert surgical[0]["performedDate"] == "1998" and surgical[0]["status"] == "completed"
    assert surgical[0]["bodySite"]["codings"][0]["code"] == "66754008"
    assert surgical[0]["note"] == "No complications."


def test_paging_with_a_cursor(client: Any, practice: Practice,
                              users: dict[str, CurrentUser]) -> None:
    base, seeded = _seeded(practice, users)
    first = client("md").get(f"{base}/problems",
                             params={"includeEnteredInError": "true", "limit": 1}).json()
    assert len(first["items"]) == 1 and first["nextCursor"]
    second = client("md").get(f"{base}/problems", params={
        "includeEnteredInError": "true", "limit": 1, "cursor": first["nextCursor"]}).json()
    assert len(second["items"]) == 1 and "nextCursor" not in second
    assert {first["items"][0]["id"], second["items"][0]["id"]} == {
        str(seeded.problem), str(seeded.asthma)}


def test_reads_need_their_permission(client: Any, practice: Practice,
                                     users: dict[str, CurrentUser]) -> None:
    base, seeded = _seeded(practice, users)
    for path in (*READS, f"problems/{seeded.problem}"):
        refused = client("fd").get(f"{base}/{path}")
        assert refused.status_code == 403, path
        assert refused.json()["code"] == "permission-denied", path


def test_validation_and_unknown_or_other_clinics_patient(client: Any, practice: Practice,
                                                         users: dict[str, CurrentUser]) -> None:
    base, seeded = _seeded(practice, users)
    for path in READS:
        assert client("md").get(f"{base}/{path}", params={"limit": 0}).status_code == 422, path
        bad = client("md").get(f"{base}/{path}", params={"cursor": "bm90LWEtY3Vyc29y"})
        assert bad.status_code == 400 and bad.json()["code"] == "invalid-cursor", path
        assert client("md").get(f"{API}/patients/{uuid.uuid4()}/{path}").status_code == 404
        assert client("md-b").get(f"{base}/{path}").status_code == 404, path
    assert client("md").get(f"{base}/problems/not-a-uuid").status_code == 422
    assert client("md-b").get(f"{base}/problems/{seeded.problem}").status_code == 404


def test_a_restricted_chart_needs_break_glass(client: Any, practice: Practice,
                                              users: dict[str, CurrentUser]) -> None:
    base, seeded = _seeded(practice, users)
    _sql(practice, "UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :i",
         i=practice.patients["kaia"])
    for path in (*READS, f"problems/{seeded.problem}"):
        refused = client("md").get(f"{base}/{path}")
        assert refused.status_code == 403, path
        assert refused.json()["code"] == "break-glass-required", path
