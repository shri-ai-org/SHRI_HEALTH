"""Chart Q&A through the real API on a live database with a local stand-in for the Claude API:
an answer with citations, "not in the chart", the front desk's scheduling-only answers, the
cached chart block, suggested questions, and the refusals (permission, AI off, restricted chart,
another clinic, another user's answer, the budget). Synthetic data only."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.encounters.tests.test_doctor_visit_live import _checked_in, _grant
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import _sql

from .stub_claude_server import StubClaudeServer
from .test_ai01_dictation_live import _chart
from .test_ai01_live import _code
from .test_ai02_live import _summary_on

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
ASK = f"{API}/ai/chart-questions"
Client = Callable[[str], TestClient]


def _ask(client: Client, user: str, patient: uuid.UUID, question: str = "Any allergies?",
         page: str = "consultation") -> Any:
    return client(user).post(ASK, json={"question": question, "pageType": page,
                                        "patientId": str(patient)})


def _handle(sent: dict[str, Any], kind: str) -> str:
    text: str = sent["messages"][0]["content"][0]["text"]
    return next(line.split(":", 1)[0] for line in text.splitlines() if f": {kind}:" in line)


def test_an_answer_cites_its_records_and_only_its_requester_reads_it(
        client: Client, practice: Practice, users: dict[str, CurrentUser],
        claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    _chart(client, practice)
    patient = practice.patients["kaia"]
    claude_server.reply = json.dumps({"statements": [], "insufficientEvidence": True})
    first = _ask(client, "md", patient)
    sent = claude_server.requests[-1]
    chart_block, question_block = sent["messages"][0]["content"]
    assert chart_block["cache_control"] == {"type": "ephemeral"}
    assert "Allergy: Peanuts" in chart_block["text"] and str(patient) not in chart_block["text"]
    assert question_block["text"].endswith("Question: Any allergies?")
    # "Not in the chart": no statements, insufficient evidence.
    empty = client("md").get(f"{API}/ai/chart-answers/{first.json()['result']['id']}").json()
    assert empty["statements"] == [] and empty["insufficientEvidence"] is True
    assert empty["aiGenerated"] is True
    # An answer: the cited statement is kept with its record; the uncited one is dropped.
    claude_server.reply = json.dumps({"statements": [
        {"text": "Peanut allergy, high criticality.", "sources": [_handle(sent, "Allergy")]},
        {"text": "Also allergic to penicillin.", "sources": []}],
        "insufficientEvidence": False})
    made = _ask(client, "md", patient)
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    answer_id = made.json()["result"]["id"]
    got = client("md").get(f"{API}/ai/chart-answers/{answer_id}")
    assert got.status_code == 200, got.text
    body = got.json()
    assert [s["text"] for s in body["statements"]] == ["Peanut allergy, high criticality."]
    assert body["statements"][0]["sources"][0]["resourceType"] == "AllergyIntolerance"
    assert body["insufficientEvidence"] is False and body["question"] == "Any allergies?"
    assert body["generatedBy"]["modelName"] == "claude-sonnet-5-5"
    # Requester only: a colleague, another clinic.
    for other in ("rn", "ma", "md-b"):
        assert client(other).get(f"{API}/ai/chart-answers/{answer_id}").status_code == 404, other
    assert client("md").get(f"{API}/ai/chart-answers/{uuid.uuid4()}").status_code == 404
    # The question and the answer stay out of the request record.
    rows = _sql(practice, "SELECT error_message, input_sha256 FROM admin.ai_request WHERE "
                "patient_id = :p AND status = 'completed'", p=patient)
    assert all(len(r[1]) == 64 and r[0] is None for r in rows)


def test_the_front_desk_gets_scheduling_answers_only(
        client: Client, practice: Practice, claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    _chart(client, practice)
    patient = practice.patients["kaia"]
    _checked_in(client, practice, "kaia")
    claude_server.reply = json.dumps({"statements": [], "insufficientEvidence": True})
    made = _ask(client, "fd", patient, "Does the patient have allergies?", "front-desk")
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    text = claude_server.requests[-1]["messages"][0]["content"][0]["text"]
    assert "Appointment: " in text and "Scheduling only" in text
    for clinical in ("Peanuts", "Lisinopril", "Allergy:", "Medication:", "Diagnosis:"):
        assert clinical not in text
    assert "Patient: " not in text                      # no age or sex either
    # An encounterId from the front desk is ignored, never read: one that doesn't exist is not
    # a 404 (a read would say whether a visit exists), and the answer is stored without it.
    probe = client("fd").post(ASK, json={"question": "Next appointment?",
                                         "pageType": "front-desk", "patientId": str(patient),
                                         "encounterId": str(uuid.uuid4())})
    assert probe.status_code == 202, probe.text
    stored = client("fd").get(f"{API}/ai/chart-answers/{probe.json()['result']['id']}").json()
    assert "encounterId" not in stored
    suggested = client("fd").get(f"{API}/ai/suggested-questions",
                                 params={"pageType": "consultation"})
    assert suggested.status_code == 200
    assert all("appointment" in q.lower() or "seen" in q.lower()
               for q in suggested.json()["questions"])


def test_suggested_questions_follow_the_page(client: Client) -> None:
    got = client("md").get(f"{API}/ai/suggested-questions", params={"pageType": "prescribing"})
    assert got.status_code == 200 and "allergies" in " ".join(got.json()["questions"])
    assert client("md").get(f"{API}/ai/suggested-questions",
                            params={"pageType": "lobby"}).status_code == 422
    assert client("bil").get(f"{API}/ai/suggested-questions",
                             params={"pageType": "chart"}).status_code == 403


def test_question_refusals(client: Client, practice: Practice, users: dict[str, CurrentUser],
                           claude_server: StubClaudeServer) -> None:
    patient = practice.patients["kaia"]
    off = _ask(client, "md", patient)
    assert off.status_code == 409 and _code(off) == "feature-disabled"
    _summary_on(client)
    for user in ("bil", "adm", "none"):
        denied = _ask(client, user, patient)
        assert denied.status_code == 403 and _code(denied) == "permission-denied", user
    assert client("md").post(ASK, json={"question": "", "pageType": "chart",
                                        "patientId": str(patient)}).status_code == 422
    assert client("md").post(ASK, json={"question": "x" * 1001, "pageType": "chart",
                                        "patientId": str(patient)}).status_code == 422
    assert _ask(client, "md", uuid.uuid4()).status_code == 404
    # Restricted chart: 403 until break-glass.
    restricted = practice.patients["restricted"]
    refused = _ask(client, "md", restricted)
    assert refused.status_code == 403 and _code(refused) == "break-glass-required"
    # Another clinic: with its AI on, the patient is simply not found.
    _sql(practice, "UPDATE admin.tenant SET ai_enabled = true WHERE id = :t", t=practice.clinic_b)
    _sql(practice, "INSERT INTO admin.ai_feature_setting (id, tenant_id, feature, is_enabled) "
         "VALUES (gen_random_uuid(), :t, 'chart-summary', true)", t=practice.clinic_b)
    assert _ask(client, "md-b", patient).status_code == 404
    assert claude_server.requests == []
    _grant(practice, users["md"], restricted)
    claude_server.reply = json.dumps({"statements": [], "insufficientEvidence": True})
    assert _ask(client, "md", restricted).json()["status"] == "succeeded"


def test_the_budget_stops_an_answer(client: Client, practice: Practice,
                                    claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    _sql(practice, "INSERT INTO admin.ai_request (id, tenant_id, feature, status, "
         "pipeline_version, model_name, input_tokens, output_tokens) VALUES "
         "(gen_random_uuid(), :t, 'chart-summary', 'completed', 'gateway/2', "
         "'claude-sonnet-5-5', 60000000, 2500000)", t=practice.clinic)
    blocked = _ask(client, "md", practice.patients["kaia"])
    assert blocked.status_code == 202 and blocked.json()["status"] == "failed"
    assert "budget" in blocked.json()["error"]["detail"]
    assert claude_server.requests == []
