"""The AI gateway with in-memory fakes: the off switch, drafts, output pruning, failures,
logging, and that the gateway has no way to sign. Synthetic data only."""

from __future__ import annotations

import inspect
import json
import logging
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, ServiceUnavailable
from app.db.models.enums import AIFeature, AIRequestStatus
from app.modules.ai import service
from app.modules.ai.model_client import ModelError
from app.modules.ai.schemas import NOTE_DRAFT_PROMPT, NOTE_DRAFT_SCHEMA, Segment, SourceRef
from app.modules.ai.service import (
    FEATURES,
    Gateway,
    ModelUnavailable,
    NoteDrafts,
    OutputRejected,
)

from .fakes import (
    CHIEF,
    GOOD_REPLY,
    HISTORY,
    TRANSCRIPT,
    FakeAIRepository,
    FakeNoteDrafts,
    StubModelClient,
    request,
)

DB = cast(AsyncSession, object())   # the fakes never touch the session


def _gateway(repo: FakeAIRepository | None = None, model: StubModelClient | None = None,
             drafts: FakeNoteDrafts | None = None) -> tuple[Gateway, FakeAIRepository,
                                                            StubModelClient, FakeNoteDrafts]:
    repo, model, drafts = repo or FakeAIRepository(), model or StubModelClient(), \
        drafts or FakeNoteDrafts()
    return Gateway(repo=repo, model=model, drafts=drafts), repo, model, drafts


# ================================================================================ off switch
def test_every_public_gateway_call_has_a_feature() -> None:
    public = {name for name, member in inspect.getmembers(Gateway, inspect.iscoroutinefunction)
              if not name.startswith("_")}
    assert public == set(FEATURES)


@pytest.mark.parametrize("call", sorted(FEATURES))
@pytest.mark.parametrize(("clinic", "feature"), [(False, True), (True, False), (False, False)])
async def test_ai_off_refuses_every_call_before_anything_happens(
        call: str, clinic: bool, feature: bool) -> None:
    repo = FakeAIRepository(clinic_on=clinic,
                            features_on={FEATURES[call]} if feature else set())
    gateway, _, model, drafts = _gateway(repo)
    with pytest.raises(Conflict) as refused:
        await getattr(gateway, call)(DB, request())
    assert refused.value.code == "feature-disabled" and refused.value.status == 409
    assert refused.value.extensions == {"feature": FEATURES[call].value}
    assert model.sent == [] and repo.requests == [] and drafts.drafts == {}


async def test_the_switch_is_per_feature() -> None:
    repo = FakeAIRepository(features_on={AIFeature.CHART_SUMMARY})
    gateway, *_ = _gateway(repo)
    with pytest.raises(Conflict):
        await gateway.draft_note(DB, request())
    await repo.set_feature(DB, AIFeature.AMBIENT_DOCUMENTATION, True)
    assert (await gateway.draft_note(DB, request())).note.version == 1


# ===================================================================================== drafts
async def test_a_draft_is_an_unsigned_note_from_a_pending_suggestion() -> None:
    gateway, repo, model, drafts = _gateway()
    req = request()
    result = await gateway.draft_note(DB, req)

    [(note_id, draft)] = drafts.drafts.items()
    assert result.note.note_id == note_id
    assert [(s.code, s.text) for s in draft.sections] == [
        ("10154-3", CHIEF), ("10164-2", HISTORY),
        ("29545-1", "Not examined in the transcript."),
        ("51847-2", "Chronic migraine, improving. Continue topiramate."), ("69730-0", "")]
    assert [s.title for s in draft.sections][1] == "Interval history"
    assert draft.encounter_id == req.encounter_id and draft.note_type_loinc == "11506-3"

    # One pending suggestion per drafted section, each the target of its own section.
    filled = [s for s in GOOD_REPLY["sections"] if s["text"]]
    assert [code for code, _ in draft.suggestions] == [s["code"] for s in filled]
    assert tuple(sid for _, sid in draft.suggestions) == result.provenance.suggestion_ids
    sections = dict(result.note.sections)
    assert repo.targets == {sid: sections[code] for code, sid in draft.suggestions}
    for (code, sid), reply in zip(draft.suggestions, filled, strict=True):
        suggestion = repo.suggestions[sid]
        assert suggestion.target_resource_type == "CompositionSection"
        assert suggestion.content == {"code": code, "title": next(
            s.title for s in req.sections if s.code == code), "text": reply["text"],
            "sourceStatus": "no-source", "sources": [], "unknowns": []}
        assert suggestion.confidence == "medium" and suggestion.unknowns == ()
        assert TRANSCRIPT not in suggestion.rationale

    [rec] = repo.requests
    assert rec.status == AIRequestStatus.COMPLETED and rec.error_message is None
    assert rec.model_name == "stub/qwen3-8b" and rec.latency_ms == 1234
    assert (rec.input_tokens, rec.output_tokens) == (812, 240)
    assert len(rec.input_sha256) == 64 and TRANSCRIPT not in rec.input_sha256
    assert rec.sources[0] == SourceRef("Encounter", req.encounter_id)
    assert rec.sources[1:] == req.sources

    prov = result.provenance
    prompt = repo.prompts[NOTE_DRAFT_PROMPT]
    assert (prov.model, prov.prompt_code, prov.prompt_version, prov.prompt_template_id) == (
        "stub/qwen3-8b", "note-draft", 3, prompt.id)
    assert prov.requested_at is not None and prov.sources == rec.sources


