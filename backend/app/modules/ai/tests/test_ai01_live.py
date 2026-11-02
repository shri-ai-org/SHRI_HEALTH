"""AI-01 end to end, through the real API on a live database, with a local stub model server
(an OpenAI-compatible chat API over real HTTP, stub_model_server.py): check-in, the AI settings,
a visit transcript, the note draft as a 202 operation, the draft note marked AI-generated with
its provenance, signing refused until the clinician decides each AI section, accept, edit and
reject, and the clinician's signature. With AI switched off, the draft is refused and the visit
still runs end to end. The evaluation harness (ai/eval) scores the stub's draft.

Everything goes through core's tenant_db, facility filter, chart check (D37), audit,
idempotency and operations, and Anand's helpers, as shri_app. The transcript is fictional: the
first visit of ai/eval's set. It is stored as the speech service would store it, through the
file service's encryption (sealed with a fixed test key), because the speech-to-text route
waits on the speech service and a transcript file purpose (see the module's report).
Synthetic data only."""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import sys
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.ai.prompts import NOTE_DRAFT_V1
from app.modules.ai.schemas import NOTE_DRAFT_SCHEMA, Segment
from app.modules.ai.transcripts import transcript_file
from app.modules.encounters.tests.test_doctor_visit_live import (
    MERGE,
    _checked_in,
    _doctor,
    _grant,
    _sections,
    _seeded_template,
)
from app.modules.encounters.tests.test_notes_live import _icd, _terminology
from app.modules.files import crypto as file_crypto_module
from app.modules.files import storage
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import _sql

from .stub_model_server import StubModelServer

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
Client = Callable[[str], TestClient]
REPO = Path(__file__).resolve().parents[5]
VISIT_FILE = REPO / "ai" / "eval" / "data" / "visits" / "visit-01.json"
COLLEAGUE = ("Achterberg29", "Linnea415")
SPEAKERS = {"clinician": "clinician", "patient": "patient"}   # anyone else: "other"


# ------------------------------------------------------------------------------------ set-up
def _visit() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(VISIT_FILE.read_text(encoding="utf-8"))
    assert data["synthetic"] is True
    return data


def _segments(visit: dict[str, Any]) -> tuple[Segment, ...]:
    return tuple(Segment(sequence=i, start_ms=(i - 1) * 6000, end_ms=i * 6000,
                         speaker=SPEAKERS.get(turn["speaker"], "other"), text=turn["text"],
                         confidence="high")
                 for i, turn in enumerate(visit["transcript"], start=1))


def _prompt(practice: Practice) -> None:
    """The clinic's prompt version 1 (a platform default needs Anand's migration)."""
    _sql(practice, "INSERT INTO admin.prompt_template (id, tenant_id, code, version, feature, "
         "template, output_schema, is_active) VALUES (gen_random_uuid(), :t, 'note-draft', 1, "
         "'ambient-documentation', :tpl, CAST(:schema AS jsonb), true)",
         t=practice.clinic, tpl=NOTE_DRAFT_V1, schema=json.dumps(NOTE_DRAFT_SCHEMA))


def _consent(client: Client, patient: uuid.UUID) -> str:
    """The patient's ambient-recording consent, recorded by the front desk."""
    signed = (dt.datetime.now(dt.UTC) - dt.timedelta(hours=1)).isoformat()
    made = client("fd").post(f"{API}/patients/{patient}/consents", json={
        "kind": "ambient-recording", "decision": "permit", "signatureMethod": "electronic",
        "signedAt": signed, "policyVersion": "2026-10"})
    assert made.status_code == 201, made.text
    consent: str = made.json()["id"]
    return consent


