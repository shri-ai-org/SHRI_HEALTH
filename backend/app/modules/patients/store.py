"""The FHIR write-helper interface the patients repository is coded against (decision 3 of the
batch 1 plan, contracts/docs/IMPL_BATCH1_PLAN.md §7; posted on issue #13 for Anand to build as
``app.db.fhir_store``).

Until ``app.db.fhir_store`` exists, ``FhirStore`` below is the contract between the two sides: the
repository takes any object with these methods, the unit tests pass an in-memory fake, and the
live-database tests run once the real module lands.

Rules for every helper:
- It takes the request's ``AsyncSession`` from ``tenant_db`` and never commits or opens a session:
  the caller's transaction holds the whole request (DATA_OWNERSHIP §3.1).
- It writes the resource and all its child rows; lists given on create or update replace the stored
  list, and fields left as ``UNSET`` are not touched.
- ``if_version`` is checked under a row lock (``SELECT … FOR UPDATE``); a mismatch raises
  ``StaleVersion`` with the current version, which the API turns into ``412`` with that ETag.
- It returns the version this transaction gives the resource (the database's version trigger
  bumps ``meta_version_id`` once per transaction, child rows included): the new ETag's source.
- A resource the session cannot see (another clinic, or no such row) raises ``ResourceNotFound``.
- Provenance: a helper that changes a status to ``entered-in-error`` writes its Provenance (agent:
  the current user from ``app.current_user_id``; the reason; the target version) in the same
  transaction.
"""

from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession


class _Unset(enum.Enum):
    UNSET = "UNSET"


UNSET = _Unset.UNSET
"""On an update, a field left as UNSET is not changed; None clears it."""


class StaleVersion(Exception):
    def __init__(self, current_version: int) -> None:
        super().__init__("stale version")
        self.current_version = current_version


class ResourceNotFound(Exception):
    pass


@dataclass(frozen=True)
class Written:
    id: uuid.UUID
    version: int  # meta_version_id after this transaction: the ETag source
    last_updated: datetime


@dataclass(frozen=True)
class ChildWritten:
    child_id: uuid.UUID
    parent: Written


# ------------------------------------------------------------ data types (FHIR-shaped, by column)
@dataclass(frozen=True)
class Coded:
    """A contract CodedValue: one coding with optional text. A code needs a registered system."""
    system: str | None = None
    code: str | None = None
    display: str | None = None
    text: str | None = None


@dataclass(frozen=True)
class Name:
    use: str  # official | nickname (preferredName, D57) | old | maiden (previousNames)
    family: str | None = None
    given: tuple[str, ...] = ()
    prefix: tuple[str, ...] = ()
    suffix: tuple[str, ...] = ()
    text: str | None = None


@dataclass(frozen=True)
class Telecom:
    system: str  # phone | email
    value: str  # phone in E.164
    use: str | None = None  # home | work | mobile
    rank: int | None = None


@dataclass(frozen=True)
class PostalAddress:
    lines: tuple[str, ...]
    city: str
    state: str
    postal_code: str
    country: str = "US"
    use: str | None = None


@dataclass(frozen=True)
class IdentifierIn:
    system: str
    value: str
    type_code: str | None = None  # v2-0203: MR, DL, SB, …
    use: str | None = None  # usual | official | secondary | old
    assigner_display: str | None = None
    period_start: date | None = None
    period_end: date | None = None


@dataclass(frozen=True)
class RaceOrEthnicity:
    omb_categories: tuple[str, ...] = ()  # CDC codes, or UNK / ASKU
    detailed: tuple[str, ...] = ()
    text: str | None = None


@dataclass(frozen=True)
class EmployerIn:
    name: str
    phone: str | None = None
    address: PostalAddress | None = None


@dataclass(frozen=True)
class PatientIn:
    names: tuple[Name, ...]  # at least one `official`
    birth_date: date
    gender: str  # administrative-gender; the repository writes `unknown` when absent (db/CLAUDE.md)
    active: bool = True
    birth_sex: str | None = None
    gender_identity: Coded | None = None
    sexual_orientation: Coded | None = None
    occupation: Coded | None = None
    industry: Coded | None = None
    tribal_affiliation: Coded | None = None
    race: RaceOrEthnicity | None = None
    ethnicity: RaceOrEthnicity | None = None
    preferred_language: str | None = None  # BCP 47; stored as patient_communication (preferred)
    marital_status: str | None = None  # v3 MaritalStatus
    telecoms: tuple[Telecom, ...] = ()
    addresses: tuple[PostalAddress, ...] = ()
    identifiers: tuple[IdentifierIn, ...] = ()  # includes the MR from admin.next_mrn()
    employer: EmployerIn | None = None
    entry_source: str = "clinician"


