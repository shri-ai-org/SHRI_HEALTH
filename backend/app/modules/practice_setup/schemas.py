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

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, PlainSerializer
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


# ------------------------------------------------------------------------- practice settings
class In(BaseModel):
    """A request body: unknown fields are refused (the contract's additionalProperties: false)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid",
                              strict=True)


class PracticeRegistrationSettings(Out):
    show_sexual_orientation_and_gender_identity: bool


class PracticeSettings(Out):
    registration: PracticeRegistrationSettings
    mrn_prefix: str
    mrn_system: str
    updated_at: Timestamp


class PracticeRegistrationSettingsPatch(In):
    show_sexual_orientation_and_gender_identity: bool | None = None


class PracticeSettingsPatch(In):
    """JSON Merge Patch (minProperties 1 at each level). A field left out is unchanged; ``null``
    is refused, since every setting is a boolean with a default."""

    registration: PracticeRegistrationSettingsPatch | None = None


# ------------------------------------------------------------------------- facility update
class AddressIn(In):
    lines: Annotated[list[Annotated[str, Field(max_length=100)]],
                     Field(min_length=1, max_length=3)]
    city: Annotated[str, Field(min_length=1, max_length=60)]
    state: Annotated[str, Field(pattern=r"^[A-Z]{2}$")]
    postal_code: Annotated[str, Field(pattern=r"^\d{5}(-\d{4})?$")]
    country: Literal["US"]


class FacilityPatch(In):
    """JSON Merge Patch on a facility (minProperties 1). A field left out is unchanged. No field
    is nullable in the contract, so ``null`` is refused; ``code`` is fixed once created."""

    name: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    time_zone: Annotated[str, Field(max_length=64,
                                    pattern=r"^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$")] | None = None
    address: AddressIn | None = None
    phone: Annotated[str, Field(pattern=r"^\+[1-9]\d{6,14}$")] | None = None
    npi: Annotated[str, Field(pattern=r"^\d{10}$")] | None = None
    clia_number: Annotated[str, Field(pattern=r"^\d{2}D\d{7}$")] | None = None
    place_of_service_code: Annotated[str, Field(pattern=r"^\d{2}$")] | None = None
    billing_location: bool | None = None
    active: bool | None = None


# ------------------------------------------------------------------------- creates
class Create(In):
    """A create body: unknown fields refused, as for `In`, but not strict, so dates, times and
    IDs arrive as the JSON strings the contract defines."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid",
                              strict=False)  # explicit: a subclass merges In's strict=True


Text = Annotated[str, Field(max_length=100)]


class HumanNameIn(Create):
    family: Annotated[str, Field(max_length=100)]
    given: Annotated[list[Text], Field(max_length=5)] = []
    prefix: Annotated[str, Field(max_length=20)] | None = None
    suffix: Annotated[str, Field(max_length=20)] | None = None


class SetupCodingIn(Create):
    system: Annotated[str, Field(max_length=300, pattern=r"^[A-Za-z][A-Za-z0-9+.-]*:\S+$")]
    code: Annotated[str, Field(max_length=64)]
    display: Annotated[str, Field(max_length=500)] | None = None


class ProviderQualificationIn(Create):
    code: SetupCodingIn
    license_number: Annotated[str, Field(max_length=200)] | None = None
    state: Annotated[str, Field(pattern=r"^[A-Z]{2}$")] | None = None
    issuer: Annotated[str, Field(max_length=300)] | None = None
    start_date: date | None = None
    end_date: date | None = None


class ProviderCreate(Create):
    name: HumanNameIn
    npi: Annotated[str, Field(pattern=r"^\d{10}$")]
    gender: Gender | None = None
    qualifications: Annotated[list[ProviderQualificationIn], Field(max_length=20)] = []
    specialties: Annotated[list[SetupCodingIn], Field(max_length=10)] = []
    facility_ids: Annotated[list[UUID], Field(max_length=50)]
    phone: Annotated[str, Field(pattern=r"^\+[1-9]\d{6,14}$")] | None = None
    email: Annotated[str, Field(max_length=254, pattern=r"^[^@\s]+@[^@\s]+$")] | None = None


HhMm = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]


class AvailabilityRuleIn(Create):
    """A rule as the contract's AvailabilityRule; an `id` sent with it is ignored, since the
    server assigns every new rule's ID."""

    id: UUID | None = None
    day_of_week: DayOfWeek
    start_time: HhMm
    end_time: HhMm
    slot_minutes: Annotated[int, Field(ge=5, le=240)]
    location_id: UUID | None = None
    appointment_type_ids: Annotated[list[UUID], Field(max_length=50)] = []
    start_date: date
    end_date: date | None = None


class ScheduleExceptionIn(Create):
    id: UUID | None = None
    start_at: AwareDatetime  # RFC 3339 needs an offset; any offset, stored as UTC
    end_at: AwareDatetime
    available: bool
    reason: Annotated[str, Field(max_length=200)] | None = None


class ProviderScheduleCreate(Create):
    provider_id: UUID
    facility_id: UUID
    availability_rules: Annotated[list[AvailabilityRuleIn], Field(max_length=100)] = []
    exceptions: Annotated[list[ScheduleExceptionIn], Field(max_length=500)] = []
    comment: Annotated[str, Field(max_length=1000)] | None = None