def _transcript(practice: Practice, store: storage.LocalFileStore,
                crypto: file_crypto_module.FileCrypto, encounter: str, patient: uuid.UUID,
                consent: str, segments: tuple[Segment, ...]) -> str:
    """A recording and its transcript as the speech service would leave them: the recording
    (``transcribed``) under the patient's consent, the speech request, and the transcript file
    sealed through the file service's encryption."""
    recording, request, file_id, transcript = (uuid.uuid4() for _ in range(4))
    key = storage.storage_key(practice.clinic, file_id)
    data = transcript_file(segments)
    sealed = asyncio.run(crypto.seal(data, context=key))
    asyncio.run(store.put(key, sealed.data, "application/json"))
    _sql(practice, "INSERT INTO admin.audio_recording (id, tenant_id, encounter_id, patient_id, "
         "consent_id, mode, duration_seconds, status) VALUES (:id, :t, :e, :p, :c, 'ambient', "
         "912, 'transcribed')", id=recording, t=practice.clinic, e=encounter, p=patient,
         c=consent)
    _sql(practice, "INSERT INTO admin.ai_request (id, tenant_id, feature, status, patient_id, "
         "encounter_id, pipeline_version, model_name, model_version) VALUES (:id, :t, "
         "'ambient-documentation', 'completed', :p, :e, 'asr-stub/1', 'faster-whisper-stub', "
         "'1.1.1')", id=request, t=practice.clinic, p=patient, e=encounter)
    _sql(practice, "INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, "
         "content_type, size_bytes, sha256, purpose, state, scan_status, scanned_at, "
         "wrapped_data_key) VALUES (:id, :t, 'clean', :k, 'application/json', :n, :h, "
         "'encounter-audio', 'clean', 'clean', now(), :w)", id=file_id, t=practice.clinic,
         k=key, n=len(data), h=hashlib.sha256(data).hexdigest(), w=sealed.wrapped_data_key)
    _sql(practice, "INSERT INTO admin.transcript (id, tenant_id, audio_recording_id, "
         "encounter_id, ai_request_id, language, binary_object_id, segment_count, asr_model) "
         "VALUES (:id, :t, :a, :e, :r, 'en-US', :f, :n, 'faster-whisper-stub')",
         id=transcript, t=practice.clinic, a=recording, e=encounter, r=request, f=file_id,
         n=len(segments))
    return str(transcript)


def _settings(client: Client, body: dict[str, Any], user: str = "adm") -> Any:
    tag = client(user).get(f"{API}/ai-settings").headers["ETag"]
    return client(user).put(f"{API}/ai-settings", json=body, headers={"If-Match": tag})


def _ai_on(client: Client) -> None:
    saved = _settings(client, {"clinicEnabled": True, "features": [
        {"feature": "ambient-documentation", "enabled": True}]})
    assert saved.status_code == 200, saved.text


def _reference(visit: dict[str, Any]) -> dict[str, str]:
    return {s["code"]: s["text"] for s in visit["referenceNote"]["sections"]}


def _stub_reply(visit: dict[str, Any]) -> str:
    """The stub model's answer: the visit's reference note in the output schema, plus one
    section the template lacks and a field outside the schema, which the gateway drops."""
    sections = [{"code": c, "text": t} for c, t in _reference(visit).items()]
    sections.append({"code": "11348-0", "text": "Past medical history it was never asked."})
    return json.dumps({"sections": sections, "unknowns": [], "diagnosis": "invented"})


def _code(response: Any) -> str:
    code: str = response.json()["code"]
    return code


def _decide(client: Client, suggestion: str, user: str = "md", **body: Any) -> Any:
    return client(user).post(f"{API}/ai/suggestions/{suggestion}/decision", json=body)


def _ready(client: Client, practice: Practice, file_store: storage.LocalFileStore,
           file_crypto: Any, patient: str = "kaia") -> tuple[str, str, str]:
    """Check-in, the patient's consent and the visit transcript: (encounter, transcript,
    template)."""
    visit = _visit()
    encounter = _checked_in(client, practice, patient)
    consent = _consent(client, practice.patients[patient])
    transcript = _transcript(practice, file_store, file_crypto, encounter,
                             practice.patients[patient], consent, _segments(visit))
    return encounter, transcript, _seeded_template(practice)


