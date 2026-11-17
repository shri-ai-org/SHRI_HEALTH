"""decideVisitSummary through the real API on a live database, with a local stand-in for the
Claude API (D70, D119; Vimal on #85, 17 Nov): an accepted or edited summary goes at the top of
the draft note's first section in the decision's transaction, as a new note version marked
AI-assisted; a rejected one writes nothing; one decision only; a signed note refuses it and the
summary stays pending; requester only; the permission. Synthetic data only."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.encounters.tests.test_doctor_visit_live import (
    MERGE,
    _checked_in,
    _doctor,
    _seeded_template,
    _signed_note,
)
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
SUMMARIES = f"{API}/ai/visit-summaries"
Client = Callable[[str], TestClient]
SAID = "Seen for a follow-up."


def _summary(client: Client, server: StubClaudeServer, encounter: str) -> str:
    """A visit summary of one statement citing the visit's reason, made by md."""
    server.reply = json.dumps({"statements": [], "insufficientEvidence": True})
    probe = client("md").post(SUMMARIES, json={"encounterId": encounter})
    assert probe.status_code == 202, probe.text
    server.reply = json.dumps({"statements": [
        {"text": SAID, "sources": [_handle(_sent(server), "Reason for visit")]}],
        "insufficientEvidence": False})
    made = client("md").post(SUMMARIES, json={"encounterId": encounter})
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    summary_id: str = made.json()["result"]["id"]
    return summary_id


def _draft(client: Client, practice: Practice, encounter: str, first: str) -> dict[str, Any]:
    """md's draft note on the visit, its first section already written."""
    note = client("md").post(f"{API}/encounters/{encounter}/notes",
                             json={"templateId": _seeded_template(practice)})
    assert note.status_code == 201, note.text
    body: dict[str, Any] = note.json()
    top = min(body["sections"], key=lambda s: s["sequence"])
    write = client("md").patch(f"{API}/notes/{body['id']}",
                               json={"sections": [{"id": top["id"], "text": first}]},
                               headers={"If-Match": note.headers["ETag"], **MERGE})
    assert write.status_code == 200, write.text
    body["etag"] = write.headers["ETag"]
    return body


def _first_text(client: Client, note_id: str) -> tuple[str, Any]:
    got = client("md").get(f"{API}/notes/{note_id}")
    assert got.status_code == 200, got.text
    top = min(got.json()["sections"], key=lambda s: s["sequence"])
    return str(top["text"]), got


