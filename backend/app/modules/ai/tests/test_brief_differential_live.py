"""The morning brief and the differential through the real API on a live database, with a local
stand-in for the Claude API (D116): sourced statements, a restricted chart never read, the
diagnosing permission, the switch, requester-only reads. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import json
import uuid
from collections.abc import Callable
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.encounters.tests.test_doctor_visit_live import _checked_in, _grant
from app.modules.scheduling.tests.conftest import ZONE, Practice
from app.modules.scheduling.tests.test_check_in_live import (
    _check_in,
    _sql,
    _today_appointment,
)

from .stub_claude_server import StubClaudeServer
from .test_ai01_dictation_live import _chart
from .test_ai01_live import _code
from .test_ai02_live import _summary_on

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
BRIEFS = f"{API}/ai/morning-briefs"
DDX = f"{API}/ai/differentials"
Client = Callable[[str], TestClient]


def _today() -> str:
    return dt.datetime.now(ZoneInfo(ZONE)).date().isoformat()


def _sent(server: StubClaudeServer) -> str:
    text: str = server.requests[-1]["messages"][0]["content"][0]["text"]
    return text


def _handle(text: str, kind: str) -> str:
    return next(line.split(":", 1)[0] for line in text.splitlines() if f": {kind}:" in line)


def _as_provider(practice: Practice, user: CurrentUser) -> None:
    """Links the user's account to the practice's provider, whose appointments the tests book."""
    _sql(practice, "UPDATE admin.app_user SET practitioner_id = NULL WHERE practitioner_id = :p",
         p=practice.provider)
    _sql(practice, "UPDATE admin.app_user SET practitioner_id = :p WHERE id = :u",
         p=practice.provider, u=user.id)


def test_a_brief_cites_each_chart_and_never_reads_a_restricted_one(
        client: Client, practice: Practice, users: dict[str, CurrentUser],
        claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    _chart(client, practice)
    _as_provider(practice, users["md"])
    _today_appointment(practice, "kaia", hour=9)
    _today_appointment(practice, "restricted", hour=10)
    claude_server.reply = json.dumps({"patients": []})
    first = client("md").post(BRIEFS, json={"date": _today()})
    assert first.status_code == 202 and first.json()["status"] == "succeeded", first.text
    sent = _sent(claude_server)
    assert "P1-S" in sent and "Allergy: Peanuts" in sent and "Patient P2" not in sent
    for secret in (practice.patients["kaia"], practice.patients["restricted"]):
        assert str(secret) not in sent
    claude_server.reply = json.dumps({"patients": [{"patient": "P1", "statements": [
        {"text": "Peanut allergy, high criticality.", "sources": [_handle(sent, "Allergy")]},
        {"text": "Recently hospitalized.", "sources": []}]}]})
    made = client("md").post(BRIEFS, json={"date": _today()})
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    brief_id = made.json()["result"]["id"]
    got = client("md").get(f"{BRIEFS}/{brief_id}")
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["aiGenerated"] is True and body["date"] == _today()
    kaia, restricted = body["appointments"]
    assert kaia["patientId"] == str(practice.patients["kaia"])
    assert kaia["chartStatus"] == "summarized"
    assert [s["text"] for s in kaia["statements"]] == ["Peanut allergy, high criticality."]
    assert kaia["statements"][0]["sources"][0]["resourceType"] == "AllergyIntolerance"
    assert restricted["chartStatus"] == "restricted" and restricted["statements"] == []
    # Requester only.
    assert client("md-b").get(f"{BRIEFS}/{brief_id}").status_code == 404
    assert client("md").get(f"{BRIEFS}/{uuid.uuid4()}").status_code == 404
    # With a grant the restricted chart is read on the next brief (it holds nothing, so it is
    # not sent to the model).
    _grant(practice, users["md"], practice.patients["restricted"])
    claude_server.reply = json.dumps({"patients": []})
    again = client("md").post(BRIEFS, json={"date": _today()})
    assert again.json()["status"] == "succeeded"
    second = client("md").get(f"{BRIEFS}/{again.json()['result']['id']}").json()
    assert second["appointments"][1]["chartStatus"] == "nothing-recorded"


def test_a_day_without_appointments_calls_no_model(
        client: Client, practice: Practice, claude_server: StubClaudeServer) -> None:
    """md's own practitioner has no appointments: an empty brief, and no model call."""
    _summary_on(client)
    _today_appointment(practice, "kaia", hour=9)   # the practice provider's, not md's
    made = client("md").post(BRIEFS, json={"date": _today()})
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    got = client("md").get(f"{BRIEFS}/{made.json()['result']['id']}").json()
    assert got["appointments"] == []
    assert claude_server.requests == []


