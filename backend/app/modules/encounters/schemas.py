"""Request and response shapes for the encounter workspace and vitals
(contracts/openapi/modules/encounters.yaml). Field names are the contract's camelCase (aliases);
bodies the contract closes (`additionalProperties: false`) forbid unknown fields. Only the
operations built so far are here: getEncounter, updateEncounter, recordVitals, listPatientVitals,
the follow-up request (set, withdraw, decline; D98) and the after-visit summary's hand-off.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel


def _text(max_length: int, *, min_length: int = 0) -> object:
    return StringConstraints(min_length=min_length, max_length=max_length)


EncounterStatus = Literal["arrived", "triaged", "in-progress", "finished", "cancelled",
                          "entered-in-error"]
VitalType = Literal["blood-pressure", "heart-rate", "respiratory-rate", "body-temperature",
                    "body-height", "body-weight", "bmi", "oxygen-saturation",
                    "head-circumference"]
ParticipantRole = Literal["rendering", "supervising", "attending", "referring"]
EntrySource = Literal["clinician", "imported", "patient-reported", "ai-generated", "device",
                      "interface"]


class Closed(BaseModel):
    """A request body the contract closes: unknown fields are refused."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Out(BaseModel):
    """A response body."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ------------------------------------------------------------------------- shared components
class Coding(Closed):
    system: Annotated[str, _text(255)]
    code: Annotated[str, _text(64)]
    display: Annotated[str, _text(500)] | None = None


class CodeableConcept(Closed):
    codings: Annotated[list[Coding], Field(max_length=10)] = []
    text: Annotated[str, _text(1000)] | None = None


class Quantity(Closed):
    value: Annotated[float, Field(ge=-1_000_000, le=1_000_000)]
    unit: Annotated[str, _text(32)]


class ClinicianRef(Out):
    id: UUID
    display_name: str


# ------------------------------------------------------------------------------------ vitals
class BloodPressure(Closed):
    systolic: Quantity
    diastolic: Quantity


class Vital(Out):
    id: UUID
    patient_id: UUID
    encounter_id: UUID | None = None
    type: VitalType
    value: Quantity | None = None
    blood_pressure: BloodPressure | None = None
    effective_at: datetime
    status: Literal["final", "entered-in-error"]
    interpretation: Literal["N", "L", "H", "LL", "HH"] | None = None
    entry_source: EntrySource
    recorded_at: datetime
    recorded_by: ClinicianRef | None = None


class VitalEntry(Closed):
    type: VitalType
    value: Quantity | None = None
    blood_pressure: BloodPressure | None = None


class VitalsCreate(Closed):
    effective_at: AwareDatetime | None = None
    entries: Annotated[list[VitalEntry], Field(max_length=12)]


class VitalsRecorded(Out):
    vitals: list[Vital]


class VitalList(Out):
    items: list[Vital]
    next_cursor: str | None = None


# -------------------------------------------------------------------------------- encounter
class EncounterParticipant(Closed):
    role: ParticipantRole
    practitioner_id: UUID
    display_name: Annotated[str, _text(200)] | None = None  # read-only: ignored on input


class EncounterDiagnosis(Out):
    id: UUID
    encounter_id: UUID
    rank: int | None = None
    code: Coding
    verification_status: Literal["confirmed", "provisional", "differential", "entered-in-error"]
    onset_date: str | None = None
    ai_suggestion_id: UUID | None = None
    entry_source: EntrySource
    recorded_at: datetime
    recorded_by: ClinicianRef | None = None


class NoteSummary(Out):
    id: UUID
    note_type: CodeableConcept
    title: str
    status: Literal["preliminary", "final", "amended", "entered-in-error"]
    cosign_status: Literal["not-required", "pending", "returned", "cosigned"]
    author: ClinicianRef
    ai_assisted: bool
    signed_at: datetime | None = None
    updated_at: datetime


FollowUpUnit = Literal["day", "week", "month"]


class FollowUpInterval(Closed):
    """Counted from the visit's date in the facility's time zone (D40)."""

    value: Annotated[int, Field(ge=1, le=365)]
    unit: FollowUpUnit


class FollowUpRequest(Out):
    interval: FollowUpInterval
    appointment_type_id: UUID | None = None
    provider_id: UUID | None = None
    note: str | None = None
    status: Literal["open", "booked", "declined", "withdrawn"]
    requested_by: UUID
    requested_at: datetime
    booked_appointment_id: UUID | None = None
    declined_reason: str | None = None
    withdrawn_reason: str | None = None


class Encounter(Out):
    id: UUID
    patient_id: UUID
    status: EncounterStatus
    class_: Literal["AMB", "VR"] = Field(alias="class")
    types: list[CodeableConcept] | None = None
    reasons: list[CodeableConcept] | None = None
    appointment_id: UUID | None = None
    facility_id: UUID
    location_id: UUID | None = None
    time_zone: str
    started_at: datetime | None = None
    ended_at: datetime | None = None
    participants: list[EncounterParticipant]
    diagnoses: list[EncounterDiagnosis]
    vitals: list[Vital]
    notes: list[NoteSummary]
    created_at: datetime
    updated_at: datetime
    follow_up: FollowUpRequest | None = None


class FollowUpRequestPut(Closed):
    interval: FollowUpInterval
    appointment_type_id: UUID | None = None
    provider_id: UUID | None = None
    note: Annotated[str, _text(500)] | None = None


class FollowUpDecline(Closed):
    reason: Annotated[str, _text(500, min_length=1)]


class FollowUpWithdraw(Closed):
    reason: Annotated[str, _text(500, min_length=1)]


# ----------------------------------------------------------------------- after-visit summary
class AfterVisitSummaryRequest(Closed):
    note_id: UUID | None = None


class AfterVisitSummaryLink(Out):
    document_id: UUID
    generated_at: datetime
    url: str
    expires_at: datetime


class EncounterPatch(Closed):
    """JSON Merge Patch: a field left out is unchanged; `null` clears `reasons` or
    `locationId`. ``model_fields_set`` says which fields were sent."""

    reasons: Annotated[list[CodeableConcept], Field(max_length=5)] | None = None
    location_id: UUID | None = None
    participants: Annotated[list[EncounterParticipant], Field(max_length=10)] | None = None
