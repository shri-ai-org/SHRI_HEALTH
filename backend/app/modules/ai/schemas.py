"""Data the AI module takes and returns: the gateway's plain dataclasses (service layer), then
the contract's request and response bodies (contracts/openapi/modules/ai.yaml, batch 7):
NoteDraftCreate, AiSuggestion, AiSuggestionDecision, Transcription, AiSettings and
AiSettingsUpdate."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from app.db.models.enums import AIFeature

#: The model's output for a note draft (AI-01). The same document as
#: ai/eval/data/note_draft.schema.json, which the evaluation harness scores against; a test
#: keeps the two equal. Anything outside it is dropped (output.prune).
NOTE_DRAFT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "shri-health:ai:note-draft/1",
    "title": "AI-01 note draft (model output)",
    "description": (
        "What the model must return for a note draft: the template's sections by LOINC "
        "section code, and what it could not determine (kept unknown, never invented; FRS "
        "§3.4). The gateway's NOTE_DRAFT_SCHEMA (backend/app/modules/ai/schemas.py) is the same "
        "document; a backend test compares them."),
    "type": "object",
    "additionalProperties": False,
    "required": ["sections"],
    "properties": {
        "sections": {
            "type": "array",
            "maxItems": 20,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["code", "text"],
                "properties": {
                    "code": {"type": "string", "pattern": "^[0-9]{1,7}-[0-9]$"},
                    "text": {"type": "string", "maxLength": 20000},
                },
            },
        },
        "unknowns": {
            "type": "array",
            "maxItems": 20,
            "items": {"type": "string", "minLength": 1, "maxLength": 500},
        },
    },
}

#: The prompt code a clinic's (or the platform's) active ``prompt_template`` uses for AI-01.
NOTE_DRAFT_PROMPT = "note-draft"
#: Version tag of the gateway pipeline, in ``ai_request.pipeline_version``.
PIPELINE_VERSION = "gateway/2"
#: ``ai_suggestion.target_resource_type`` of one AI-drafted note section (contract
#: ``targetType: note-section``; ``target_id`` is the section's ID).
NOTE_SECTION = "CompositionSection"
#: The source a draft section links to: a segment of the visit transcript (AiSourceLink).
TRANSCRIPTION = "Transcription"


@dataclass(frozen=True)
class TemplateSection:
    """One section of the note template the draft fills (LOINC section code)."""
    code: str
    title: str
    required: bool = False


@dataclass(frozen=True)
class SourceRef:
    """A chart record the request read (ai_request_input_ref): FHIR type, ID, version."""
    resource_type: str
    resource_id: UUID
    version: int | None = None


@dataclass(frozen=True)
class Segment:
    """One stretch of a transcript (contract TranscriptSegment): what source links point at."""
    sequence: int
    start_ms: int
    end_ms: int
    speaker: str
    text: str
    confidence: str | None = None


@dataclass(frozen=True)
class NoteDraftRequest:
    """AI-01: draft a note on an encounter from its visit transcript.

    ``transcript`` is the visit text sent to the model: the transcript, or the clinician's
    dictation (``dictated``); it goes nowhere else (never a log, never a table: ``ai_request``
    keeps its SHA-256 only). ``segments`` are a transcript's timed segments, which each drafted
    section's source links point at (the transcription ``transcription_id``); a dictation has
    none. ``patient_context`` is the minimum the note needs from the chart (age and sex, e.g.
    "41-year-old female"); ``chart`` the allergy, medication and diagnosis lines the clinician
    may read (chart_context.py)."""
    encounter_id: UUID
    patient_id: UUID
    transcript: str
    sections: tuple[TemplateSection, ...]
    note_type_loinc: str
    title: str
    template_id: UUID | None = None
    patient_context: str | None = None
    sources: tuple[SourceRef, ...] = ()
    transcription_id: UUID | None = None
    segments: tuple[Segment, ...] = ()
    dictated: bool = False
    chart: str | None = None


@dataclass(frozen=True)
class DraftSectionIn:
    code: str
    title: str
    text: str


@dataclass(frozen=True)
class AIDraftIn:
    """What the gateway hands the encounters module: an unsigned draft whose non-empty
    sections each came from their own suggestion (``suggestions``: section code, suggestion)."""
    encounter_id: UUID
    note_type_loinc: str
    title: str
    sections: tuple[DraftSectionIn, ...]
    suggestions: tuple[tuple[str, UUID], ...]
    template_id: UUID | None = None


@dataclass(frozen=True)
class DraftWritten:
    note_id: UUID
    version: int
    sections: tuple[tuple[str, UUID], ...] = ()   # section code, section ID


@dataclass(frozen=True)
class PromptRef:
    id: UUID | None     # None: the built-in default (prompts.DEFAULT), no prompt_template row
    code: str
    version: int
    feature: AIFeature
    template: str
    output_schema: dict[str, Any] | None


@dataclass(frozen=True)
class DraftProvenance:
    """Where an AI draft came from: the model, the prompt version, when, and from what."""
    request_id: UUID
    suggestion_ids: tuple[UUID, ...]
    model: str
    prompt_template_id: UUID | None
    prompt_code: str
    prompt_version: int
    requested_at: datetime
    sources: tuple[SourceRef, ...]


@dataclass(frozen=True)
class DraftResult:
    note: DraftWritten
    provenance: DraftProvenance
    confidence: str
    unknowns: tuple[str, ...]
    dropped: tuple[str, ...] = field(default=())   # JSON pointers of model output dropped


# ===================================================================== contract bodies (Pydantic)
class Closed(BaseModel):
    """A request body the contract closes: unknown fields are refused."""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Out(BaseModel):
    """A response body."""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


Decision = Literal["pending", "accepted", "edited", "rejected"]
Confidence = Literal["low", "medium", "high"]
SourceStatus = Literal["sourced", "no-source", "conflicting"]
FeatureName = Literal["ambient-documentation", "chart-summary"]


class NoteDraftCreate(Closed):
    transcription_id: UUID | None = None
    encounter_id: UUID | None = None
    dictation: Annotated[str, StringConstraints(min_length=1, max_length=20000)] | None = None
    template_id: UUID


class AiSuggestionDecision(Closed):
    decision: Literal["accepted", "edited", "rejected"]
    reason: Annotated[str, StringConstraints(min_length=1, max_length=500)] | None = None


class ClinicianRef(Out):
    id: UUID
    display_name: str


class AiSourceLink(Out):
    resource_type: str
    resource_id: UUID
    segment: int | None = None
    label: str | None = None
    excerpt: str | None = None


class AiGeneratedBy(Out):
    model_name: str
    model_version: str | None = None
    prompt_code: str | None = None
    prompt_version: int | None = None
    pipeline_version: str


class AiSuggestion(Out):
    id: UUID
    feature: str
    target_type: Literal["note-section", "chart-summary"]
    target_id: UUID
    note_id: UUID | None = None
    patient_id: UUID
    encounter_id: UUID | None = None
    confidence: Confidence
    rationale: str
    suggested_text: str | None = None
    source_status: SourceStatus | None = None
    sources: list[AiSourceLink] | None = None
    unknowns: list[str] = Field(default_factory=list)
    decision: Decision
    decided_at: datetime | None = None
    decided_by: ClinicianRef | None = None
    rejection_reason: str | None = None
    generated_by: AiGeneratedBy
    created_at: datetime


class TranscriptSegment(Out):
    sequence: int
    start_ms: int
    end_ms: int
    speaker: Literal["clinician", "patient", "other", "unknown"]
    text: str
    confidence: Confidence | None = None


class Transcription(Out):
    id: UUID
    audio_recording_id: UUID
    encounter_id: UUID
    patient_id: UUID
    language: str
    segments: list[TranscriptSegment]
    generated_by: AiGeneratedBy
    created_at: datetime


class AiFeatureSetting(Out):
    feature: str
    enabled: bool
    reason: str | None = None
    updated_at: datetime | None = None


class AiSettings(Out):
    clinic_enabled: bool
    features: list[AiFeatureSetting]


class AiFeatureSettingUpdate(Closed):
    feature: FeatureName
    enabled: bool
    reason: Annotated[str, StringConstraints(min_length=1, max_length=500)] | None = None


class AiSettingsUpdate(Closed):
    clinic_enabled: bool
    features: Annotated[list[AiFeatureSettingUpdate], Field(max_length=20)] | None = None


# ---------------------------------------------------------------------- chart summary (AI-02)
Topic = Literal["encounters", "diagnoses", "medications", "allergies", "results",
                "outstanding-issues"]


class ChartSummaryCreate(Closed):
    patient_id: UUID
    encounter_id: UUID | None = None


class ChartSummaryStatement(Out):
    sequence: int
    text: str
    confidence: Confidence
    source_status: SourceStatus
    sources: list[AiSourceLink]


class ChartSummarySection(Out):
    topic: Topic
    statements: list[ChartSummaryStatement]


class ChartSummaryGap(Out):
    topic: Topic
    description: str


class ChartSummary(Out):
    id: UUID
    patient_id: UUID
    encounter_id: UUID | None = None
    sections: list[ChartSummarySection]
    missing: list[ChartSummaryGap]
    suggestion: AiSuggestion
    created_at: datetime


# ------------------------------------------------------------------- chart questions (#306)
PageType = Literal["consultation", "prescribing", "check-out", "chart", "front-desk"]


class ChartQuestionCreate(Closed):
    question: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    page_type: PageType
    patient_id: UUID
    encounter_id: UUID | None = None


class ChartAnswerStatement(Out):
    sequence: int
    text: str
    sources: list[AiSourceLink]


class ChartAnswer(Out):
    id: UUID
    patient_id: UUID
    encounter_id: UUID | None = None
    page_type: PageType
    question: str
    statements: list[ChartAnswerStatement]
    insufficient_evidence: bool
    ai_generated: Literal[True] = True
    generated_by: AiGeneratedBy
    created_at: datetime


class SuggestedQuestionList(Out):
    page_type: PageType
    questions: list[str]