# ------------------------------------------------------------------------------------- tests
def test_ai01_from_transcript_to_the_clinicians_signature(
        client: Client, practice: Practice, users: dict[str, CurrentUser],
        model_server: StubModelServer, file_store: storage.LocalFileStore,
        file_crypto: Any) -> None:
    visit = _visit()
    reference = _reference(visit)
    model_server.reply = _stub_reply(visit)
    _doctor(practice, users, "md2", COLLEAGUE)
    _prompt(practice)
    _ai_on(client)

    # 1. Check-in opens the encounter; the doctor opens it.
    encounter, transcript, template = _ready(client, practice, file_store, file_crypto)
    opened = client("md").get(f"{API}/encounters/{encounter}")
    assert opened.status_code == 200 and opened.json()["status"] == "arrived"

    # The transcript, as the clinician reviews it (audited as a chart read).
    read = client("md").get(f"{API}/ai/transcriptions/{transcript}")
    assert read.status_code == 200, read.text
    body = read.json()
    assert (body["encounterId"], body["patientId"]) == (encounter,
                                                        str(practice.patients["kaia"]))
    assert [s["text"] for s in body["segments"]] == [t["text"] for t in visit["transcript"]]
    assert body["generatedBy"] == {"modelName": "faster-whisper-stub", "modelVersion": "1.1.1",
                                   "pipelineVersion": "asr-stub/1"}

    # 2. The draft: 202 with core's operation, finished in the request.
    started = client("md").post(f"{API}/ai/note-drafts",
                                json={"transcriptionId": transcript, "templateId": template})
    assert started.status_code == 202, started.text
    operation = started.json()
    assert (operation["kind"], operation["status"]) == ("ai.note-draft", "succeeded")
    assert operation["result"]["type"] == "note"
    note_id = operation["result"]["id"]

    # 3. The operation, read at its Location, is complete.
    location = started.headers["Location"]
    assert location == f"{API}/operations/{operation['id']}"
    polled = client("md").get(location)
    assert polled.status_code == 200 and polled.json()["status"] == "succeeded"
    assert client("md2").get(location).status_code == 404       # only its creator sees it

    # What the gateway sent: the template's sections and the transcript, nothing else.
    [sent] = model_server.requests
    system, user = sent["messages"]
    assert "- 10164-2: Interval history (required)" in system["content"]
    assert user["content"].startswith("Patient: ")
    assert visit["transcript"][1]["text"] in user["content"]
    assert sent["model"] == model_server.model and sent["temperature"] == 0.0

    # 4. A draft note, marked AI-generated, with its provenance.
    draft = client("md").get(f"{API}/notes/{note_id}")
    assert draft.status_code == 200, draft.text
    note = draft.json()
    assert (note["status"], note["aiAssisted"], note["encounterId"]) == (
        "preliminary", True, encounter)
    assert note["author"]["displayName"] == "Dr. Rowan310 Sorensen77"
    sections = {s["code"]: s for s in note["sections"]}
    assert set(sections) == set(reference)                  # the stray section was dropped
    for code, section in sections.items():
        assert section["text"] == reference[code]
        assert (section["entrySource"], section["aiDecision"]) == ("ai-generated", "pending")
        ai = section["aiSuggestion"]
        assert ai["id"] == section["aiSuggestionId"]
        assert (ai["targetType"], ai["targetId"], ai["noteId"]) == (
            "note-section", section["id"], note_id)
        assert (ai["feature"], ai["decision"], ai["suggestedText"]) == (
            "ambient-documentation", "pending", reference[code])
        assert ai["generatedBy"] == {"modelName": model_server.model,
                                     "promptCode": "note-draft", "promptVersion": 1,
                                     "pipelineVersion": "gateway/2"}
        assert ai["confidence"] in ("low", "medium") and "decidedBy" not in ai
    history = sections["10164-2"]["aiSuggestion"]
    assert history["sourceStatus"] == "sourced"
    assert {s["resourceType"] for s in history["sources"]} == {"Transcription"}
    assert {s["resourceId"] for s in history["sources"]} == {transcript}
    assert all(1 <= s["segment"] <= len(visit["transcript"]) for s in history["sources"])
    # The model's request record: hashes and references only.
    rows = _sql(practice, "SELECT r.status, r.model_name, r.input_sha256, r.input_tokens, "
                "array_agg(i.resource_type ORDER BY i.resource_type) FROM admin.ai_request r "
                "JOIN admin.ai_request_input_ref i ON i.ai_request_id = r.id WHERE "
                "r.encounter_id = :e AND r.prompt_template_id IS NOT NULL GROUP BY r.id",
                e=encounter)
    [(status, model_name, digest, tokens, refs)] = rows
    assert (status, model_name, tokens, refs) == (
        "completed", model_server.model, 900, ["Encounter", "Transcription"])
    assert len(digest) == 64
    # The first note started the visit.
    assert client("md").get(f"{API}/encounters/{encounter}").json()["status"] == "in-progress"
    # The draft is audited as AI, naming the patient.
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE category = 'ai' AND "
                "patient_id = :p", p=practice.patients["kaia"])[0][0] >= 1

    # 5. Signing is refused until every AI section is decided.
    path = f"{API}/notes/{note_id}"
    refused = client("md").post(f"{path}/sign", headers={"If-Match": draft.headers["ETag"]})
    assert refused.status_code == 422 and _code(refused) == "business-rule-violation"
    assert {e["pointer"] for e in refused.json()["errors"]} == {
        f"/sections/{i}/aiDecision" for i in range(len(reference))}

    # 6. The decisions. Only the note's author decides; the front desk has no permission.
    ids = {code: s["aiSuggestionId"] for code, s in sections.items()}
    assert _decide(client, ids["10154-3"], "fd", decision="accepted").status_code == 403
    colleague = _decide(client, ids["10154-3"], "md2", decision="accepted")
    assert colleague.status_code == 403 and _code(colleague) == "permission-denied"
    no_reason = _decide(client, ids["29545-1"], decision="rejected")
    assert no_reason.status_code == 422 and _code(no_reason) == "validation-failed"
    # The decision must match the section's text: unchanged text can't be "edited" ...
    same = _decide(client, ids["10164-2"], decision="edited")
    assert same.status_code == 422 and _code(same) == "business-rule-violation"
    # Accept.
    accepted = _decide(client, ids["10154-3"], decision="accepted")
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["decision"] == "accepted"
    assert accepted.json()["decidedBy"]["displayName"]
    twice = _decide(client, ids["10154-3"], decision="accepted")
    assert twice.status_code == 409 and twice.json()["currentState"] == "accepted"
    # Edit: the author changes the text through the note, then records "edited".
    note = client("md").get(path)
    edited_text = reference["10164-2"] + " Coffee limited to one cup in the morning."
    saved = client("md").patch(path, json=_sections(note.json(), {"10164-2": edited_text}),
                               headers={"If-Match": note.headers["ETag"], **MERGE})
    assert saved.status_code == 200, saved.text
    assert _decide(client, ids["10164-2"], decision="accepted").status_code == 422
    edited = _decide(client, ids["10164-2"], decision="edited")
    assert edited.status_code == 200 and edited.json()["decision"] == "edited"
    assert _sql(practice, "SELECT edited_content->>'text' FROM admin.ai_suggestion WHERE "
                "id = :i", i=ids["10164-2"])[0][0] == edited_text
    # Reject: the AI text must be gone first, then the reason is recorded.
    still = _decide(client, ids["29545-1"], decision="rejected", reason="Exam not as drafted.")
    assert still.status_code == 422
    note = client("md").get(path)
    own_exam = "Alert. Neurologic exam as documented by the clinician at the bedside."
    saved = client("md").patch(path, json=_sections(note.json(), {"29545-1": own_exam}),
                               headers={"If-Match": note.headers["ETag"], **MERGE})
    assert saved.status_code == 200, saved.text
    rejected = _decide(client, ids["29545-1"], decision="rejected",
                       reason="Exam not as drafted.")
    assert rejected.status_code == 200, rejected.text
    assert (rejected.json()["decision"], rejected.json()["rejectionReason"]) == (
        "rejected", "Exam not as drafted.")
    # Deciding never changed the note: its ETag is the one after the last edit.
    assert client("md").get(path).headers["ETag"] == saved.headers["ETag"]
    for code in ("51847-2", "69730-0"):
        assert _decide(client, ids[code], decision="accepted").status_code == 200

    # 7. Sign: never by anyone but the author, then by the clinician.
    tag = client("md").get(path).headers["ETag"]
    other = client("md2").post(f"{path}/sign", headers={"If-Match": tag})
    assert other.status_code == 403
    signed = client("md").post(f"{path}/sign", headers={"If-Match": tag})
    assert signed.status_code == 200, signed.text
    final = signed.json()
    assert (final["status"], final["signedBy"]["displayName"]) == (
        "final", "Dr. Rowan310 Sorensen77")
    by_code = {s["code"]: s for s in final["sections"]}
    assert by_code["10164-2"]["text"] == edited_text
    assert by_code["10164-2"]["aiDecision"] == "edited"
    assert by_code["29545-1"]["text"] == own_exam
    assert by_code["29545-1"]["entrySource"] == "clinician"    # rejected: the clinician's text
    assert _sql(practice, "SELECT a.ext_user_id FROM clinical.composition_attester a WHERE "
                "a.composition_id = :n AND a.mode = 'legal'", n=note_id)[0][0] == \
        users["md"].id
    # After signing, a decision is refused: the note is locked.
    late = _decide(client, ids["51847-2"], decision="accepted")
    assert late.status_code == 409 and _code(late) == "record-locked"
    # The rejected suggestion keeps its target and decision (the section's history).
    assert _sql(practice, "SELECT decision, target_id FROM admin.ai_suggestion WHERE id = :i",
                i=ids["29545-1"])[0] == ("rejected", uuid.UUID(sections["29545-1"]["id"]))


