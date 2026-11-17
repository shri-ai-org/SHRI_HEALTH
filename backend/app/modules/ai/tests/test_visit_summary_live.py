"""The visit summary through the real API on a live database, with a local stand-in for the Claude
API (D119): sourced statements labelled as AI, an unreviewed AI note section never sent, nothing
written to the visit, the switch, the permission, a restricted chart, requester-only reads.
Synthetic data only."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.encounters.tests.test_doctor_visit_live import (
    _checked_in,
    _grant,
    _seeded_template,
)
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import (
    _check_in,
    _sql,
    _today_appointment,
)

from .stub_claude_server import StubClaudeServer
from .test_ai01_dictation_live import DICTATION, REPLY, _chart
from .test_ai01_live import _code, _settings
from .test_ai02_live import _summary_on
from .test_brief_differential_live import _handle, _sent

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
SUMMARIES = f"{API}/ai/visit-summaries"
Client = Callable[[str], TestClient]


def test_a_visit_summary_cites_the_visit_and_is_never_part_of_it(
        client: Client, practice: Practice, claude_server: StubClaudeServer,
        caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    _summary_on(client)
    _chart(client, practice)
    encounter = _checked_in(client, practice, "kaia")
    claude_server.reply = json.dumps({"statements": [], "insufficientEvidence": True})
    first = client("md").post(SUMMARIES, json={"encounterId": encounter})
    assert first.status_code == 202, first.text
    assert (first.json()["kind"], first.json()["status"]) == ("ai.visit-summary", "succeeded")
    sent = _sent(claude_server)
    assert "This visit:" in sent and "Reason for visit: " in sent and "Medication: " in sent
    assert str(practice.patients["kaia"]) not in sent and encounter not in sent
    claude_server.reply = json.dumps({"statements": [
        {"text": "Seen for a follow-up.", "sources": [_handle(sent, "Reason for visit")]},
        {"text": "Peanut allergy, high criticality.", "sources": [_handle(sent, "Allergy")]},
        {"text": "Chest X-ray was clear.", "sources": []}], "insufficientEvidence": False})
    made = client("md").post(SUMMARIES, json={"encounterId": encounter})
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    summary_id = made.json()["result"]["id"]
    got = client("md").get(f"{SUMMARIES}/{summary_id}")
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["aiGenerated"] is True and body["encounterId"] == encounter
    assert body["patientId"] == str(practice.patients["kaia"])
    assert [s["text"] for s in body["statements"]] == ["Seen for a follow-up.",
                                                       "Peanut allergy, high criticality."]
    assert [s["sources"][0]["resourceType"] for s in body["statements"]] == [
        "Encounter", "AllergyIntolerance"]
    assert body["insufficientEvidence"] is False
    assert body["generatedBy"]["modelName"] == "claude-sonnet-5-5"
    # Nothing was written to the visit: no note, no diagnosis.
    visit = client("md").get(f"{API}/encounters/{encounter}").json()
    assert visit.get("diagnoses", []) == []
    notes = client("md").get(f"{API}/encounters/{encounter}/notes").json()
    assert notes["items"] == []
    # Requester only; never decided as a suggestion.
    assert client("md-b").get(f"{SUMMARIES}/{summary_id}").status_code == 404
    assert client("rn").get(f"{SUMMARIES}/{summary_id}").status_code == 403  # no read permission
    assert client("md").get(f"{SUMMARIES}/{uuid.uuid4()}").status_code == 404
    decided = client("md").post(f"{API}/ai/suggestions/{summary_id}/decision",
                                json={"decision": "accepted"})
    assert decided.status_code == 404, decided.text
    # Recorded as a chart summary, with hashes and counts only; nothing of it in a log.
    rows = _sql(practice, "SELECT feature, error_message FROM admin.ai_request WHERE "
                "encounter_id = :e AND status = 'completed'", e=uuid.UUID(encounter))
    assert rows and all(r[0] == "chart-summary" and r[1] is None for r in rows)
    logged = "\n".join(r.getMessage() for r in caplog.records)
    for secret in ("Peanut", "Seen for a follow-up", "Lisinopril"):
        assert secret not in logged


def test_an_unreviewed_ai_section_is_never_a_source(
        client: Client, practice: Practice, claude_server: StubClaudeServer) -> None:
    """An AI draft whose sections nobody decided yet: none of its text reaches the summary."""
    saved = _settings(client, {"clinicEnabled": True, "features": [
        {"feature": "ambient-documentation", "enabled": True},
        {"feature": "chart-summary", "enabled": True}]})
    assert saved.status_code == 200, saved.text
    encounter = _checked_in(client, practice, "kaia")
    claude_server.reply = json.dumps(REPLY)
    drafted = client("md").post(f"{API}/ai/note-drafts", json={
        "encounterId": encounter, "dictation": DICTATION,
        "templateId": _seeded_template(practice)},
        headers={"Idempotency-Key": str(uuid.uuid4())})
    assert drafted.status_code == 202 and drafted.json()["status"] == "succeeded", drafted.text
    claude_server.reply = json.dumps({"statements": [], "insufficientEvidence": True})
    made = client("md").post(SUMMARIES, json={"encounterId": encounter})
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    sent = _sent(claude_server)
    assert "Note, " not in sent
    assert "Home readings" not in sent and "Increase lisinopril" not in sent


def test_visit_summary_refusals(client: Client, practice: Practice,
                                users: dict[str, CurrentUser],
                                claude_server: StubClaudeServer) -> None:
    encounter = _checked_in(client, practice, "kaia")
    off = client("md").post(SUMMARIES, json={"encounterId": encounter})
    assert off.status_code == 409 and _code(off) == "feature-disabled"
    _summary_on(client)
    for user in ("rn", "ma", "fd", "bil", "adm", "none"):
        denied = client(user).post(SUMMARIES, json={"encounterId": encounter})
        assert denied.status_code == 403 and _code(denied) == "permission-denied", user
        read = client(user).get(f"{SUMMARIES}/{uuid.uuid4()}")
        assert read.status_code == 403 and _code(read) == "permission-denied", user
    for bad in ({}, {"encounterId": "nope"}, {"encounterId": encounter, "extra": 1}):
        assert client("md").post(SUMMARIES, json=bad).status_code == 422, bad
    assert client("md").post(SUMMARIES,
                             json={"encounterId": str(uuid.uuid4())}).status_code == 404
    checked = _check_in(client, _today_appointment(practice, "restricted", hour=14),
                        selfPay=True)
    assert checked.status_code == 200, checked.text
    restricted = checked.json()["encounterId"]
    refused = client("md").post(SUMMARIES, json={"encounterId": restricted})
    assert refused.status_code == 403 and _code(refused) == "break-glass-required"
    assert claude_server.requests == []
    _grant(practice, users["md"], practice.patients["restricted"])
    claude_server.reply = json.dumps({"statements": [], "insufficientEvidence": True})
    allowed = client("md").post(SUMMARIES, json={"encounterId": restricted})
    assert allowed.json()["status"] == "succeeded", allowed.text
