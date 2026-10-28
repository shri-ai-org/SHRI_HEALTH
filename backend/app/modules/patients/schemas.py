"""Request and response shapes for the patients API, from contracts/openapi/modules/patients.yaml.

Field names are the contract's camelCase (aliases); request bodies the contract closes
(`additionalProperties: false`) forbid unknown fields, so a typo is a 422, not a silent drop.
Only the operations PR-1 builds are here; later PRs add theirs.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel


def _text(max_length: int, *, min_length: int = 0, pattern: str | None = None) -> object:
    return StringConstraints(min_length=min_length, max_length=max_length, pattern=pattern)


PhoneNumber = Annotated[str, _text(16, pattern=r"^\+[1-9]\d{6,14}$")]
State = Annotated[str, _text(2, pattern=r"^[A-Z]{2}$")]
PostalCode = Annotated[str, _text(10, pattern=r"^\d{5}(-\d{4})?$")]
LanguageTag = Annotated[str, _text(35, pattern=r"^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$")]
Gender = Literal["male", "female", "other", "unknown"]
BirthSex = Literal["F", "M", "UNK"]
MaritalStatus = Literal["A", "D", "I", "L", "M", "P", "S", "T", "U", "W"]
ContactUse = Literal["home", "work", "mobile", "temp", "old"]
IdentifierType = Literal["MR", "DL", "PI"]
IdentifierUse = Literal["usual", "official", "temp", "secondary", "old"]


class Closed(BaseModel):
    """A request body the contract closes: unknown fields are refused."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Out(BaseModel):
    """A response body."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class HumanName(Closed):
    family: Annotated[str, _text(100)]
    given: Annotated[list[Annotated[str, _text(100)]], Field(max_length=5)] = []
    prefix: Annotated[str, _text(20)] | None = None
    suffix: Annotated[str, _text(20)] | None = None


class CodedValue(Closed):
    system: Annotated[str, _text(300)] | None = None
    code: Annotated[str, _text(64)] | None = None
    display: Annotated[str, _text(500)] | None = None
    text: Annotated[str, _text(1000)] | None = None


class RaceEthnicity(Closed):
    omb_categories: Annotated[list[Annotated[str, _text(10)]], Field(max_length=7)] = []
    detailed: Annotated[list[Annotated[str, _text(10)]], Field(max_length=20)] = []
    text: Annotated[str, _text(200)] | None = None


class Phone(Closed):
    number: PhoneNumber
    use: ContactUse | None = None
    text_messages: bool | None = None


class Email(Closed):
    address: Annotated[str, _text(254, pattern=r"^[^@\s]+@[^@\s]+$")]
    use: ContactUse | None = None


class Address(Closed):
    lines: Annotated[list[Annotated[str, _text(100)]], Field(min_length=1, max_length=3)]
    city: Annotated[str, _text(60)]
    state: State
    postal_code: PostalCode
    country: Literal["US"]


class Employer(Closed):
    name: Annotated[str, _text(200)]
    phone: PhoneNumber | None = None
    address: Address | None = None


# ------------------------------------------------------------------------------------ identifiers
class PatientIdentifierCreate(Closed):
    type: Literal["DL", "PI"]  # MR is server-generated only (D41)
    system: Annotated[str, _text(300)] | None = None
    value: Annotated[str, _text(200, min_length=1)]
    assigner: Annotated[str, _text(300)] | None = None
    document_id: UUID | None = None


class PatientIdentifier(Out):
    id: UUID
    type: IdentifierType
    system: str | None = None
    value: str
    assigner: str | None = None
    document_id: UUID | None = None
    use: IdentifierUse | None = None
    created_at: datetime


class PatientIdentifierList(Out):
    items: list[PatientIdentifier]
    next_cursor: str | None = None


# --------------------------------------------------------------------------------------- patients
class PatientCreate(Closed):
    name: HumanName
    preferred_name: Annotated[str, _text(100)] | None = None
    previous_names: Annotated[list[HumanName], Field(max_length=5)] = []
    birth_date: date
    gender: Gender | None = None
    birth_sex: BirthSex | None = None
    gender_identity: CodedValue | None = None
    sexual_orientation: CodedValue | None = None
    race: RaceEthnicity | None = None
    ethnicity: RaceEthnicity | None = None
    preferred_language: LanguageTag | None = None
    marital_status: MaritalStatus | None = None
    occupation: CodedValue | None = None
    industry: CodedValue | None = None
    tribal_affiliation: CodedValue | None = None
    phones: Annotated[list[Phone], Field(max_length=5)] = []
    emails: Annotated[list[Email], Field(max_length=3)] = []
    address: Address | None = None
    employer: Employer | None = None
    identifiers: Annotated[list[PatientIdentifierCreate], Field(max_length=10)] = []
    duplicate_check: Literal["default", "override"] = "default"
    duplicate_override_reason: Annotated[str, _text(500)] | None = None


class Patient(Out):
    id: UUID
    mrn: str
    name: HumanName
    preferred_name: str | None = None
    previous_names: list[HumanName] = []
    birth_date: date | None = None
    gender: Gender | None = None
    birth_sex: BirthSex | None = None
    gender_identity: CodedValue | None = None
    sexual_orientation: CodedValue | None = None
    race: RaceEthnicity | None = None
    ethnicity: RaceEthnicity | None = None
    preferred_language: str | None = None
    marital_status: MaritalStatus | None = None
    occupation: CodedValue | None = None
    industry: CodedValue | None = None
    tribal_affiliation: CodedValue | None = None
    phones: list[Phone] = []
    emails: list[Email] = []
    address: Address | None = None
    employer: Employer | None = None
    identifiers: list[PatientIdentifier] = []
    restricted: bool
    active: bool
    merged_into_id: UUID | None = None
    created_at: datetime
    updated_at: datetime


class SearchCriteria(Closed):
    family: Annotated[str, _text(100, min_length=2)] | None = None
    given: Annotated[str, _text(100, min_length=1)] | None = None
    birth_date: date | None = None
    phone: PhoneNumber | None = None
    mrn: Annotated[str, _text(40, min_length=1)] | None = None
    drivers_license_number: Annotated[str, _text(200, min_length=1)] | None = None
    member_id: Annotated[str, _text(200, min_length=1)] | None = None
    include_inactive: bool = False


class PatientSearchRequest(Closed):
    criteria: SearchCriteria
    limit: Annotated[int, Field(ge=1, le=50)] = 20
    cursor: Annotated[str, _text(512, pattern=r"^[A-Za-z0-9_-]+$")] | None = None


class PatientSummary(Out):
    id: UUID
    name: HumanName
    birth_date: date | None = None
    gender: Gender | None = None
    mrn: str
    phone_last4: str | None = None
    restricted: bool
    active: bool


class PatientSummaryList(Out):
    items: list[PatientSummary]
    next_cursor: str | None = None


# -------------------------------------------------------------------------------- related persons
Relationships = Annotated[list[CodedValue], Field(min_length=1, max_length=5)]


class RelatedPersonCreate(Closed):
    name: HumanName
    relationships: Relationships
    gender: Gender | None = None
    birth_date: date | None = None
    phones: Annotated[list[Phone], Field(max_length=5)] = []
    emails: Annotated[list[Email], Field(max_length=3)] = []
    address: Address | None = None
    employer: Employer | None = None


class RelatedPersonPatch(Closed):
    """JSON merge patch (RFC 7396): an absent field is unchanged, `null` clears it."""

    name: HumanName | None = None
    relationships: Relationships | None = None
    gender: Gender | None = None
    birth_date: date | None = None
    phones: Annotated[list[Phone], Field(max_length=5)] | None = None
    emails: Annotated[list[Email], Field(max_length=3)] | None = None
    address: Address | None = None
    employer: Employer | None = None
    active: bool | None = None


class RelatedPerson(Out):
    id: UUID
    patient_id: UUID
    name: HumanName
    relationships: list[CodedValue]
    gender: Gender | None = None
    birth_date: date | None = None
    phones: list[Phone] = []
    emails: list[Email] = []
    address: Address | None = None
    employer: Employer | None = None
    active: bool
    created_at: datetime
    updated_at: datetime


class RelatedPersonList(Out):
    items: list[RelatedPerson]
    next_cursor: str | None = None


class PatientPatch(Closed):
    """JSON merge patch (RFC 7396) for demographics: an absent field is unchanged, `null` clears
    it, lists replace the stored list. The MRN, identifiers, restriction and status aren't here."""

    name: HumanName | None = None
    preferred_name: Annotated[str, _text(100)] | None = None
    previous_names: Annotated[list[HumanName], Field(max_length=5)] | None = None
    birth_date: date | None = None
    gender: Gender | None = None
    birth_sex: BirthSex | None = None
    gender_identity: CodedValue | None = None
    sexual_orientation: CodedValue | None = None
    race: RaceEthnicity | None = None
    ethnicity: RaceEthnicity | None = None
    preferred_language: LanguageTag | None = None
    marital_status: MaritalStatus | Literal[""] | None = None
    occupation: CodedValue | None = None
    industry: CodedValue | None = None
    tribal_affiliation: CodedValue | None = None
    phones: Annotated[list[Phone], Field(max_length=5)] | None = None
    emails: Annotated[list[Email], Field(max_length=3)] | None = None
    address: Address | None = None
    employer: Employer | None = None


class PatientSummariesRequest(Closed):
    patient_ids: Annotated[list[UUID], Field(min_length=1, max_length=50)]


class PatientSummaryBatch(Out):
    items: list[PatientSummary]


class RestrictRequest(Closed):
    category: Literal["sensitive", "vip"]
    reason: Annotated[str, _text(500, min_length=1)]


class UnrestrictRequest(Closed):
    reason: Annotated[str, _text(500, min_length=1)]


class PatientRestriction(Out):
    patient_id: UUID
    restricted: bool
    category: Literal["sensitive", "vip"] | None = None
    changed_at: datetime