async def test_the_prompt_lists_the_sections_and_sends_the_transcript() -> None:
    gateway, _, model, _ = _gateway()
    await gateway.draft_note(DB, request())
    [[system, user]] = model.sent
    assert "- 10164-2: Interval history (required)" in system["content"]
    assert "- 69730-0: Patient instructions\n" in system["content"] + "\n"
    assert "$sections" not in system["content"]
    assert user["content"] == f"Patient: 41-year-old female.\nTranscript:\n{TRANSCRIPT}"


async def test_anything_outside_the_schema_or_the_template_is_dropped() -> None:
    noisy = {"sections": [
        {"code": "10154-3", "text": CHIEF, "confidence": 0.9},           # extra property
        {"code": "10154-3", "text": "A second chief complaint."},       # duplicate code
        {"code": "11348-0", "text": "Past history the template lacks."},  # not in template
        {"code": "10164-2", "text": 42},                                 # wrong type
        {"code": "bad", "text": "x"},                                    # bad code
        {"code": "51847-2", "text": "  Continue topiramate.  "}],
        "unknowns": ["Blood pressure was not stated.", ""], "diagnosis": "invented"}
    gateway, repo, _, drafts = _gateway(model=StubModelClient([json.dumps(noisy)]))
    result = await gateway.draft_note(DB, request())
    [draft] = drafts.drafts.values()
    assert {s.code: s.text for s in draft.sections if s.text} == {
        "10154-3": CHIEF, "51847-2": "Continue topiramate."}
    assert set(result.dropped) == {"/sections/0/confidence", "/sections/3/text",
                                   "/sections/3", "/sections/4/code", "/sections/4",
                                   "/unknowns/1", "/diagnosis", "/sections/1", "/sections/2"}
    assert result.unknowns == ("Blood pressure was not stated.",)
    assert len(repo.suggestions) == 2                         # one per drafted section
    for suggestion in repo.suggestions.values():
        assert suggestion.unknowns == ("Blood pressure was not stated.",)
        assert suggestion.content["unknowns"] == ["Blood pressure was not stated."]
        assert suggestion.confidence == "low"
        assert "diagnosis" not in suggestion.content


async def test_think_blocks_and_code_fences_are_ignored() -> None:
    wrapped = f"<think>Plan the note.</think>\n```json\n{json.dumps(GOOD_REPLY)}\n```"
    gateway, *_ = _gateway(model=StubModelClient([wrapped]))
    result = await gateway.draft_note(DB, request())
    assert result.dropped == () and result.confidence == "medium"


async def test_a_clinics_own_output_schema_is_used() -> None:
    repo = FakeAIRepository()
    strict = json.loads(json.dumps(NOTE_DRAFT_SCHEMA))
    strict["properties"]["sections"]["items"]["properties"]["text"]["maxLength"] = 50
    await repo.publish_prompt(DB, NOTE_DRAFT_PROMPT, AIFeature.AMBIENT_DOCUMENTATION,
                              "Sections:\n$sections", strict)
    gateway, *_ = _gateway(repo)
    result = await gateway.draft_note(DB, request())
    assert "/sections/1/text" in result.dropped               # HISTORY is longer than 50


# =================================================================================== failures
@pytest.mark.parametrize("content", ["not json", "[]", '{"sections": []}',
                                     '{"sections": [{"code": "99999-9", "text": "x"}]}',
                                     '{"sections": [{"code": "10154-3", "text": "  "}]}'])
async def test_unusable_output_is_rejected_and_recorded(content: str) -> None:
    gateway, repo, _, drafts = _gateway(model=StubModelClient([content]))
    with pytest.raises(OutputRejected) as rejected:
        await gateway.draft_note(DB, request())
    assert isinstance(rejected.value, ServiceUnavailable) and rejected.value.status == 503
    [rec] = repo.requests
    assert rec.status == AIRequestStatus.FAILED and rec.error_message
    assert content not in rec.error_message or content in ("[]",)
    assert repo.suggestions == {} and drafts.drafts == {}


