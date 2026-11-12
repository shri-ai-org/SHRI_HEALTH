"""AI-02, the chart summary, through the real API on a live database with a local stand-in for
the Claude API: create (202 operation) and read, the chart lines the model gets (only what the
clinician may read, names only), every statement linked to its record, the requester's
decision, the request record, the budget, and every refusal (permission, AI off, unknown or
restricted chart, another patient's visit, another clinic). Synthetic data only."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.encounters.tests.test_doctor_visit_live import _checked_in, _grant
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import _sql

from .stub_claude_server import StubClaudeServer
from .test_ai01_dictation_live import _chart
from .test_ai01_live import _code, _settings

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
SUMMARIES = f"{API}/ai/chart-summaries"
Client = Callable[[str], TestClient]
OTHER = "marcus"   # the fixture's second patient


def _summary_on(client: Client) -> None:
    saved = _settings(client, {"clinicEnabled": True, "features": [
        {"feature": "chart-summary", "enabled": True}]})
    assert saved.status_code == 200, saved.text


def _reply(user_text: str) -> str:
    """The stand-in's answer: one statement per allergy and medication line it was sent, plus
    one that cites nothing (which the gateway must drop)."""
    lines = [line for line in user_text.splitlines() if line.startswith("S")]
    allergy = next(line.split(":", 1)[0] for line in lines if ": Allergy:" in line)
    medication = next(line.split(":", 1)[0] for line in lines if ": Medication:" in line)
    return json.dumps({"sections": [
        {"topic": "allergies", "statements": [{"text": "Peanut allergy, high criticality.",
                                               "sources": [allergy]}]},
        {"topic": "medications", "statements": [
            {"text": "Lisinopril 10 mg daily.", "sources": [medication]},
            {"text": "Metformin 500 mg twice daily.", "sources": []}]}],
        "missing": [{"topic": "results", "description": "No results available."}]})


def test_a_summary_is_made_read_and_decided(client: Client, practice: Practice,
                                            users: dict[str, CurrentUser],
                                            claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    _chart(client, practice)
    encounter = _checked_in(client, practice, "kaia")
    patient = str(practice.patients["kaia"])
    claude_server.reply = "{}"
    first = client("md").post(SUMMARIES, json={"patientId": patient})   # learn the lines
    sent = claude_server.requests[-1]["messages"][0]["content"][0]["text"]
    assert "Allergy: Peanuts (high criticality)" in sent
    assert "Medication: Lisinopril 10 MG Oral Tablet, 1 tablet by mouth once daily" in sent
    assert "Visit: " in sent and "Not available: results (not in this build)" in sent
    assert patient not in sent and encounter not in sent                # names, never IDs
    assert first.json()["status"] == "failed"                           # "{}" fits nothing
    claude_server.reply = _reply(sent)
    made = client("md").post(SUMMARIES, json={"patientId": patient, "encounterId": encounter},
                             headers={"Idempotency-Key": str(uuid.uuid4())})
    assert made.status_code == 202, made.text
    op = made.json()
    assert (op["kind"], op["status"], op["result"]["type"]) == (
        "ai.chart-summary", "succeeded", "chart-summary")
    got = client("md").get(f"{SUMMARIES}/{op['result']['id']}")
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["patientId"] == patient and body["encounterId"] == encounter
    assert [s["topic"] for s in body["sections"]] == ["medications", "allergies"]
    statements = [st for s in body["sections"] for st in s["statements"]]
    assert [st["text"] for st in statements] == ["Lisinopril 10 mg daily.",
                                                 "Peanut allergy, high criticality."]
    assert all(st["sourceStatus"] == "sourced" and st["sources"] for st in statements)
    assert {st["sources"][0]["resourceType"] for st in statements} == {
        "MedicationRequest", "AllergyIntolerance"}
    assert body["missing"] == [{"topic": "results", "description": "No results available."}]
    suggestion = body["suggestion"]
    assert (suggestion["targetType"], suggestion["decision"], suggestion["confidence"]) == (
        "chart-summary", "pending", "low")                              # one was dropped
    assert suggestion["generatedBy"]["modelName"] == "claude-sonnet-5-5"
    # The requester accepts it; nobody else may decide it.
    decision = f"{API}/ai/suggestions/{suggestion['id']}/decision"
    assert client("rn").post(decision, json={"decision": "accepted"}).status_code in (403, 404)
    accepted = client("md").post(decision, json={"decision": "accepted"})
    assert accepted.status_code == 200 and accepted.json()["decision"] == "accepted"
    # The record: tokens and the chart records sent, never text; the read is audited.
    refs = {r[0] for r in _sql(practice, "SELECT i.resource_type FROM admin.ai_request_input_ref"
                               " i JOIN admin.ai_request r ON r.id = i.ai_request_id WHERE "
                               "r.feature = 'chart-summary' AND r.status = 'completed'")}
    assert {"Encounter", "AllergyIntolerance", "MedicationRequest"} <= refs
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE patient_id = :p AND "
                "category = 'ai' AND actor_user_id = :u", p=practice.patients["kaia"],
                u=users["md"].id)[0][0] >= 2


def test_summary_refusals(client: Client, practice: Practice, users: dict[str, CurrentUser],
                          claude_server: StubClaudeServer) -> None:
    patient = str(practice.patients["kaia"])
    body = {"patientId": patient}
    off = client("md").post(SUMMARIES, json=body)
    assert off.status_code == 409 and _code(off) == "feature-disabled"
    _summary_on(client)
    for user in ("fd", "bil", "none"):
        denied = client(user).post(SUMMARIES, json=body)
        assert denied.status_code == 403 and _code(denied) == "permission-denied", user
    assert client("md").post(SUMMARIES, json={}).status_code == 422
    assert client("md").post(SUMMARIES, json={**body, "extra": 1}).status_code == 422
    assert client("md").post(SUMMARIES, json={"patientId": str(uuid.uuid4())}
                             ).status_code == 404
    # Kaia's summary for another patient's visit: 422 at /encounterId.
    other_visit = _checked_in(client, practice, OTHER)
    wrong = client("md").post(SUMMARIES, json={**body, "encounterId": other_visit})
    assert wrong.status_code == 422 and wrong.json()["errors"][0]["pointer"] == "/encounterId"
    assert client("md").get(f"{SUMMARIES}/{uuid.uuid4()}").status_code == 404
    assert client("md").get(f"{SUMMARIES}/not-an-id").status_code == 422
    # Another clinic: with its AI on, the patient is simply not found.
    _sql(practice, "UPDATE admin.tenant SET ai_enabled = true WHERE id = :t", t=practice.clinic_b)
    _sql(practice, "INSERT INTO admin.ai_feature_setting (id, tenant_id, feature, is_enabled) "
         "VALUES (gen_random_uuid(), :t, 'chart-summary', true)", t=practice.clinic_b)
    assert client("md-b").post(SUMMARIES, json=body).status_code == 404
    assert claude_server.requests == []


def test_a_restricted_chart_needs_break_glass(client: Client, practice: Practice,
                                             users: dict[str, CurrentUser],
                                             claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    patient = practice.patients["restricted"]
    refused = client("md").post(SUMMARIES, json={"patientId": str(patient)})
    assert refused.status_code == 403 and _code(refused) == "break-glass-required"
    assert claude_server.requests == []
    _grant(practice, users["md"], patient)
    claude_server.reply = json.dumps({"sections": [], "missing": [
        {"topic": "outstanding-issues", "description": "Nothing recorded."}]})
    made = client("md").post(SUMMARIES, json={"patientId": str(patient)})
    assert made.status_code == 202 and made.json()["status"] == "succeeded"
    summary_id = made.json()["result"]["id"]
    assert client("md").get(f"{SUMMARIES}/{summary_id}").status_code == 200
    # Only its requester reads a summary: it was built from the requester's view of the chart.
    for colleague in ("rn", "ma", "md-b"):
        assert client(colleague).get(f"{SUMMARIES}/{summary_id}").status_code in (403, 404), \
            colleague
    _grant(practice, users["rn"], patient)       # even with a grant of their own
    assert client("rn").get(f"{SUMMARIES}/{summary_id}").status_code in (403, 404)


def test_the_budget_stops_a_summary(client: Client, practice: Practice,
                                    claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    _sql(practice, "INSERT INTO admin.ai_request (id, tenant_id, feature, status, "
         "pipeline_version, model_name, input_tokens, output_tokens) VALUES "
         "(gen_random_uuid(), :t, 'chart-summary', 'completed', 'gateway/2', "
         "'claude-sonnet-5-5', 60000000, 2500000)", t=practice.clinic)
    blocked = client("md").post(SUMMARIES, json={"patientId": str(practice.patients["kaia"])})
    assert blocked.status_code == 202 and blocked.json()["status"] == "failed"
    assert "budget" in blocked.json()["error"]["detail"]
    assert claude_server.requests == []



def test_the_summary_reads_the_problem_list(client: Client, practice: Practice,
                                            users: dict[str, CurrentUser],
                                            claude_server: StubClaudeServer) -> None:
    """The problem list (#280) goes to the model with its code, status and onset; an
    entered-in-error problem never does; medications carry the day they went on the list."""
    from app.modules.history.tests.history_seed import seed_history
    _summary_on(client)
    _chart(client, practice)
    seed_history(practice.clinic, users["md"].id, practice.patients["kaia"])
    claude_server.reply = "{}"
    client("md").post(SUMMARIES, json={"patientId": str(practice.patients["kaia"])})
    sent = claude_server.requests[-1]["messages"][0]["content"][0]["text"]
    problem = next(line for line in sent.splitlines() if ": Problem list: " in line)
    assert "Essential (primary) hypertension (I10), active, onset 2019-04" in problem
    assert "asthma" not in sent.lower()                 # entered in error: never sent
    assert "problem list" not in sent.split("Not available:")[-1]
    medication = next(line for line in sent.splitlines() if ": Medication: " in line)
    assert ", on the list since " in medication
