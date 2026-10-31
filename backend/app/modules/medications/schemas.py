"""Request and response shapes for the medication list and prescriptions, from
contracts/openapi/modules/medications.yaml (D97). Field names are the contract's camelCase
(aliases); request bodies the contract closes (`additionalProperties: false`) forbid unknown
fields, so a typo is a 422, not a silent drop.

Built by Vimal under D97, reviewed by Thulasi as the medications owner.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel


def _text(max_length: int, *, min_length: int = 0) -> StringConstraints:
    return StringConstraints(min_length=min_length, max_length=max_length)


ListStatus = Literal["active", "completed", "stopped"]
PrescriptionStatus = Literal["draft", "active", "cancelled", "completed", "entered-in-error"]
TransmissionStatus = Literal["not-sent", "queued", "sent", "accepted", "rejected", "error"]
DosageText = Annotated[str, _text(500)]
NoteToPharmacy = Annotated[str, _text(210)]
DaysSupply = Annotated[int, Field(ge=1, le=365)]
Refills = Annotated[int, Field(ge=0, le=11)]


class Closed(BaseModel):
    """A request body the contract closes: unknown fields are refused."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Out(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ------------------------------------------------------------------------- shared shapes
class Coding(Closed):
    system: Annotated[str, _text(255)]
    code: Annotated[str, _text(64)]
    display: Annotated[str, _text(500)] | None = None


class CodeableConcept(Closed):
    codings: Annotated[list[Coding], Field(max_length=10)] | None = None
    text: Annotated[str, _text(1000)] | None = None


class Quantity(Closed):
    # At most three fraction digits, as NCPDP and the NewRx carry it (the contract's minimum
    # 0.001 implies it, but it has no multipleOf: reported to Vimal).
    value: Annotated[Decimal, Field(ge=Decimal("0.001"), le=Decimal(100000), decimal_places=3)]
    unit: Annotated[str, _text(32)]


class QuantityOut(Out):
    value: float  # the contract's number
    unit: str


# ------------------------------------------------------------------- the medication list
class MedicationCreate(Closed):
    medication: CodeableConcept
    dosage_text: DosageText | None = None
    status: ListStatus = "active"
    note: Annotated[str, _text(1000)] | None = None


class Medication(Out):
    id: UUID
    patient_id: UUID
    medication: CodeableConcept
    dosage_text: str | None = None
    status: Literal["active", "completed", "stopped", "entered-in-error"]
    source: Literal["prescription", "reported"]
    prescription_id: UUID | None = None
    note: str | None = None
    recorded_at: datetime
    recorded_by: UUID | None = None


class MedicationList(Out):
    items: list[Medication]
    next_cursor: str | None = None


# ------------------------------------------------------------------------- prescriptions
class PrescriptionCreate(Closed):
    patient_id: UUID
    encounter_id: UUID | None = None
    medication: CodeableConcept
    dosage_text: DosageText | None = None
    quantity: Quantity | None = None
    days_supply: DaysSupply | None = None
    refills: Refills | None = None
    substitution_allowed: bool | None = None
    pharmacy_id: UUID | None = None
    note_to_pharmacy: NoteToPharmacy | None = None


class PrescriptionPatch(Closed):
    """Only what is sent changes; ``model_fields_set`` says what was sent, and an explicit
    ``null`` clears an optional field."""

    medication: CodeableConcept | None = None
    dosage_text: DosageText | None = None
    quantity: Quantity | None = None
    days_supply: DaysSupply | None = None
    refills: Refills | None = None
    substitution_allowed: bool | None = None
    pharmacy_id: UUID | None = None
    note_to_pharmacy: NoteToPharmacy | None = None


class PrescriptionEnteredInError(Closed):
    reason: Annotated[str, _text(500, min_length=1)]


class AlertOverride(Closed):
    reason: Annotated[str, _text(500, min_length=3)]


class Override(Out):
    reason: str
    overridden_by: UUID | None = None
    overridden_at: datetime


class SafetyAlert(Out):
    id: UUID
    kind: str  # allergy | duplicate-medication | interaction (later, Q13): x-extensible-enum
    severity: Literal["info", "warning", "high"]
    message: str
    allergy_id: UUID | None = None
    medication_id: UUID | None = None
    override_required: bool
    override: Override | None = None


class Transmission(Out):
    status: TransmissionStatus
    updated_at: datetime | None = None
    message: str | None = None


class Prescription(Out):
    id: UUID
    patient_id: UUID
    encounter_id: UUID | None = None
    status: PrescriptionStatus
    medication: CodeableConcept
    dosage_text: str | None = None
    quantity: QuantityOut | None = None
    days_supply: int | None = None
    refills: int | None = None
    substitution_allowed: bool | None = None
    pharmacy_id: UUID | None = None
    note_to_pharmacy: str | None = None
    prescriber_id: UUID | None = None
    signed_at: datetime | None = None
    transmission: Transmission
    safety_checked_at: datetime | None = None
    alerts: list[SafetyAlert]
    created_at: datetime
    updated_at: datetime


class SafetyCheckResult(Out):
    prescription_id: UUID
    checked_at: datetime
    alerts: list[SafetyAlert]