def test_the_harness_scores_the_stubs_draft(
        client: Client, practice: Practice, model_server: StubModelServer,
        file_store: storage.LocalFileStore, file_crypto: Any) -> None:
    """The draft the pipeline stored, in the model's output shape, scored by ai/eval's
    harness (lexical baseline): the stub returns the reference note, so it scores as one."""
    eval_root = REPO / "ai" / "eval"
    if not (eval_root / "shri_eval").is_dir():
        pytest.skip("ai/eval is not in this checkout")
    sys.path.insert(0, str(eval_root))
    try:
        from shri_eval.dataset import load_visits  # type: ignore[import-not-found]
        from shri_eval.scoring import score  # type: ignore[import-not-found]
    finally:
        sys.path.remove(str(eval_root))
    visit = _visit()
    model_server.reply = _stub_reply(visit)
    _prompt(practice)
    _ai_on(client)
    encounter, transcript, template = _ready(client, practice, file_store, file_crypto)
    started = client("md").post(f"{API}/ai/note-drafts",
                                json={"transcriptionId": transcript, "templateId": template})
    assert started.status_code == 202 and started.json()["status"] == "succeeded"
    note = client("md").get(f"{API}/notes/{started.json()['result']['id']}").json()
    stored = {"sections": [{"code": s["code"], "text": s["aiSuggestion"]["suggestedText"]}
                           for s in note["sections"] if s.get("aiSuggestion")],
              "unknowns": []}
    [harness_visit] = load_visits([visit["id"]])
    scores = score(harness_visit, json.dumps(stored))
    assert scores.format == 1.0 and scores.sectionCoverage == 1.0
    assert scores.invention == 1.0 and scores.overall >= 0.95, scores.as_dict()


