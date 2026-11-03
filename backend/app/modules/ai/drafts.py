"""The rules behind AI-01's routes (contracts/openapi/modules/ai.yaml): createNoteDraft,
decideAiSuggestion and getTranscription.

**createNoteDraft** (inventory #110). In order, synchronously:

1. ``409 feature-disabled`` while AI or ``ambient-documentation`` is off for the clinic;
2. ``404`` for a transcription the clinic can't see;
3. ``422 business-rule-violation`` (``/templateId`` ``invalid-reference``) for a template that
   is unknown, inactive or another user's personal one;
4. the encounter's checks (encounters/ai_drafts.py ``ready``): ``404`` (facility), ``403``
   (restricted chart, D37; not a note writer), ``409 invalid-state-transition``.

Then the operation (``ai.note-draft``, core's ``long_running``) and the gateway's draft run in
the request, as the file scan does (files/operations.py): core has no job runner for a module
yet. The ``202`` carries the finished operation: ``succeeded`` with result ``{type: note, id}``,
or ``failed`` with a Problem when the model is unavailable or its output was unusable. Core's
catalogue has no ``ai-unavailable`` or ``ai-output-rejected`` code yet, so the Problem is
``503 service-unavailable`` with a detail saying which; the failed ``ai_request`` record commits
with it. One commit, with the audit row (x-audit ``ai``, patient ``result``).

**decideAiSuggestion** (#113): one decision, once, by the note's author while the note is a
draft (a chart summary: by its requester, accepted or rejected). The call never changes the
note: ``accepted`` needs the section's text to still be the AI text, ``edited`` needs it changed
(the text at this moment is recorded as the edited content), ``rejected`` needs a reason and the
AI text gone from the section. Not gated by the AI switches.

**getTranscription** (#109): the transcript's segments, for a user who may read the encounter's
chart (D37). Still readable with AI off.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import (
    Conflict,
    Forbidden,
    NotFound,
    ValidationFailed,
    field_error,
)
from app.core.long_running import Operation, create_operation, finish_operation, problem_body
from app.db.models.enums import AIDecision, AIFeature
from app.modules.encounters.ai_drafts import SectionForDecision
from app.modules.encounters.repository import EncounterHead

from .repository import AIRepository
from .schemas import (
    NOTE_SECTION,
    TRANSCRIPTION,
    AiGeneratedBy,
    AiSuggestion,
    AiSuggestionDecision,
    NoteDraftCreate,
    NoteDraftRequest,
    SourceRef,
    TemplateSection,
    Transcription,
    TranscriptSegment,
)
from .service import Gateway, ModelUnavailable, NoteDrafts, OutputRejected, ensure_enabled
from .transcripts import Transcripts, transcript_text

NOTE_DRAFT_KIND = "ai.note-draft"
ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[object]]
NamePatient = Callable[[UUID], None]


@dataclass(frozen=True)
class TemplateView:
    """A note template as a draft uses it (practice setup's NoteTemplate)."""
    id: UUID
    name: str
    note_type_loinc: str
    active: bool
    owner_user_id: UUID | None
    sections: tuple[TemplateSection, ...]


Template = Callable[[AsyncSession, UUID], Awaitable[TemplateView | None]]


class Drafts(NoteDrafts, Protocol):
    """The encounters side (encounters/ai_drafts.py ``EncounterNoteDrafts``)."""

    async def ready(self, db: AsyncSession, check: ChartCheck, user: CurrentUser,
                    encounter_id: UUID, note_type_loinc: str) -> EncounterHead: ...

    async def section_for_decision(self, db: AsyncSession, check: ChartCheck,
                                   user: CurrentUser, section_id: UUID
                                   ) -> SectionForDecision: ...


class Encounters(Protocol):
    """Reading an encounter as the user may (encounters/service.py ``readable``)."""

    async def __call__(self, db: AsyncSession, check: ChartCheck, user: CurrentUser,
                       encounter_id: UUID) -> EncounterHead: ...


def _business_rule(pointer: str, code: str) -> ValidationFailed:
    return ValidationFailed(code="business-rule-violation",
                            errors=[field_error("body", pointer, code)])


# ------------------------------------------------------------------------------ note drafts
async def create_note_draft(db: AsyncSession, gateway: Gateway, drafts: Drafts,
                            transcripts: Transcripts, check: ChartCheck, template_of: Template,
                            user: CurrentUser, body: NoteDraftCreate, name_patient: NamePatient
                            ) -> Operation:
    await ensure_enabled(db, gateway.repo, AIFeature.AMBIENT_DOCUMENTATION)
    head = await transcripts.head(db, body.transcription_id)
    if head is None:
        raise NotFound()
    template = await template_of(db, body.template_id)
    if template is None or not template.active or not template.sections or (
            template.owner_user_id is not None and template.owner_user_id != user.id):
        raise _business_rule("/templateId", "invalid-reference")
    encounter = await drafts.ready(db, check, user, head.encounter_id,
                                   template.note_type_loinc)
    segments = await transcripts.segments(db, head)
    request = NoteDraftRequest(
        encounter_id=encounter.id, patient_id=encounter.patient_id,
        transcript=transcript_text(segments), sections=template.sections,
        note_type_loinc=template.note_type_loinc, title=template.name, template_id=template.id,
        patient_context=await gateway.repo.patient_context(db, encounter.patient_id),
        sources=(SourceRef(TRANSCRIPTION, head.id),), transcription_id=head.id,
        segments=segments)
    operation = await create_operation(db, NOTE_DRAFT_KIND)
    try:
        result = await gateway.draft_note(db, request)
    except ModelUnavailable:
        done = await finish_operation(db, operation.id, "failed", error=problem_body(
            "service-unavailable", "The AI model is unavailable (ai-unavailable)"))
    except OutputRejected:
        done = await finish_operation(db, operation.id, "failed", error=problem_body(
            "service-unavailable", "The AI output failed validation (ai-output-rejected)"))
    else:
        done = await finish_operation(db, operation.id, "succeeded",
                                      result=("note", result.note.note_id))
    name_patient(encounter.patient_id)
    await db.commit()
    return done


# -------------------------------------------------------------------------------- decisions
_SPACE = re.compile(r"\s+")


def _norm(value: str) -> str:
    return _SPACE.sub(" ", value).strip()


def _decision_body(body: AiSuggestionDecision) -> None:
    if body.decision == "rejected" and body.reason is None:
        raise ValidationFailed(errors=[field_error("body", "/reason", "required")])
    if body.decision != "rejected" and body.reason is not None:
        raise ValidationFailed(errors=[field_error("body", "/reason", "not-allowed-value")])


def _section_rule(decision: str, ai_text: str, current: str) -> None:
    """The decision matches the section's text (decideAiSuggestion's 422s)."""
    ai, now = _norm(ai_text), _norm(current)
    ok = {"accepted": now == ai, "edited": now != ai,
          "rejected": not ai or ai not in now}[decision]
    if not ok:
        raise _business_rule("/decision", "not-allowed-value")


async def decide(db: AsyncSession, repo: AIRepository, drafts: Drafts, check: ChartCheck,
                 user: CurrentUser, suggestion_id: UUID, body: AiSuggestionDecision,
                 name_patient: NamePatient) -> AiSuggestion:
    _decision_body(body)
    found = await repo.suggestion(db, suggestion_id)
    if found is None or found.patient_id is None:
        raise NotFound()
    edited: dict[str, Any] | None = None
    if found.target_resource_type == NOTE_SECTION:
        if found.target_id is None:
            raise NotFound()
        section = await drafts.section_for_decision(db, check, user, found.target_id)
    else:   # a chart summary (AI-02): its requester decides, accepted or rejected
        await check(db, user, found.patient_id)
        if found.requested_by != user.id:
            raise Forbidden("Only the user who asked for the summary decides it",
                            code="permission-denied")
        if body.decision == "edited":
            raise _business_rule("/decision", "not-allowed-value")
        section = None
    locked = await repo.suggestion(db, suggestion_id, lock=True)
    if locked is None:
        raise NotFound()
    if locked.decision != AIDecision.PENDING.value:
        raise Conflict(code="invalid-state-transition", currentState=locked.decision)
    if section is not None:
        _section_rule(body.decision, str(locked.content.get("text", "")), section.text)
        if body.decision == "edited":
            edited = {"code": section.code, "text": section.text}
    await repo.decide(db, suggestion_id, AIDecision(body.decision), edited_content=edited,
                      rejection_reason=body.reason)
    name_patient(found.patient_id)
    await db.commit()
    return (await repo.suggestion_views(db, [suggestion_id]))[suggestion_id]


# ---------------------------------------------------------------------------- transcriptions
async def get_transcription(db: AsyncSession, transcripts: Transcripts, readable: Encounters,
                            check: ChartCheck, user: CurrentUser, transcription_id: UUID
                            ) -> Transcription:
    head = await transcripts.head(db, transcription_id)
    if head is None:
        raise NotFound()
    await readable(db, check, user, head.encounter_id)
    segments = await transcripts.segments(db, head)
    return Transcription(
        id=head.id, audio_recording_id=head.audio_recording_id, encounter_id=head.encounter_id,
        patient_id=head.patient_id, language=head.language,
        segments=[TranscriptSegment(sequence=s.sequence, start_ms=s.start_ms, end_ms=s.end_ms,
                                    speaker=s.speaker, text=s.text, confidence=s.confidence)
                  for s in segments],
        generated_by=AiGeneratedBy(model_name=head.model_name, model_version=head.model_version,
                                   pipeline_version=head.pipeline_version),
        created_at=head.created_at)
