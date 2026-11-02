"""Response shapes of the practice-setup reads, from contracts/openapi/modules/practice-setup.yaml.

Field names are the contract's camelCase (aliases). These are response bodies, built by the
repository from rows the database has already checked, so they carry the contract's types and
required fields but not its input patterns: a stored value the patterns would refuse is still
returned rather than failing the whole list. Request bodies (the writes) come with their
operations and will be closed (`extra="forbid"`) with the contract's patterns.

Timestamps are serialized as the contract's `Timestamp`: UTC with `Z`, at most milliseconds.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, PlainSerializer
from pydantic.alias_generators import to_camel


def _utc(value: datetime) -> str:
    at = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    spec = "milliseconds" if at.microsecond else "seconds"
    return at.isoformat(timespec=spec).replace("+00:00", "Z")


Timestamp = Annotated[datetime, PlainSerializer(_utc, return_type=str, when_used="json")]

Gender = Literal["male", "female", "other", "unknown"]
DayOfWeek = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
PayerType = Literal[
    "commercial", "medicare", "medicare-advantage", "medicaid", "tricare", "workers-comp",
    "auto", "self-pay", "other",
]
EnrollmentTransaction = Literal["837P", "835", "270", "276", "EFT"]
EnrollmentStatus = Literal["not-required", "pending", "approved", "rejected"]


class Out(BaseModel):
    """A response body."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class SetupCoding(Out):
    system: str
    code: str
    display: str | None = None


class Address(Out):
    lines: list[str]
    city: str
    state: str
    postal_code: str
    country: Literal["US"] = "US"


class HumanName(Out):
    family: str
    given: list[str] = []
    prefix: str | None = None
    suffix: str | None = None


# ----------------------------------------------------------------------------------- facilities
class Facility(Out):
    id: UUID
    code: str
    name: str
    time_zone: str
    address: Address | None = None  # required by the contract; see repository.py
    phone: str | None = None
    npi: str | None = None
    clia_number: str | None = None
    place_of_service_code: str
    billing_location: bool
    active: bool
    created_at: Timestamp
    updated_at: Timestamp


class FacilityList(Out):
    items: list[Facility]
    next_cursor: str | None = None


# ----------------------------------------------------------------------------------- providers
class ProviderQualification(Out):
    code: SetupCoding
    license_number: str | None = None
    state: str | None = None
    issuer: str | None = None
    start_date: date | None = None
    end_date: date | None = None


class Provider(Out):
    id: UUID
    name: HumanName | None = None  # required by the contract; see repository.py
    npi: str | None = None  # required by the contract; see repository.py
    gender: Gender | None = None
    qualifications: list[ProviderQualification] = []
    specialties: list[SetupCoding] = []
    facility_ids: list[UUID] = []
    phone: str | None = None
    email: str | None = None
    active: bool
    created_at: Timestamp
    updated_at: Timestamp


class ProviderList(Out):
    items: list[Provider]
    next_cursor: str | None = None


# ----------------------------------------------------------------------------- appointment types
class AppointmentType(Out):
    id: UUID
    code: str
    name: str
    default_duration_minutes: int
    color: str | None = None
    allow_overlap: bool
    max_overbook: int
    requires_eligibility_check: bool
    telehealth: bool
    new_patient: bool
    default_note_template_id: UUID | None = None
    active: bool
    created_at: Timestamp
    updated_at: Timestamp


class AppointmentTypeList(Out):
    items: list[AppointmentType]
    next_cursor: str | None = None


# ----------------------------------------------------------------------------------- schedules
class AvailabilityRule(Out):
    id: UUID
    day_of_week: DayOfWeek
    start_time: str  # HH:MM, facility time
    end_time: str
    slot_minutes: int
    location_id: UUID | None = None
    appointment_type_ids: list[UUID] = []
    start_date: date
    end_date: date | None = None


class ScheduleException(Out):
    id: UUID
    start_at: Timestamp
    end_at: Timestamp
    available: bool
    reason: str | None = None


class ProviderSchedule(Out):
    id: UUID
    provider_id: UUID
    facility_id: UUID
    availability_rules: list[AvailabilityRule] = []
    exceptions: list[ScheduleException] = []
    comment: str | None = None
    active: bool
    created_at: Timestamp
    updated_at: Timestamp


class ProviderScheduleList(Out):
    items: list[ProviderSchedule]
    next_cursor: str | None = None


# ----------------------------------------------------------------------------------- payers
class ClearinghouseId(Out):
    clearinghouse: str
    external_payer_id: str


class Payer(Out):
    id: UUID
    name: str
    payer_type: PayerType
    phone: str | None = None
    address_line: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    clearinghouse_ids: list[ClearinghouseId] = []
    supports_eligibility: bool
    supports_claim_status: bool
    supports_era: bool
    active: bool


class PayerList(Out):
    items: list[Payer]
    next_cursor: str | None = None


class PayerEnrollment(Out):
    transaction: EnrollmentTransaction
    clearinghouse: str
    provider_id: UUID | None = None
    status: EnrollmentStatus
    submitted_at: Timestamp | None = None
    approved_at: Timestamp | None = None


class PayerSummary(Out):
    id: UUID
    name: str
    payer_type: PayerType


class PracticePayer(Out):
    id: UUID
    payer_id: UUID
    enrollments: list[PayerEnrollment] = []
    payer: PayerSummary
    active: bool
    created_at: Timestamp
    updated_at: Timestamp


class PracticePayerList(Out):
    items: list[PracticePayer]
    next_cursor: str | None = None


# ----------------------------------------------------------------------------------- note templates
class NoteTemplateSection(Out):
    sequence: int
    section_code: str
    title: str
    default_text: str | None = None
    required: bool


class NoteTemplate(Out):
    id: UUID
    code: str
    version: int  # optional in the contract; always sent, the ETag of the single GET
    name: str
    specialty_code: str | None = None
    note_type_loinc: str
    personal: bool
    sections: list[NoteTemplateSection] = []
    owner_user_id: UUID | None = None
    active: bool
    created_at: Timestamp
    updated_at: Timestamp


class NoteTemplateList(Out):
    items: list[NoteTemplate]
    next_cursor: str | None = None