def test_with_ai_off_the_draft_is_refused_and_the_visit_still_works(
        client: Client, practice: Practice, model_server: StubModelServer,
        file_store: storage.LocalFileStore, file_crypto: Any) -> None:
    _terminology(practice)
    _prompt(practice)
    _ai_on(client)
    off = _settings(client, {"clinicEnabled": True, "features": [
        {"feature": "ambient-documentation", "enabled": False,
         "reason": "Paused by the practice lead."}]})
    assert off.status_code == 200, off.text
    assert off.json()["features"][0] == {
        "feature": "ambient-documentation", "enabled": False,
        "reason": "Paused by the practice lead.",
        "updatedAt": off.json()["features"][0]["updatedAt"]}
    encounter, transcript, template = _ready(client, practice, file_store, file_crypto)
    refused = client("md").post(f"{API}/ai/note-drafts",
                                json={"transcriptionId": transcript, "templateId": template})
    assert refused.status_code == 409 and _code(refused) == "feature-disabled"
    assert refused.json()["feature"] == "ambient-documentation"
    assert model_server.requests == []                      # nothing was sent
    # The clinic-wide switch alone turns it off too.
    _settings(client, {"clinicEnabled": False, "features": [
        {"feature": "ambient-documentation", "enabled": True}]})
    again = client("md").post(f"{API}/ai/note-drafts",
                              json={"transcriptionId": transcript, "templateId": template})
    assert again.status_code == 409 and _code(again) == "feature-disabled"
    # The transcript stays readable with AI off.
    assert client("md").get(f"{API}/ai/transcriptions/{transcript}").status_code == 200

    # The whole visit, without AI: diagnosis, note, sign, close.
    path = f"{API}/encounters/{encounter}"
    assert client("md").post(f"{path}/diagnoses", json=_icd("I10")).status_code == 201
    note = client("md").post(f"{path}/notes", json={"templateId": template})
    assert note.status_code == 201, note.text
    body = note.json()
    write = client("md").patch(
        f"{API}/notes/{body['id']}",
        json=_sections(body, {"10154-3": "Headache.", "10164-2": "Better with rest.",
                              "29545-1": "Normal exam.", "51847-2": "Tension headache."}),
        headers={"If-Match": note.headers["ETag"], **MERGE})
    assert write.status_code == 200, write.text
    signed = client("md").post(f"{API}/notes/{body['id']}/sign",
                               headers={"If-Match": write.headers["ETag"]})
    assert signed.status_code == 200 and signed.json()["aiAssisted"] is False
    closed = client("md").post(f"{path}/close")
    assert closed.status_code == 200 and closed.json()["status"] == "finished"
    assert _sql(practice, "SELECT count(*) FROM admin.ai_request WHERE encounter_id = :e",
                e=encounter)[0][0] == 1       # the speech request only: no AI call was made