@pytest.mark.parametrize(("kind", "status"), [("timeout", AIRequestStatus.TIMEOUT),
                                              ("failed", AIRequestStatus.FAILED)])
async def test_a_model_failure_is_recorded_without_a_draft(kind: Any,
                                                           status: AIRequestStatus) -> None:
    model = StubModelClient([ModelError(kind, "the model did not answer in time")])
    gateway, repo, _, drafts = _gateway(model=model)
    with pytest.raises(ModelUnavailable) as failed:
        await gateway.draft_note(DB, request())
    assert failed.value.code == "service-unavailable"
    [rec] = repo.requests
    assert rec.status == status and rec.input_tokens is None
    assert repo.suggestions == {} and drafts.drafts == {}


async def test_without_a_published_prompt_the_built_in_default_is_used() -> None:
    """No clinic prompt row: the gateway's own version (prompts.NOTE_DRAFT_V2), recorded with
    no prompt_template row."""
    repo = FakeAIRepository()
    repo.prompts.clear()
    gateway, _, model, _ = _gateway(repo)
    result = await gateway.draft_note(DB, request())
    assert 'leave its text empty ("")' in model.sent[0][0]["content"]
    assert repo.requests[0].prompt_template_id is None
    assert (result.provenance.prompt_code, result.provenance.prompt_version) == (
        NOTE_DRAFT_PROMPT, 3)