@dataclass(frozen=True)
class PatientChanges:
    """Each field UNSET (unchanged), None (cleared, where the column allows it) or a value. Tuples
    replace the whole list. MR identifiers are never in here: they only come from the counter
    (D41)."""
    names: tuple[Name, ...] | _Unset = UNSET
    birth_date: date | _Unset = UNSET
    gender: str | _Unset = UNSET
    birth_sex: str | None | _Unset = UNSET
    gender_identity: Coded | None | _Unset = UNSET
    sexual_orientation: Coded | None | _Unset = UNSET
    occupation: Coded | None | _Unset = UNSET
    industry: Coded | None | _Unset = UNSET
    tribal_affiliation: Coded | None | _Unset = UNSET
    race: RaceOrEthnicity | None | _Unset = UNSET
    ethnicity: RaceOrEthnicity | None | _Unset = UNSET
    preferred_language: str | None | _Unset = UNSET
    marital_status: str | None | _Unset = UNSET
    telecoms: tuple[Telecom, ...] | _Unset = UNSET
    addresses: tuple[PostalAddress, ...] | _Unset = UNSET
    employer: EmployerIn | None | _Unset = UNSET


@dataclass(frozen=True)
class RelatedPersonIn:
    patient_id: uuid.UUID
    relationships: tuple[Coded, ...]  # v3 RoleCode (EMC emergency contact, GUAR guarantor, …)
    names: tuple[Name, ...]
    active: bool = True
    gender: str | None = None
    birth_date: date | None = None
    telecoms: tuple[Telecom, ...] = ()
    addresses: tuple[PostalAddress, ...] = ()
    employer: EmployerIn | None = None


@dataclass(frozen=True)
class RelatedPersonChanges:
    relationships: tuple[Coded, ...] | _Unset = UNSET
    names: tuple[Name, ...] | _Unset = UNSET
    active: bool | _Unset = UNSET
    gender: str | None | _Unset = UNSET
    birth_date: date | None | _Unset = UNSET
    telecoms: tuple[Telecom, ...] | _Unset = UNSET
    addresses: tuple[PostalAddress, ...] | _Unset = UNSET
    employer: EmployerIn | None | _Unset = UNSET


@dataclass(frozen=True)
class CoverageClassIn:
    type: str  # coverage-class: group | plan | …
    value: str
    name: str | None = None


@dataclass(frozen=True)
class CostIn:
    type: Coded  # copay, deductible, …
    money: Decimal | None = None  # USD, exact (D40)
    percent: Decimal | None = None


@dataclass(frozen=True)
class CoverageIn:
    beneficiary_patient_id: uuid.UUID
    payer_id: uuid.UUID  # admin.payer (the payer directory); written as coverage_payor
    status: str = "active"
    subscriber_id: str | None = None  # member ID
    subscriber_patient_id: uuid.UUID | None = None  # the patient themself …
    subscriber_related_person_id: uuid.UUID | None = None  # … or a related person (one of two)
    relationship_code: str | None = None  # subscriber-relationship: self | spouse | child | …
    dependent: str | None = None
    order: int | None = None  # 1 primary, 2 secondary
    network: str | None = None
    period_start: date | None = None
    period_end: date | None = None
    classes: tuple[CoverageClassIn, ...] = ()
    costs: tuple[CostIn, ...] = ()
    accept_assignment: bool = True


@dataclass(frozen=True)
class CoverageChanges:
    subscriber_id: str | None | _Unset = UNSET
    subscriber_patient_id: uuid.UUID | None | _Unset = UNSET
    subscriber_related_person_id: uuid.UUID | None | _Unset = UNSET
    relationship_code: str | None | _Unset = UNSET
    dependent: str | None | _Unset = UNSET
    order: int | None | _Unset = UNSET
    network: str | None | _Unset = UNSET
    period_start: date | None | _Unset = UNSET
    period_end: date | None | _Unset = UNSET  # ending a coverage (D45)
    classes: tuple[CoverageClassIn, ...] | _Unset = UNSET
    costs: tuple[CostIn, ...] | _Unset = UNSET
    accept_assignment: bool | _Unset = UNSET


