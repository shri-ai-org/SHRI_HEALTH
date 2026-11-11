"""Request and response shapes for the patient history API (contracts/openapi/modules/history.yaml).
Field names are the contract's camelCase (aliases); bodies the contract closes forbid unknown
fields. Only the operations built so far are here: the allergies (inventory #94-97, #250) and
the reads of problems, family, social and surgical history (#90, #249, #98, #101, #104).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StringConstraints

from ..encounters.schemas import (
    ClinicianRef,
    Closed,
    CodeableConcept,
    EntrySource,
    Out,
    Quantity,
)

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


# ------------------------------------------------------------------ problems and history (reads)
class Problem(Out):
    id: UUID
    patient_id: UUID
    code: CodeableConcept
    clinical_status: Literal["active", "recurrence", "relapse", "inactive", "remission",
                             "resolved"] | None = None
    verification_status: Literal["unconfirmed", "provisional", "differential", "confirmed",
                                 "refuted", "entered-in-error"]
    onset_date: str | None = None
    abatement_date: str | None = None
    note: str | None = None
    encounter_id: UUID | None = None
    entry_source: EntrySource
    recorded_at: datetime
    recorded_by: ClinicianRef | None = None


class ProblemList(Out):
    items: list[Problem]
    next_cursor: str | None = None


class FamilyCondition(Out):
    code: CodeableConcept
    onset_age: int | None = None
    contributed_to_death: bool | None = None
    note: str | None = None


class FamilyHistory(Out):
    id: UUID
    patient_id: UUID
    status: Literal["completed", "partial", "health-unknown", "entered-in-error"]
    relationship: CodeableConcept
    sex: Literal["male", "female", "other", "unknown"] | None = None
    deceased: bool | None = None
    conditions: list[FamilyCondition] | None = None
    note: str | None = None
    entry_source: EntrySource
    recorded_at: datetime
    recorded_by: ClinicianRef | None = None


class FamilyHistoryList(Out):
    items: list[FamilyHistory]
    next_cursor: str | None = None


class SocialHistoryValue(Out):
    codeable_concept: CodeableConcept | None = None
    quantity: Quantity | None = None
    text: str | None = None


class SocialHistory(Out):
    id: UUID
    patient_id: UUID
    code: CodeableConcept
    value: SocialHistoryValue
    effective_date: str | None = None
    status: Literal["final", "entered-in-error"]
    entry_source: EntrySource
    recorded_at: datetime
    recorded_by: ClinicianRef | None = None


class SocialHistoryList(Out):
    items: list[SocialHistory]
    next_cursor: str | None = None


class SurgicalHistory(Out):
    id: UUID
    patient_id: UUID
    status: Literal["completed", "entered-in-error"]
    code: CodeableConcept
    performed_date: str
    body_site: CodeableConcept | None = None
    note: str | None = None
    entry_source: EntrySource
    recorded_at: datetime
    recorded_by: ClinicianRef | None = None


class SurgicalHistoryList(Out):
    items: list[SurgicalHistory]
    next_cursor: str | None = None
