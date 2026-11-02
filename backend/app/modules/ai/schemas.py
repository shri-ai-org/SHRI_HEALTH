"""Data the AI gateway takes and returns (service layer; no routes until the AI contract,
batch 7, lands). Plain dataclasses: the Pydantic request and response models come with the
contract."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

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
PIPELINE_VERSION = "gateway/1"


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
class NoteDraftRequest:
    """AI-01: draft a note on an encounter from its visit transcript.

    ``transcript`` is the reviewed transcript text; it goes to the model and nowhere else (never
    a log, never a table: ``ai_request`` keeps its SHA-256 only). ``patient_context`` is the
    minimum the note needs from the chart (age and sex, e.g. "41-year-old female")."""
    encounter_id: UUID
    patient_id: UUID
    transcript: str
    sections: tuple[TemplateSection, ...]
    note_type_loinc: str
    title: str
    template_id: UUID | None = None
    patient_context: str | None = None
    sources: tuple[SourceRef, ...] = ()


@dataclass(frozen=True)
class DraftSectionIn:
    code: str
    title: str
    text: str


@dataclass(frozen=True)
class AIDraftIn:
    """What the gateway hands the encounters module: an unsigned draft whose non-empty
    sections came from ``suggestion_id``."""
    encounter_id: UUID
    note_type_loinc: str
    title: str
    sections: tuple[DraftSectionIn, ...]
    suggestion_id: UUID
    template_id: UUID | None = None


@dataclass(frozen=True)
class DraftWritten:
    note_id: UUID
    version: int


@dataclass(frozen=True)
class PromptRef:
    id: UUID
    code: str
    version: int
    feature: AIFeature
    template: str
    output_schema: dict[str, Any] | None


@dataclass(frozen=True)
class DraftProvenance:
    """Where an AI draft came from: the model, the prompt version, when, and from what."""
    request_id: UUID
    suggestion_id: UUID
    model: str
    prompt_template_id: UUID
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