@dataclass(frozen=True)
class ConsentIn:
    patient_id: uuid.UUID
    kind: str  # ext_kind: the practice's consent kind (D59)
    status: str  # active | rejected | inactive …
    categories: tuple[Coded, ...]
    date_time: datetime
    policy_version: str | None = None  # the version the patient signed (D59)
    signature_method: str | None = None
    provision_type: str | None = None  # permit | deny
    grantor_related_person_id: uuid.UUID | None = None  # signed by a related person
    source_document_reference_id: uuid.UUID | None = None  # the signed form
    performer_patient_id: uuid.UUID | None = None
    performer_related_person_id: uuid.UUID | None = None
    verified: bool = False
    verified_with_patient_id: uuid.UUID | None = None
    verified_with_related_person_id: uuid.UUID | None = None
    verification_date: datetime | None = None
    entry_source: str = "clinician"


@dataclass(frozen=True)
class Reason:
    text: str  # required, never blank
    code: Coded | None = None


# ---------------------------------------------------------------- the helpers
class FhirStore(Protocol):
    # Patient (and its child rows: human_name, contact_point, address, identifier,
    # patient_communication, patient_race_ethnicity, the D39 columns, admin.employer)
    async def create_patient(self, db: AsyncSession, data: PatientIn) -> Written: ...

    async def update_patient(self, db: AsyncSession, patient_id: uuid.UUID, changes: PatientChanges,
                             *, if_version: int) -> Written: ...

    async def add_patient_identifier(self, db: AsyncSession, patient_id: uuid.UUID,
                                     identifier: IdentifierIn, *, if_version: int | None = None
                                     ) -> ChildWritten:
        """The new identifier's id, and the patient's new version (an identifier is a child row,
        so it changes the patient's version and ETag)."""
        ...

    async def set_patient_security(self, db: AsyncSession, patient_id: uuid.UUID,
                                   labels: frozenset[str], *, if_version: int | None = None
                                   ) -> Written:
        """Restrict (R or V) or unrestrict (empty): replaces the confidentiality labels only."""
        ...

    # RelatedPerson (related_person, related_person_relationship, human_name, contact_point,
    # address, admin.employer)
    async def create_related_person(self, db: AsyncSession, data: RelatedPersonIn) -> Written: ...

    async def update_related_person(self, db: AsyncSession, related_person_id: uuid.UUID,
                                    changes: RelatedPersonChanges, *, if_version: int
                                    ) -> Written: ...

    # Coverage (coverage, coverage_payor, coverage_class, coverage_cost_to_beneficiary)
    async def create_coverage(self, db: AsyncSession, data: CoverageIn) -> Written: ...

    async def update_coverage(self, db: AsyncSession, coverage_id: uuid.UUID,
                              changes: CoverageChanges, *, if_version: int) -> Written: ...

    async def coverage_entered_in_error(self, db: AsyncSession, coverage_id: uuid.UUID,
                                        reason: Reason, *, if_version: int | None = None
                                        ) -> Written:
        """status → entered-in-error with its Provenance (D45); already entered-in-error raises
        InvalidTransition."""
        ...

    # Consent (consent, consent_category, consent_performer, consent_verification). Insert-only:
    # a revocation is a new Consent (DATA_OWNERSHIP §2.1), so there is no update.
    async def create_consent(self, db: AsyncSession, data: ConsentIn) -> Written: ...


class InvalidTransition(Exception):
    def __init__(self, current_state: str) -> None:
        super().__init__("invalid state transition")
        self.current_state = current_state


__all__ = [
    "UNSET", "Coded", "ConsentIn", "CostIn", "CoverageChanges", "CoverageClassIn", "CoverageIn",
    "ChildWritten", "EmployerIn", "FhirStore", "IdentifierIn", "InvalidTransition", "Name",
    "PatientChanges",
    "PatientIn", "PostalAddress", "RaceOrEthnicity", "Reason", "RelatedPersonChanges",
    "RelatedPersonIn", "ResourceNotFound", "StaleVersion", "Telecom", "Written",
]
