"""Request and response shapes for the patient history API (contracts/openapi/modules/history.yaml).
Field names are the contract's camelCase (aliases); bodies the contract closes forbid unknown
fields. Only the operations built so far are here: the allergies (inventory #94-97, #250).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StringConstraints

from ..encounters.schemas import ClinicianRef, Closed, CodeableConcept, EntrySource, Out

PartialDate = Annotated[str, StringConstraints(
    max_length=10, pattern=r"^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$")]
ClinicalStatus = Literal["active", "inactive", "resolved"]
VerificationStatus = Literal["unconfirmed", "confirmed", "refuted"]
Category = Literal["food", "medication", "environment", "biologic"]
Criticality = Literal["low", "high", "unable-to-assess"]
Note = Annotated[str, StringConstraints(max_length=2000)]


class AllergyReaction(Closed):
    manifestations: Annotated[list[CodeableConcept], Field(max_length=10)]
    severity: Literal["mild", "moderate", "severe"] | None = None
    description: Annotated[str, StringConstraints(max_length=1000)] | None = None
    onset_date: PartialDate | None = None


class AllergyReactionOut(Out):
    manifestations: list[CodeableConcept]
    severity: Literal["mild", "moderate", "severe"] | None = None
    description: str | None = None
    onset_date: str | None = None


class Allergy(Out):
    id: UUID
    patient_id: UUID
    clinical_status: ClinicalStatus | None = None
    verification_status: VerificationStatus | Literal["entered-in-error"]
    encounter_id: UUID | None = None
    code: CodeableConcept
    type: Literal["allergy", "intolerance"] | None = None
    categories: list[Category] | None = None
    criticality: Criticality | None = None
    onset_date: str | None = None
    reactions: list[AllergyReactionOut] | None = None
    note: str | None = None
    entry_source: EntrySource
    recorded_at: datetime
    recorded_by: ClinicianRef | None = None


class AllergyCreate(Closed):
    clinical_status: ClinicalStatus = "active"
    verification_status: VerificationStatus = "confirmed"
    encounter_id: UUID | None = None
    code: CodeableConcept
    type: Literal["allergy", "intolerance"] | None = None
    categories: Annotated[list[Category], Field(max_length=4)] = []
    criticality: Criticality | None = None
    onset_date: PartialDate | None = None
    reactions: Annotated[list[AllergyReaction], Field(max_length=10)] = []
    note: Note | None = None


class AllergyPatch(Closed):
    """JSON Merge Patch; ``model_fields_set`` says which fields were sent. `criticality` and
    `note` may be `null` (cleared); the others may not."""

    clinical_status: ClinicalStatus | None = None
    verification_status: VerificationStatus | None = None
    criticality: Criticality | None = None
    reactions: Annotated[list[AllergyReaction], Field(max_length=10)] | None = None
    note: Note | None = None


class AllergyList(Out):
    items: list[Allergy]
    next_cursor: str | None = None


class EnteredInError(Closed):
    reason: Annotated[str, StringConstraints(min_length=1, max_length=500)]