def test_a_failed_model_call_fails_the_operation_and_keeps_its_record(
        client: Client, practice: Practice, model_server: StubModelServer,
        file_store: storage.LocalFileStore, file_crypto: Any) -> None:
    _prompt(practice)
    _ai_on(client)
    encounter, transcript, template = _ready(client, practice, file_store, file_crypto)
    body = {"transcriptionId": transcript, "templateId": template}
    model_server.fail_with = 503
    down = client("md").post(f"{API}/ai/note-drafts", json=body)
    assert down.status_code == 202, down.text
    assert down.json()["status"] == "failed"
    error = down.json()["error"]
    assert (error["status"], error["code"]) == (503, "service-unavailable")
    assert "ai-unavailable" in error["detail"]
    model_server.fail_with = None
    model_server.reply = "This is not JSON."
    garbled = client("md").post(f"{API}/ai/note-drafts", json=body)
    assert garbled.json()["status"] == "failed"
    assert "ai-output-rejected" in garbled.json()["error"]["detail"]
    assert _sql(practice, "SELECT status FROM admin.ai_request WHERE encounter_id = :e AND "
                "prompt_template_id IS NOT NULL ORDER BY created_at",
                e=encounter) == [("failed",), ("failed",)]
    assert _sql(practice, "SELECT count(*) FROM clinical.composition WHERE encounter_id = :e",
                e=encounter)[0][0] == 0
    # Nothing moved: the visit is still arrived, ready for a manual note.
    assert client("md").get(f"{API}/encounters/{encounter}").json()["status"] == "arrived"


