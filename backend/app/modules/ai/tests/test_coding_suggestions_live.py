"""ICD-10 coding suggestions through the real API on a live database, with a local stand-in for
the Claude API (D70, D119): only codes in the loaded ICD-10-CM table, named as the table names
them; nothing added until the clinician accepts; accepting adds the visit diagnosis, rejecting
doesn't; one decision per code; a signed visit refuses and keeps the code pending; the
permissions, the switch, a restricted chart and requester-only reads. Synthetic data only."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.encounters.tests.test_doctor_visit_live import (
    _checked_in,
    _grant,
    _signed_note,
)
from app.modules.encounters.tests.test_notes_live import _icd, _terminology
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import (
    _check_in,
    _sql,
    _today_appointment,
)

from .stub_claude_server import StubClaudeServer
from .test_ai01_dictation_live import _chart
from .test_ai01_live import _code
from .test_ai02_live import _summary_on
from .test_brief_differential_live import _handle, _sent

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
CODING = f"{API}/ai/coding-suggestions"
Client = Callable[[str], TestClient]
EMPTY = json.dumps({"codes": [], "insufficientEvidence": True})


def _diagnoses(client: Client, encounter: str) -> list[tuple[str, str]]:
    visit = client("md").get(f"{API}/encounters/{encounter}")
    assert visit.status_code == 200, visit.text
    return [(d["id"], d["code"]["code"]) for d in visit.json().get("diagnoses", [])]


def _decide(client: Client, set_id: str, code_id: str, user: str = "md", **body: str) -> Any:
    return client(user).post(f"{CODING}/{set_id}/codes/{code_id}/decision", json=body)


def test_codes_are_suggested_then_accepted_or_rejected_by_the_clinician(
        client: Client, practice: Practice, claude_server: StubClaudeServer,
        caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    _summary_on(client)
    _terminology(practice)
    _chart(client, practice)
    encounter = _checked_in(client, practice, "kaia")
    assert client("md").post(f"{API}/encounters/{encounter}/diagnoses",
                             json=_icd("I10")).status_code == 201
    claude_server.reply = EMPTY
    first = client("md").post(CODING, json={"encounterId": encounter})
    assert first.status_code == 202, first.text
    assert (first.json()["kind"], first.json()["status"]) == ("ai.coding-suggestion",
                                                              "succeeded")
    sent = _sent(claude_server)
    assert "This visit:" in sent and "Reason for visit: " in sent
    assert str(practice.patients["kaia"]) not in sent and encounter not in sent
    reason, medication = _handle(sent, "Reason for visit"), _handle(sent, "Medication")
    claude_server.reply = json.dumps({"codes": [
        {"code": "j069", "rationale": "Upper respiratory symptoms.", "likelihood": "medium",
         "sources": [reason]},
        {"code": "I10", "rationale": "Already coded.", "likelihood": "low",
         "sources": [reason]},
        {"code": "E11", "rationale": "A header code.", "likelihood": "low", "sources": [reason]},
        {"code": "Z99.999", "rationale": "Not in the table.", "likelihood": "low",
         "sources": [reason]},
        {"code": "E11.9", "rationale": "On metformin?", "likelihood": "low",
         "sources": [medication]},
        {"code": "J06.9", "rationale": "Uncited.", "likelihood": "medium", "sources": []}],
        "insufficientEvidence": False})
    made = client("md").post(CODING, json={"encounterId": encounter})
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    set_id = made.json()["result"]["id"]
    got = client("md").get(f"{CODING}/{set_id}")
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["aiGenerated"] is True and body["encounterId"] == encounter
    assert [(c["code"], c["display"], c["confidence"], c["decision"]) for c in body["codes"]] == [
        ("J06.9", "Acute upper respiratory infection, unspecified", "medium", "pending"),
        ("E11.9", "Type 2 diabetes mellitus without complications", "low", "pending")]
    assert body["codes"][0]["sources"][0]["resourceType"] == "Encounter"
    # Nothing is added until the clinician accepts.
    assert [c for _, c in _diagnoses(client, encounter)] == ["I10"]
    upper, diabetes = body["codes"]
    accepted = _decide(client, set_id, upper["id"], decision="accepted")
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["decision"] == "accepted" and accepted.json()["decidedBy"]["id"]
    now = dict(_diagnoses(client, encounter))
    assert now[accepted.json()["diagnosisId"]] == "J06.9"
    again = _decide(client, set_id, upper["id"], decision="rejected", reason="Changed my mind.")
    assert again.status_code == 409 and _code(again) == "invalid-state-transition"
    assert _decide(client, set_id, diabetes["id"], decision="rejected").status_code == 422
    rejected = _decide(client, set_id, diabetes["id"], decision="rejected",
                       reason="No diabetes on the chart.")
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["rejectionReason"] == "No diabetes on the chart."
    assert "diagnosisId" not in rejected.json()
    assert sorted(c for _, c in _diagnoses(client, encounter)) == ["I10", "J06.9"]
    decided = client("md").get(f"{CODING}/{set_id}").json()["codes"]
    assert [c["decision"] for c in decided] == ["accepted", "rejected"]
    # Requester only; a code is never decided through decideAiSuggestion.
    assert client("md-b").get(f"{CODING}/{set_id}").status_code == 404
    assert client("app").get(f"{CODING}/{set_id}").status_code == 404
    assert _decide(client, set_id, upper["id"], user="app",
                   decision="accepted").status_code == 404
    assert client("md").post(f"{API}/ai/suggestions/{diabetes['id']}/decision",
                             json={"decision": "accepted"}).status_code == 404
    rows = _sql(practice, "SELECT feature, error_message FROM admin.ai_request WHERE "
                "encounter_id = :e AND status = 'completed'", e=uuid.UUID(encounter))
    assert rows and all(r[0] == "coding-suggestion" and r[1] is None for r in rows)
    logged = "\n".join(r.getMessage() for r in caplog.records)
    for secret in ("Upper respiratory symptoms", "No diabetes on the chart", "Peanut"):
        assert secret not in logged


def test_a_signed_visit_refuses_the_code_and_keeps_it_pending(
        client: Client, practice: Practice, claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    _terminology(practice)
    encounter = _checked_in(client, practice, "kaia")
    claude_server.reply = EMPTY
    client("md").post(CODING, json={"encounterId": encounter})
    reason = _handle(_sent(claude_server), "Reason for visit")
    claude_server.reply = json.dumps({"codes": [
        {"code": "J06.9", "rationale": "Symptoms.", "likelihood": "low", "sources": [reason]}],
        "insufficientEvidence": False})
    made = client("md").post(CODING, json={"encounterId": encounter})
    set_id = made.json()["result"]["id"]
    code = client("md").get(f"{CODING}/{set_id}").json()["codes"][0]
    _signed_note(client, practice, encounter)
    refused = _decide(client, set_id, code["id"], decision="accepted")
    assert refused.status_code == 409, refused.text
    assert _code(refused) in ("record-locked", "invalid-state-transition")
    assert client("md").get(f"{CODING}/{set_id}").json()["codes"][0]["decision"] == "pending"
    assert _diagnoses(client, encounter) == []


def test_coding_refusals(client: Client, practice: Practice, users: dict[str, CurrentUser],
                         claude_server: StubClaudeServer) -> None:
    encounter = _checked_in(client, practice, "kaia")
    off = client("md").post(CODING, json={"encounterId": encounter})
    assert off.status_code == 409 and _code(off) == "feature-disabled"
    _summary_on(client)
    some = str(uuid.uuid4())
    for user in ("rn", "ma", "fd", "bil", "adm", "none"):
        denied = client(user).post(CODING, json={"encounterId": encounter})
        assert denied.status_code == 403 and _code(denied) == "permission-denied", user
        read = client(user).get(f"{CODING}/{some}")
        assert read.status_code == 403 and _code(read) == "permission-denied", user
        decision = _decide(client, some, some, user=user, decision="accepted")
        assert decision.status_code == 403 and _code(decision) == "permission-denied", user
    for bad in ({}, {"encounterId": "nope"}, {"encounterId": encounter, "extra": 1}):
        assert client("md").post(CODING, json=bad).status_code == 422, bad
    assert _decide(client, some, some, decision="edited").status_code == 422
    assert client("md").post(CODING, json={"encounterId": some}).status_code == 404
    assert _decide(client, some, some, decision="accepted").status_code == 404
    checked = _check_in(client, _today_appointment(practice, "restricted", hour=14),
                        selfPay=True)
    assert checked.status_code == 200, checked.text
    restricted = checked.json()["encounterId"]
    refused = client("md").post(CODING, json={"encounterId": restricted})
    assert refused.status_code == 403 and _code(refused) == "break-glass-required"
    assert claude_server.requests == []
    _grant(practice, users["md"], practice.patients["restricted"])
    claude_server.reply = EMPTY
    allowed = client("md").post(CODING, json={"encounterId": restricted})
    assert allowed.json()["status"] == "succeeded", allowed.text
