"""Request and response shapes for notes (contracts/openapi/modules/encounters.yaml: Note,
NoteSection, NoteAddendum, CosignReturn, NoteCreate, NotePatch, NoteSectionText, AddendumCreate,
NoteList, NoteVersion, NoteVersionSection, NoteVersionList). ``NoteSummary`` and the shared
shapes are in schemas.py."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StringConstraints

from .schemas import ClinicianRef, Closed, CodeableConcept, NoteSummary, Out

NoteStatus = Literal["preliminary", "final", "amended", "entered-in-error"]
CosignStatus = Literal["not-required", "pending", "returned", "cosigned"]


class NoteSection(Out):
    id: UUID
    code: str
    title: str
    sequence: int
    required: bool
    text: str
    entry_source: Literal["clinician", "ai-generated", "imported"]
    ai_suggestion_id: UUID | None = None
    ai_decision: Literal["pending", "accepted", "edited", "rejected"] | None = None


class NoteAddendum(Out):
    id: UUID
    text: str
    author: ClinicianRef
    signed_at: datetime


class CosignReturn(Out):
    comment: str
    returned_at: datetime
    returned_by: ClinicianRef


class Note(Out):
    id: UUID
    encounter_id: UUID
    patient_id: UUID
    note_type: CodeableConcept
    title: str
    status: NoteStatus
    cosign_status: CosignStatus
    cosigner: ClinicianRef | None = None
    template_id: UUID | None = None
    author: ClinicianRef
    ai_assisted: bool
    sections: list[NoteSection]
    addenda: list[NoteAddendum]
    signed_at: datetime | None = None
    signed_by: ClinicianRef | None = None
    cosigned_at: datetime | None = None
    cosigned_by: ClinicianRef | None = None
    cosign_return: CosignReturn | None = None
    created_at: datetime
    updated_at: datetime


class NoteCreate(Closed):
    template_id: UUID | None = None
    note_type: CodeableConcept | None = None
    title: Annotated[str, StringConstraints(max_length=300)] | None = None


class NoteSectionText(Closed):
    id: UUID
    text: Annotated[str, StringConstraints(max_length=50000)]


class NotePatch(Closed):
    title: Annotated[str, StringConstraints(max_length=300)] | None = None
    sections: Annotated[list[NoteSectionText], Field(max_length=30)] | None = None


class AddendumCreate(Closed):
    text: Annotated[str, StringConstraints(min_length=1, max_length=20000)]


class NoteList(Out):
    items: list[NoteSummary]
    next_cursor: str | None = None


class NoteVersionSection(Out):
    code: str
    title: str
    text: str


class NoteVersion(Out):
    version_id: int
    recorded_at: datetime
    recorded_by: ClinicianRef | None = None
    status: NoteStatus
    cosign_status: CosignStatus
    title: str
    sections: list[NoteVersionSection]


class NoteVersionList(Out):
    items: list[NoteVersion]
    next_cursor: str | None = None