def test_note_draft_permissions_validation_and_charts(
        client: Client, practice: Practice, users: dict[str, CurrentUser],
        model_server: StubModelServer, file_store: storage.LocalFileStore,
        file_crypto: Any) -> None:
    model_server.reply = _stub_reply(_visit())
    _prompt(practice)
    _ai_on(client)
    encounter, transcript, template = _ready(client, practice, file_store, file_crypto)
    body = {"transcriptionId": transcript, "templateId": template}
    drafts = f"{API}/ai/note-drafts"
    # Permission: the front desk and the admin have no note-drafts:create.
    for user in ("fd", "adm", "bil"):
        denied = client(user).post(drafts, json=body)
        assert denied.status_code == 403 and _code(denied) == "permission-denied", user
    # Validation: a missing field, an unknown field, a bad ID.
    assert client("md").post(drafts, json={"transcriptionId": transcript}).status_code == 422
    assert client("md").post(drafts, json={**body, "extra": 1}).status_code == 422
    assert client("md").post(drafts, json={**body, "templateId": "x"}).status_code == 422
    # An unknown transcript is 404; an unknown or inactive template, 422 invalid-reference.
    missing = client("md").post(drafts, json={**body, "transcriptionId": str(uuid.uuid4())})
    assert missing.status_code == 404
    unknown = client("md").post(drafts, json={**body, "templateId": str(uuid.uuid4())})
    assert unknown.status_code == 422 and unknown.json()["errors"][0]["pointer"] == "/templateId"
    # Another clinic finds nothing: with its AI off it is refused before any read; with it on,
    # the transcript is simply not found.
    off_b = client("md-b").post(drafts, json=body)
    assert off_b.status_code == 409 and _code(off_b) == "feature-disabled"
    _sql(practice, "INSERT INTO admin.ai_feature_setting (id, tenant_id, feature, is_enabled) "
         "VALUES (gen_random_uuid(), :t, 'ambient-documentation', true)", t=practice.clinic_b)
    assert client("md-b").post(drafts, json=body).status_code == 404
    assert client("md-b").get(f"{API}/ai/transcriptions/{transcript}").status_code == 404
    # getTranscription: permission and validation.
    assert client("fd").get(f"{API}/ai/transcriptions/{transcript}").status_code == 403
    assert client("md").get(f"{API}/ai/transcriptions/not-an-id").status_code == 422
    # A finished visit takes no draft.
    _sql(practice, "UPDATE clinical.encounter SET status = 'finished', period_start = coalesce("
         "period_start, now() - interval '1 hour'), period_end = now() "
         "WHERE id = :e", e=encounter)
    closed = client("md").post(drafts, json=body)
    assert closed.status_code == 409 and closed.json()["currentState"] == "finished"
    assert model_server.requests == []