def test_an_accepted_summary_goes_into_the_draft_note_once(
        client: Client, practice: Practice, claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    _chart(client, practice)
    encounter = _checked_in(client, practice, "kaia")
    note = _draft(client, practice, encounter, "Headache for two days.")
    summary_id = _summary(client, claude_server, encounter)
    pending = client("md").get(f"{SUMMARIES}/{summary_id}")
    assert pending.status_code == 200 and pending.json()["decision"] == "pending", pending.text
    assert "noteId" not in pending.json()
    # Nothing in the note before the decision.
    assert _first_text(client, note["id"])[0] == "Headache for two days."

    path = f"{SUMMARIES}/{summary_id}/decision"
    done = client("md").post(path, json={"decision": "accepted", "noteId": note["id"]})
    assert done.status_code == 200, done.text
    assert done.json()["decision"] == "accepted" and done.json()["noteId"] == note["id"]
    assert done.json()["decidedBy"]["displayName"] and done.json()["decidedAt"]
    text, got = _first_text(client, note["id"])
    assert text.startswith(SAID) and text.endswith("Headache for two days.")
    assert got.json()["aiAssisted"] is True and got.json()["status"] == "preliminary"
    # A new version: the screen's old ETag no longer saves.
    stale = client("md").patch(f"{API}/notes/{note['id']}", json={"title": "Follow-up"},
                               headers={"If-Match": note["etag"], **MERGE})
    assert stale.status_code == 412, stale.text
    # One decision only; the database keeps it, with the note as its target.
    again = client("md").post(path, json={"decision": "rejected", "reason": "Changed my mind."})
    assert again.status_code == 409 and _code(again) == "invalid-state-transition", again.text
    rows = _sql(practice, "SELECT decision, target_id, decided_by_user_id IS NOT NULL FROM "
                "admin.ai_suggestion WHERE id = :id", id=uuid.UUID(summary_id))
    assert [(str(r[0]), r[1], r[2]) for r in rows] == [
        ("accepted", uuid.UUID(note["id"]), True)]
    shown = client("md").get(f"{SUMMARIES}/{summary_id}").json()
    assert shown["decision"] == "accepted" and shown["noteId"] == note["id"]

    # Edited: the clinician's own words go on top instead.
    edited_id = _summary(client, claude_server, encounter)
    edited = client("md").post(f"{SUMMARIES}/{edited_id}/decision", json={
        "decision": "edited", "noteId": note["id"], "text": "Follow-up; headache improving."})
    assert edited.status_code == 200, edited.text
    assert edited.json()["editedText"] == "Follow-up; headache improving."
    assert _first_text(client, note["id"])[0].startswith("Follow-up; headache improving.\n")

    # Rejected: nothing is written.
    before = _first_text(client, note["id"])[0]
    rejected_id = _summary(client, claude_server, encounter)
    rejected = client("md").post(f"{SUMMARIES}/{rejected_id}/decision",
                                 json={"decision": "rejected", "reason": "Not needed."})
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["rejectionReason"] == "Not needed."
    assert "noteId" not in rejected.json()
    assert _first_text(client, note["id"])[0] == before


def test_visit_summary_decision_refusals(
        client: Client, practice: Practice, users: dict[str, CurrentUser],
        claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    encounter = _checked_in(client, practice, "kaia")
    note = _draft(client, practice, encounter, "Cough.")
    summary_id = _summary(client, claude_server, encounter)
    path = f"{SUMMARIES}/{summary_id}/decision"
    accept = {"decision": "accepted", "noteId": note["id"]}
    for user in ("fd", "ma", "rn", "bil", "adm", "dsp", "none"):
        denied = client(user).post(path, json=accept)
        assert denied.status_code == 403 and _code(denied) == "permission-denied", user
    # Requester only: another clinic's MD and another MD of this clinic see nothing.
    assert client("md-b").post(path, json=accept).status_code == 404
    _doctor(practice, users, "md2", ("Okonkwo48", "Tamsin207"))
    assert client("md2").post(path, json=accept).status_code == 404
    for bad in ({"decision": "edited", "noteId": note["id"]},          # edited without text
                {"decision": "rejected"},                               # rejected, no reason
                {"decision": "accepted"},                               # no note
                {"decision": "accepted", "noteId": note["id"], "extra": 1}):
        refused = client("md").post(path, json=bad)
        assert refused.status_code == 422 and _code(refused) == "validation-failed", bad
    # A note of another visit is not this summary's.
    checked = _check_in(client, _today_appointment(practice, "marcus", hour=15), selfPay=True)
    assert checked.status_code == 200, checked.text
    other = _draft(client, practice, checked.json()["encounterId"], "Other visit.")
    wrong = client("md").post(path, json={"decision": "accepted", "noteId": other["id"]})
    assert wrong.status_code == 422 and _code(wrong) == "business-rule-violation", wrong.text
    # A signed note refuses the text; the summary stays pending and nothing is written.
    signed = _signed_note(client, practice, encounter)
    locked = client("md").post(path, json={"decision": "accepted", "noteId": signed["id"]})
    assert locked.status_code == 409 and _code(locked) == "record-locked", locked.text
    assert client("md").get(f"{SUMMARIES}/{summary_id}").json()["decision"] == "pending"
    assert SAID not in _first_text(client, signed["id"])[0]
    # Still decidable into the draft afterwards.
    done = client("md").post(path, json=accept)
    assert done.status_code == 200, done.text
    assert client("md").post(f"{SUMMARIES}/{uuid.uuid4()}/decision",
                             json=accept).status_code == 404
