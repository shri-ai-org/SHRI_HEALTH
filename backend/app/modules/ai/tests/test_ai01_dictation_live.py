"""AI-01 from the clinician's dictation (the demo's "Draft with AI"), through the real API on a
live database, with a local stand-in for the Claude API (stub_claude_server.py) that the
official SDK talks to unchanged: the 202 operation, the draft note, the chart lines the model
gets (only what the clinician may read), the request's token record, the budget guard, a
refusal and an error, the stub provider without a key, and every refusal of the endpoint itself
(permission, validation, AI off, another clinic, a restricted chart). Synthetic data only."""

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
from app.modules.ai.stub_model import NOTICE
from app.modules.encounters.tests.test_doctor_visit_live import (
    _checked_in,
    _grant,
    _seeded_template,
)
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import _sql

from .stub_claude_server import StubClaudeServer
from .test_ai01_live import _ai_on, _code

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
DRAFTS = f"{API}/ai/note-drafts"
Client = Callable[[str], TestClient]
#: A fictional dictation; the logging check looks for these exact words.
DICTATION = ("Follow-up for high blood pressure. Home readings around 150 over 95 for two "
             "weeks. No chest pain. Taking lisinopril 10 milligrams daily. Plan: increase "
             "lisinopril to 20 milligrams daily and recheck in two weeks.")
#: The Follow-up template's sections (app.db.seed.starter FOLLOW-UP).
REPLY = {"sections": [
    {"code": "10154-3", "text": "Follow-up for high blood pressure."},
    {"code": "10164-2", "text": "Home readings around 150/95 for two weeks. No chest pain. "
                                "Taking lisinopril 10 mg daily."},
    {"code": "29545-1", "text": "Not discussed"},
    {"code": "51847-2", "text": "Increase lisinopril to 20 mg daily; recheck in two weeks."},
    {"code": "69730-0", "text": "Not discussed"}], "unknowns": []}


def _body(encounter: str, template: str, **extra: Any) -> dict[str, Any]:
    return {"encounterId": encounter, "dictation": DICTATION, "templateId": template, **extra}


def _chart(client: Client, practice: Practice, patient: str = "kaia") -> None:
    """A food allergy and a reported medication on the patient's chart."""
    base = f"{API}/patients/{practice.patients[patient]}"
    allergy = client("ma").post(f"{base}/allergies", json={
        "code": {"text": "Peanuts"}, "type": "allergy", "categories": ["food"],
        "criticality": "high"}, headers={"Idempotency-Key": str(uuid.uuid4())})
    assert allergy.status_code == 201, allergy.text
    medication = client("ma").post(f"{base}/medications", json={
        "medication": {"text": "Lisinopril 10 MG Oral Tablet"},
        "dosageText": "1 tablet by mouth once daily"})
    assert medication.status_code == 201, medication.text