def test_a_restricted_chart_needs_break_glass(
        client: Client, practice: Practice, users: dict[str, CurrentUser],
        model_server: StubModelServer, file_store: storage.LocalFileStore,
        file_crypto: Any) -> None:
    """D37, for the draft and the transcript alike; every refusal is audited."""
    model_server.reply = _stub_reply(_visit())
    _prompt(practice)
    _ai_on(client)
    patient = practice.patients["restricted"]
    _grant(practice, users["fd"], patient)          # the front desk records the consent
    _, transcript, template = _ready(client, practice, file_store, file_crypto,
                                     patient="restricted")
    body = {"transcriptionId": transcript, "templateId": template}
    for refused in (client("md").post(f"{API}/ai/note-drafts", json=body),
                    client("md").get(f"{API}/ai/transcriptions/{transcript}")):
        assert refused.status_code == 403 and _code(refused) == "break-glass-required"
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE patient_id = :p AND "
                "action = 'access-denied' AND actor_user_id = :u", p=patient,
                u=users["md"].id)[0][0] >= 2
    assert model_server.requests == []
    _grant(practice, users["md"], patient)
    granted = client("md").post(f"{API}/ai/note-drafts", json=body)
    assert granted.status_code == 202 and granted.json()["status"] == "succeeded"


def test_ai_settings_read_replace_and_their_guards(client: Client, practice: Practice) -> None:
    path = f"{API}/ai-settings"
    first = client("adm").get(path)
    assert first.status_code == 200
    assert first.json() == {"clinicEnabled": True, "features": [
        {"feature": "ambient-documentation", "enabled": False},
        {"feature": "chart-summary", "enabled": False}]}       # never set: off, no reason
    tag = first.headers["ETag"]
    # Permission: clinicians neither read nor change the switches.
    assert client("md").get(path).status_code == 403
    assert client("md").put(path, json={"clinicEnabled": True},
                            headers={"If-Match": tag}).status_code == 403
    # If-Match: required, and must be current.
    body = {"clinicEnabled": True, "features": [
        {"feature": "chart-summary", "enabled": False,
         "reason": "Waiting for the clinical advisors' review."}]}
    assert client("adm").put(path, json=body).status_code == 428
    stale = client("adm").put(path, json=body, headers={"If-Match": '"stale"'})
    assert stale.status_code == 412 and stale.headers["ETag"] == tag
    # Validation: off needs a reason, on takes none, a feature once, known features only.
    bads: list[dict[str, Any]] = [
        {"clinicEnabled": True, "features": [{"feature": "chart-summary", "enabled": False}]},
        {"clinicEnabled": True, "features": [
            {"feature": "chart-summary", "enabled": True, "reason": "x"}]},
        {"clinicEnabled": True, "features": [{"feature": "ai-03", "enabled": True}]},
        {"features": []}]
    for bad in bads:
        refused = client("adm").put(path, json=bad, headers={"If-Match": tag})
        assert refused.status_code == 422 and _code(refused) == "validation-failed", bad
    twice = client("adm").put(path, json={"clinicEnabled": True, "features": [
        {"feature": "chart-summary", "enabled": True},
        {"feature": "chart-summary", "enabled": True}]}, headers={"If-Match": tag})
    assert twice.status_code == 422 and _code(twice) == "business-rule-violation"
    # Saved, with a new ETag; features left out keep their setting.
    saved = client("adm").put(path, json=body, headers={"If-Match": tag})
    assert saved.status_code == 200, saved.text
    assert saved.headers["ETag"] != tag
    summary = saved.json()["features"][1]
    assert (summary["enabled"], summary["reason"]) == (
        False, "Waiting for the clinical advisors' review.")
    on = client("adm").put(path, json={"clinicEnabled": False, "features": [
        {"feature": "ambient-documentation", "enabled": True}]},
        headers={"If-Match": saved.headers["ETag"]})
    assert on.status_code == 200
    assert on.json()["clinicEnabled"] is False
    assert [(f["feature"], f["enabled"]) for f in on.json()["features"]] == [
        ("ambient-documentation", True), ("chart-summary", False)]
    assert client("adm").get(path).headers["ETag"] == on.headers["ETag"]
    # The old ETag no longer matches: a second admin tab gets 412.
    assert client("adm").put(path, json=body,
                             headers={"If-Match": tag}).status_code == 412
    # Audited as admin, without a patient.
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE category = 'admin' AND "
                "patient_id IS NULL AND tenant_id = :t", t=practice.clinic)[0][0] >= 3