# ==================================================================================== logging
async def test_logs_carry_metadata_never_patient_text(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    gateway, *_ = _gateway()
    await gateway.draft_note(DB, request())
    failing, *_ = _gateway(model=StubModelClient(["not json"]))
    with pytest.raises(OutputRejected):
        await failing.draft_note(DB, request())
    lines = [r.getMessage() for r in caplog.records]
    assert any("ai.request" in line and "status=completed" in line for line in lines)
    assert any("status=output-rejected" in line for line in lines)
    forbidden = [TRANSCRIPT, "topiramate", "sumatriptan", CHIEF, HISTORY, "41-year-old",
                 "You draft a clinical note"]
    for record in caplog.records:
        text = record.getMessage() + repr(record.args) + repr(record.__dict__)
        for word in forbidden:
            assert word not in text, word


# ============================================================================ no way to sign
def test_the_gateway_has_no_way_to_sign() -> None:
    """The gateway reaches notes only through NoteDrafts, which can create a draft and
    nothing else; the service never imports the note helpers."""
    members = {n for n in dir(NoteDrafts) if not n.startswith("_")}
    assert members == {"create_ai_draft"}
    assert set(Gateway.__dataclass_fields__) == {"repo", "model", "drafts"}
    source = Path(inspect.getfile(service)).read_text(encoding="utf-8")
    code = "\n".join(line for line in source.splitlines()
                     if not line.lstrip().startswith(("#", '"', "-", "1.", "2.", "3.", "4.")))
    assert "fhir_store" not in code and "sign_note" not in code and ".sign(" not in code


async def test_a_draft_stays_a_draft() -> None:
    gateway, repo, _, drafts = _gateway()
    result = await gateway.draft_note(DB, request())
    assert list(drafts.drafts) == [result.note.note_id] and result.note.version == 1
    assert repo.decisions == {}            # the gateway never records a decision either


# ============================================================================== source links
async def test_each_section_links_the_transcript_segments_it_came_from() -> None:
    transcription = uuid4()
    segments = (
        Segment(1, 0, 4000, "clinician", "How have the headaches been since topiramate?"),
        Segment(2, 4000, 9000, "patient", "Down to five or six headache days a month."),
        Segment(3, 9000, 12000, "patient", "The sumatriptan works in an hour."))
    reply = {"sections": [
        {"code": "10154-3", "text": "Headaches since starting topiramate."},
        {"code": "10164-2", "text": "Headache days down to five or six a month; sumatriptan "
                                    "works within an hour."},
        {"code": "29545-1", "text": "Fundi normal, no papilledema."},
        {"code": "51847-2", "text": "Continue topiramate."}]}
    gateway, repo, _, drafts = _gateway(model=StubModelClient([json.dumps(reply)]))
    await gateway.draft_note(DB, request(transcription_id=transcription, segments=segments))
    [draft] = drafts.drafts.values()
    chief, history, exam, plan = (repo.suggestions[sid] for _, sid in draft.suggestions)
    assert chief.content["sourceStatus"] == plan.content["sourceStatus"] == "sourced"
    assert history.content["sourceStatus"] == "sourced"
    assert [(s["segment"], s["resourceType"], s["resourceId"])
            for s in history.content["sources"]] == [
        (2, "Transcription", str(transcription)), (3, "Transcription", str(transcription))]
    assert "segments 2, 3" in history.rationale and history.confidence == "medium"
    # Nothing in the transcript supports the exam: no-source, low, and the rationale says so.
    assert exam.content["sourceStatus"] == "no-source" and exam.content["sources"] == []
    assert exam.confidence == "low" and "no transcript segment" in exam.rationale


# ========================================================================= dictation (demo)
DICTATION = ("Follow-up of chronic migraine on topiramate. Headache days down to five or six a "
             "month; sumatriptan works in an hour. Continue topiramate.")


async def test_a_dictation_is_sent_as_such_with_the_chart_lines_and_the_schema() -> None:
    chart = "Allergies: Penicillin (high criticality).\nCurrent medications: Topiramate 50 MG."
    gateway, repo, model, drafts = _gateway()
    result = await gateway.draft_note(DB, request(transcript=DICTATION, dictated=True,
                                                  chart=chart))
    user = model.sent[0][1]["content"]
    assert f"Chart (background only):\n{chart}\n" in user
    assert user.endswith(f"Dictation:\n{DICTATION}") and "Transcript:" not in user
    assert model.schemas == [NOTE_DRAFT_SCHEMA]
    [draft] = drafts.drafts.values()
    suggestions = [repo.suggestions[sid] for _, sid in draft.suggestions]
    assert {s.content["sourceStatus"] for s in suggestions} == {"no-source"}
    assert all("clinician's dictation" in s.rationale for s in suggestions)
    assert result.note.note_id in drafts.drafts


async def test_a_section_the_visit_gave_nothing_for_stays_blank() -> None:
    """An older prompt's (or a stray) "Not discussed" is not drafted text: the section stays
    blank with no AI suggestion, and a blank required section lowers the band."""
    reply = {"sections": [{"code": c, "text": t} for c, t in (
        ("10154-3", CHIEF), ("10164-2", HISTORY), ("29545-1", "Not discussed."),
        ("51847-2", "Continue topiramate."), ("69730-0", "Not discussed"))]}
    gateway, repo, _, drafts = _gateway(model=StubModelClient([json.dumps(reply)]))
    result = await gateway.draft_note(DB, request(transcript=DICTATION, dictated=True))
    assert result.confidence == "low"           # a required section was not discussed
    [draft] = drafts.drafts.values()
    texts = {s.code: s.text for s in draft.sections}
    assert texts["69730-0"] == "" and texts["29545-1"] == ""
    assert len(draft.suggestions) == 3          # only the sections the visit gave text for


# =================================================================================== budget
async def test_past_the_monthly_budget_the_model_is_not_called() -> None:
    from app.modules.ai.budget import Usage
    repo = FakeAIRepository(usage=[Usage("claude-sonnet-5-5", 60_000_000, 2_000_000)])
    model = StubModelClient(model="claude-sonnet-5-5")
    gateway, _, _, drafts = _gateway(repo, model)
    with pytest.raises(service.BudgetReached):
        await gateway.draft_note(DB, request())
    assert model.sent == [] and drafts.drafts == {}
    [rec] = repo.requests
    assert rec.status == AIRequestStatus.BLOCKED and rec.error_message is not None
    assert rec.error_message.startswith("budget-reached")


async def test_under_the_budget_and_for_unmetered_models_the_call_goes_ahead() -> None:
    from app.modules.ai.budget import Usage
    under = FakeAIRepository(usage=[Usage("claude-sonnet-5-5", 1_000_000, 100_000)])
    gateway, _, model, _ = _gateway(under, StubModelClient(model="claude-sonnet-5-5"))
    await gateway.draft_note(DB, request())
    assert len(model.sent) == 1
    huge = FakeAIRepository(usage=[Usage("claude-sonnet-5-5", 10**9, 10**9)])
    gateway, _, model, _ = _gateway(huge, StubModelClient(model="stub"))
    await gateway.draft_note(DB, request())       # the stub costs nothing: never blocked
    assert len(model.sent) == 1


async def test_a_declined_request_records_the_tokens_it_used() -> None:
    declined = ModelError("declined", "the model declined the request (general_harms)",
                          prompt_tokens=900, completion_tokens=40, model="claude-sonnet-5-5")
    gateway, repo, _, drafts = _gateway(model=StubModelClient([declined]))
    with pytest.raises(ModelUnavailable):
        await gateway.draft_note(DB, request())
    [rec] = repo.requests
    assert (rec.status, rec.input_tokens, rec.output_tokens, rec.model_name) == (
        AIRequestStatus.FAILED, 900, 40, "claude-sonnet-5-5")
    assert drafts.drafts == {}