def test_a_dictation_becomes_a_draft_note_through_the_claude_api(
        client: Client, practice: Practice, claude_server: StubClaudeServer,
        caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    claude_server.reply = json.dumps(REPLY)
    _ai_on(client)
    _chart(client, practice)
    encounter = _checked_in(client, practice, "kaia")
    template = _seeded_template(practice)
    made = client("md").post(DRAFTS, json=_body(encounter, template),
                             headers={"Idempotency-Key": str(uuid.uuid4())})
    assert made.status_code == 202, made.text
    operation = made.json()
    assert (operation["kind"], operation["status"]) == ("ai.note-draft", "succeeded")
    note_id = operation["result"]["id"]
    # One Messages API call: the template's sections, the chart lines, the dictation.
    [sent] = claude_server.requests
    assert sent["model"] == "claude-sonnet-5-5" and sent["output_config"]["effort"] == "low"
    assert sent["output_config"]["format"]["type"] == "json_schema"
    assert "- 10154-3: Chief complaint (required)" in sent["system"]
    assert 'exactly "Not discussed"' in sent["system"]
    user = sent["messages"][0]["content"][0]["text"]
    assert "Allergies: Peanuts (high criticality)." in user
    assert "Current medications: Lisinopril 10 MG Oral Tablet, 1 tablet by mouth once daily." \
        in user
    assert user.endswith(f"Dictation:\n{DICTATION}")
    assert str(practice.patients["kaia"]) not in json.dumps(sent)   # names only, never IDs
    # The draft: unsigned, every filled section AI-generated, pending and no-source.
    note = client("md").get(f"{API}/notes/{note_id}")
    assert note.status_code == 200, note.text
    sections = {s["code"]: s for s in note.json()["sections"]}
    assert sections["29545-1"]["text"] == "Not discussed"
    assert all(s["entrySource"] == "ai-generated" and s["aiDecision"] == "pending"
               for s in sections.values())
    suggestion = sections["10164-2"]["aiSuggestion"]
    assert suggestion["sourceStatus"] == "no-source" and suggestion["sources"] == []
    assert "clinician's dictation" in suggestion["rationale"]
    assert suggestion["generatedBy"]["modelName"] == "claude-sonnet-5-5"
    # The request record: tokens and the hash, the chart records it read, never the text.
    [(tokens_in, tokens_out, digest, template_row)] = _sql(
        practice, "SELECT input_tokens, output_tokens, input_sha256, prompt_template_id "
        "FROM admin.ai_request WHERE encounter_id = :e", e=encounter)
    assert (tokens_in, tokens_out) == (1200, 300) and len(digest) == 64
    assert template_row is None                      # the built-in prompt version
    refs = {r[0] for r in _sql(practice, "SELECT i.resource_type FROM admin.ai_request_input_ref "
                               "i JOIN admin.ai_request r ON r.id = i.ai_request_id WHERE "
                               "r.encounter_id = :e", e=encounter)}
    assert refs == {"Encounter", "AllergyIntolerance", "MedicationRequest"}
    # Nothing of the dictation, the chart lines or the draft reaches a log.
    logged = "\n".join(r.getMessage() for r in caplog.records)
    for secret in ("150 over 95", "Peanuts", "Lisinopril", "Home readings"):
        assert secret not in logged
    # Signing waits for the clinician's decisions (D70), as for a transcript's draft.
    signed = client("md").post(f"{API}/notes/{note_id}/sign",
                               headers={"If-Match": note.headers["ETag"]})
    assert signed.status_code == 422, signed.text
    assert {(e["pointer"], e["code"]) for e in signed.json()["errors"]} == {
        (f"/sections/{i}/aiDecision", "required") for i in range(5)}


def test_the_budget_stops_the_model_and_a_refusal_or_error_fails_the_operation(
        client: Client, practice: Practice, claude_server: StubClaudeServer) -> None:
    claude_server.reply = json.dumps(REPLY)
    _ai_on(client)
    encounter = _checked_in(client, practice, "kaia")
    template = _seeded_template(practice)
    body = _body(encounter, template)
    # A refusal: no draft, the operation fails as ai-unavailable, its tokens are recorded.
    claude_server.refuse = True
    refused = client("md").post(DRAFTS, json=body)
    assert refused.status_code == 202 and refused.json()["status"] == "failed"
    assert "ai-unavailable" in refused.json()["error"]["detail"]
    claude_server.refuse = False
    # An API error, the same way.
    claude_server.fail_with = 500
    errored = client("md").post(DRAFTS, json=body)
    assert errored.json()["status"] == "failed"
    claude_server.fail_with = None
    assert _sql(practice, "SELECT status, input_tokens FROM admin.ai_request WHERE "
                "encounter_id = :e ORDER BY created_at", e=encounter) == [
        ("failed", 1200), ("failed", None)]
    # This month's recorded use passes 140 USD: the model is not called again.
    _sql(practice, "INSERT INTO admin.ai_request (id, tenant_id, feature, status, "
         "pipeline_version, model_name, input_tokens, output_tokens) VALUES "
         "(gen_random_uuid(), :t, 'ambient-documentation', 'completed', 'gateway/2', "
         "'claude-sonnet-5-5', 60000000, 2500000)", t=practice.clinic)
    calls = len(claude_server.requests)
    blocked = client("md").post(DRAFTS, json=body)
    assert blocked.status_code == 202 and blocked.json()["status"] == "failed"
    assert "budget" in blocked.json()["error"]["detail"]
    assert len(claude_server.requests) == calls
    assert _sql(practice, "SELECT status FROM admin.ai_request WHERE encounter_id = :e "
                "ORDER BY created_at DESC LIMIT 1", e=encounter) == [("blocked",)]
    assert _sql(practice, "SELECT count(*) FROM clinical.composition WHERE encounter_id = :e",
                e=encounter)[0][0] == 0
    # Another clinic's spend is its own: clinic B still has its whole budget.
    assert client("md").get(f"{API}/encounters/{encounter}").json()["status"] == "arrived"


def test_without_a_key_the_stub_drafts_the_same_sample_note(
        client: Client, practice: Practice, monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("SHRI_AI_PROVIDER", "ANTHROPIC_API_KEY", "SHRI_AI_MODEL_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ENVIRONMENT", "test")
    _ai_on(client)
    encounter = _checked_in(client, practice, "kaia")
    made = client("md").post(DRAFTS, json=_body(encounter, _seeded_template(practice)))
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    note = client("md").get(f"{API}/notes/{made.json()['result']['id']}").json()
    texts = [s["text"] for s in note["sections"]]
    assert texts[0].startswith(NOTICE)
    assert _sql(practice, "SELECT model_name FROM admin.ai_request WHERE encounter_id = :e",
                e=encounter) == [("stub",)]


def test_dictation_permissions_validation_and_scope(
        client: Client, practice: Practice, users: dict[str, CurrentUser],
        claude_server: StubClaudeServer) -> None:
    claude_server.reply = json.dumps(REPLY)
    encounter = _checked_in(client, practice, "kaia")
    template = _seeded_template(practice)
    body = _body(encounter, template)
    # AI off: refused before anything is read or sent.
    off = client("md").post(DRAFTS, json=body)
    assert off.status_code == 409 and _code(off) == "feature-disabled"
    _ai_on(client)
    # Permission: the front desk, billing and the admin have no note-drafts:create.
    for user in ("fd", "bil", "adm", "none"):
        denied = client(user).post(DRAFTS, json=body)
        assert denied.status_code == 403 and _code(denied) == "permission-denied", user

    def rule(response: Any) -> tuple[int, str, str]:
        error = response.json()["errors"][0]
        return response.status_code, error["pointer"], error["code"]

    # Exactly one source.
    assert rule(client("md").post(DRAFTS, json={"templateId": template})) == (
        422, "/dictation", "required")
    assert rule(client("md").post(DRAFTS, json={**body, "transcriptionId": str(uuid.uuid4())})
                ) == (422, "/dictation", "conflicting-fields")
    assert rule(client("md").post(DRAFTS, json={"dictation": DICTATION,
                                                "templateId": template})) == (
        422, "/encounterId", "conflicting-fields")
    assert rule(client("md").post(DRAFTS, json={"encounterId": encounter,
                                                "transcriptionId": str(uuid.uuid4()),
                                                "templateId": template})) == (
        422, "/encounterId", "conflicting-fields")
    # Field validation: empty, too long, unknown field, bad ID.
    assert client("md").post(DRAFTS, json={**body, "dictation": ""}).status_code == 422
    assert client("md").post(DRAFTS, json={**body, "dictation": "x" * 20001}).status_code == 422
    assert client("md").post(DRAFTS, json={**body, "extra": 1}).status_code == 422
    assert client("md").post(DRAFTS, json={**body, "encounterId": "x"}).status_code == 422
    # An unknown encounter is 404. Another clinic sees neither clinic A's template (422
    # invalid-reference, checked first) nor its encounter, and its model is never called.
    assert client("md").post(DRAFTS, json={**body, "encounterId": str(uuid.uuid4())}
                             ).status_code == 404
    _sql(practice, "UPDATE admin.tenant SET ai_enabled = true WHERE id = :t", t=practice.clinic_b)
    _sql(practice, "INSERT INTO admin.ai_feature_setting (id, tenant_id, feature, is_enabled) "
         "VALUES (gen_random_uuid(), :t, 'ambient-documentation', true)", t=practice.clinic_b)
    other = client("md-b").post(DRAFTS, json=body)
    assert rule(other) == (422, "/templateId", "invalid-reference")
    assert claude_server.requests == []


def test_a_restricted_chart_needs_break_glass_for_a_dictation(
        client: Client, practice: Practice, users: dict[str, CurrentUser],
        claude_server: StubClaudeServer) -> None:
    claude_server.reply = json.dumps(REPLY)
    _ai_on(client)
    patient = practice.patients["restricted"]
    _grant(practice, users["fd"], patient)
    encounter = _checked_in(client, practice, "restricted")
    body = _body(encounter, _seeded_template(practice))
    refused = client("md").post(DRAFTS, json=body)
    assert refused.status_code == 403 and _code(refused) == "break-glass-required"
    assert claude_server.requests == []
    _grant(practice, users["md"], patient)
    granted = client("md").post(DRAFTS, json=body)
    assert granted.status_code == 202 and granted.json()["status"] == "succeeded"