def test_brief_refusals(client: Client, practice: Practice) -> None:
    off = client("md").post(BRIEFS, json={"date": _today()})
    assert off.status_code == 409 and _code(off) == "feature-disabled"
    _summary_on(client)
    for user in ("rn", "ma", "fd", "bil", "none"):
        denied = client(user).post(BRIEFS, json={"date": _today()})
        assert denied.status_code == 403 and _code(denied) == "permission-denied", user
    for bad in ({}, {"date": "tomorrow"}, {"date": _today(), "extra": 1}):
        assert client("md").post(BRIEFS, json=bad).status_code == 422, bad
    assert client("rn").get(f"{BRIEFS}/{uuid.uuid4()}").status_code == 403


def test_a_differential_cites_the_visit_and_suggests_only(
        client: Client, practice: Practice, claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    _chart(client, practice)
    encounter = _checked_in(client, practice, "kaia")
    claude_server.reply = json.dumps({"candidates": [], "insufficientEvidence": True})
    first = client("md").post(DDX, json={"encounterId": encounter})
    assert first.status_code == 202 and first.json()["status"] == "succeeded", first.text
    sent = _sent(claude_server)
    assert "This visit:" in sent and "Reason for visit: " in sent and "Medication: " in sent
    assert str(practice.patients["kaia"]) not in sent and encounter not in sent
    claude_server.reply = json.dumps({"candidates": [
        {"condition": "Tension-type headache", "rationale": "Follow-up on headaches.",
         "likelihood": "medium", "sources": [_handle(sent, "Reason for visit")]},
        {"condition": "Migraine", "rationale": "Aura.", "likelihood": "high", "sources": []}],
        "insufficientEvidence": False})
    made = client("md").post(DDX, json={"encounterId": encounter})
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    ddx_id = made.json()["result"]["id"]
    got = client("md").get(f"{DDX}/{ddx_id}")
    assert got.status_code == 200, got.text
    body = got.json()
    assert [c["condition"] for c in body["candidates"]] == ["Tension-type headache"]
    assert body["candidates"][0]["confidence"] == "medium"
    assert body["candidates"][0]["sources"][0]["resourceType"] == "Encounter"
    assert body["encounterId"] == encounter and body["insufficientEvidence"] is False
    # Nothing was added to the visit.
    visit = client("md").get(f"{API}/encounters/{encounter}").json()
    assert all(d.get("code", {}).get("text") != "Tension-type headache"
               for d in visit.get("diagnoses", []))
    assert client("md-b").get(f"{DDX}/{ddx_id}").status_code == 404
    # The request is recorded as decision support, with hashes and counts only.
    rows = _sql(practice, "SELECT feature, error_message FROM admin.ai_request WHERE "
                "encounter_id = :e AND status = 'completed'", e=uuid.UUID(encounter))
    assert rows and all(r[0] == "decision-support" and r[1] is None for r in rows)


def test_differential_refusals(client: Client, practice: Practice,
                               users: dict[str, CurrentUser],
                               claude_server: StubClaudeServer) -> None:
    encounter = _checked_in(client, practice, "kaia")
    off = client("md").post(DDX, json={"encounterId": encounter})
    assert off.status_code == 409 and _code(off) == "feature-disabled"
    _summary_on(client)
    for user in ("rn", "ma", "fd", "bil", "none"):
        denied = client(user).post(DDX, json={"encounterId": encounter})
        assert denied.status_code == 403 and _code(denied) == "permission-denied", user
    assert client("md").post(DDX, json={"encounterId": "nope"}).status_code == 422
    assert client("md").post(DDX, json={"encounterId": str(uuid.uuid4())}).status_code == 404
    assert client("md-b").post(DDX, json={"encounterId": encounter}).status_code in (404, 409)
    checked = _check_in(client, _today_appointment(practice, "restricted", hour=14),
                        selfPay=True)
    assert checked.status_code == 200, checked.text
    restricted = checked.json()["encounterId"]
    refused = client("md").post(DDX, json={"encounterId": restricted})
    assert refused.status_code == 403 and _code(refused) == "break-glass-required"
    assert claude_server.requests == []
    _grant(practice, users["md"], practice.patients["restricted"])
    claude_server.reply = json.dumps({"candidates": [], "insufficientEvidence": True})
    assert client("md").post(DDX, json={"encounterId": restricted}).json()["status"] == \
        "succeeded"
