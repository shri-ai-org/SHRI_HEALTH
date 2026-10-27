"""FHIR write helpers for the patients repository (batch 1 plan §7.3; issue #13).

Vimal's interface (``backend/app/modules/patients/store.py`` on his branch), with the renames
posted on #13: ``CoverageIn.member_id``, no ``CostIn.percent``,
``ConsentIn.source_attachment_binary_object_id``, ``IdentifierIn.supporting_document_id``, and
``Telecom.system`` ``sms`` for a phone that takes text messages. His file re-exports these
names.

Rules for every helper:
- It takes the request's ``AsyncSession`` from ``tenant_db`` and never commits or opens a session:
  the caller's transaction holds the whole request (DATA_OWNERSHIP §3.1).
- It writes the resource and all its child rows. Lists given on create or update replace the
  stored list; a field left ``UNSET`` is not touched, and ``None`` clears it.
- ``if_version`` is checked under a row lock (``SELECT … FOR UPDATE``); a mismatch raises
  ``StaleVersion`` with the current version, which the API turns into ``412`` with that ETag.
- It returns the version this transaction gives the resource (the versioning trigger bumps
  ``meta_version_id`` once per transaction, child rows included): the ETag's source.
- A resource the session cannot see (another clinic, or no such row) raises ``ResourceNotFound``.
- A status change to ``entered-in-error`` writes its Provenance (agent the current user from
  ``app.current_user_id``, the reason, the target version) in the same transaction.
- An MR identifier comes only from ``admin.next_mrn()`` (D41): ``create_patient`` takes it among
  ``identifiers``, and no other helper adds or changes one. No other identifier may use the
  practice's MRN system, so a value the counter hasn't reached can never block a registration.
- Input the API should refuse with ``422`` raises ``InvalidInput`` (a ``ValueError``);
  ``InvalidTransition`` is a change the record's state doesn't allow. ``RuntimeError`` is a
  programming error, such as a write with no signed-in user to record.
"""

from __future__ import annotations

import enum
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Protocol, TypeIs

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import systems
from app.db.models.admin.core import AppUser, MrnCounter
from app.db.models.admin.rcm import Employer
from app.db.models.fhir.datatypes import Address, ContactPoint, HumanName, Identifier
from app.db.models.fhir.directory import (
    Patient,
    PatientCommunication,
    PatientRaceEthnicity,
    RelatedPerson,
    RelatedPersonRelationship,
)
from app.db.models.fhir.records import (
    Consent,
    ConsentCategory,
    ConsentPerformer,
    ConsentVerification,
    Coverage,
    CoverageClass,
    CoverageCostToBeneficiary,
    CoveragePayor,
    Provenance,
    ProvenanceAgent,
)


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


class InvalidTransition(Exception):
    def __init__(self, current_state: str) -> None:
        super().__init__("invalid state transition")
        self.current_state = current_state


class InvalidInput(ValueError):
    """Input the API refuses with 422; ``reason`` says why, in words for the problem detail."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Written:
    id: uuid.UUID
    version: int  # meta_version_id after this transaction: the ETag source
    last_updated: datetime


@dataclass(frozen=True)
class ChildWritten:
    child_id: uuid.UUID
    parent: Written


# ------------------------------------------------------- data types (FHIR-shaped, by column)
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
    system: str  # phone | sms (a phone that accepts text messages) | email
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
    supporting_document_id: uuid.UUID | None = None  # the scanned document (documentId, D56)


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
    money: Decimal  # USD, exact (D40)


@dataclass(frozen=True)
class CoverageIn:
    beneficiary_patient_id: uuid.UUID
    payer_id: uuid.UUID  # admin.payer (the payer directory); written as coverage_payor
    status: str = "active"
    member_id: str | None = None  # the card's member ID: an identifier of type MB
    subscriber_id: str | None = None  # the subscriber's own ID (coverage.subscriber_id)
    subscriber_patient_id: uuid.UUID | None = None  # the patient themself …
    subscriber_related_person_id: uuid.UUID | None = None  # … or a related person (one of the two)
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
    member_id: str | None | _Unset = UNSET
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
    source_attachment_binary_object_id: uuid.UUID | None = None  # the signed form, a file
    source_document_reference_id: uuid.UUID | None = None  # … or one already filed as a document
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

    async def update_patient(self, db: AsyncSession, patient_id: uuid.UUID,
                             changes: PatientChanges, *, if_version: int) -> Written: ...

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

    # Coverage (coverage, coverage_payor, coverage_class, coverage_cost_to_beneficiary, the MB
    # identifier)
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


# ---------------------------------------------------------------- the implementation
#: The D39 coded demographics, each patient.ext_<name>_{system,code,display,text}.
_D39 = ("gender_identity", "sexual_orientation", "occupation", "industry", "tribal_affiliation")
#: v3 Confidentiality labels in meta_security. set_patient_security replaces these and keeps the
#: sensitivity labels (PSY, SUD, …).
_CONFIDENTIALITY = frozenset({"L", "M", "N", "R", "V"})
_RESTRICTED = frozenset({"R", "V"})
#: Consent.scope (required by FHIR) from the practice's consent kind.
_SCOPE_OF_KIND = {"research": "research", "privacy-notice": "patient-privacy",
                  "information-sharing": "patient-privacy"}
_DEFAULT_SCOPE = "treatment"

def _given[T](value: T | _Unset) -> TypeIs[T]:
    return value is not UNSET


async def _locked[R: (Patient, RelatedPerson, Coverage)](
        db: AsyncSession, model: type[R], row_id: uuid.UUID, if_version: int | None) -> R:
    row = (await db.execute(select(model).where(model.id == row_id).with_for_update()
                            .execution_options(populate_existing=True))).scalar_one_or_none()
    if row is None:
        raise ResourceNotFound
    if if_version is not None and row.meta_version_id != if_version:
        raise StaleVersion(row.meta_version_id)
    return row


async def _written(db: AsyncSession, row: Patient | RelatedPerson | Coverage | Consent) -> Written:
    """Flushes, then reads back the version the database gave the row in this transaction
    (child rows bump their parent through its touch trigger)."""
    await db.flush()
    await db.refresh(row, attribute_names=["meta_version_id", "meta_last_updated"])
    return Written(row.id, row.meta_version_id, row.meta_last_updated)


def _set_coded(row: Patient, name: str, value: Coded | None) -> None:
    for part in ("system", "code", "display", "text"):
        setattr(row, f"ext_{name}_{part}", getattr(value, part) if value is not None else None)


def _names(owner: dict[str, uuid.UUID], names: Sequence[Name]) -> list[HumanName]:
    return [HumanName(**owner, use=n.use, family=n.family, given=list(n.given),
                      prefix=list(n.prefix), suffix=list(n.suffix), text=n.text) for n in names]


def _telecoms(owner: dict[str, uuid.UUID], telecoms: Sequence[Telecom]) -> list[ContactPoint]:
    return [ContactPoint(**owner, system=t.system, value=t.value, use=t.use, rank=t.rank)
            for t in telecoms]


def _addresses(owner: dict[str, uuid.UUID], addresses: Sequence[PostalAddress]) -> list[Address]:
    return [Address(**owner, line=list(a.lines), city=a.city, state=a.state,
                    postal_code=a.postal_code, country=a.country, use=a.use) for a in addresses]


def _identifier(owner: dict[str, uuid.UUID], i: IdentifierIn) -> Identifier:
    return Identifier(**owner, system=i.system, value=i.value,
                      type_system=systems.V2_0203 if i.type_code else None, type_code=i.type_code,
                      use=i.use, assigner_display=i.assigner_display, period_start=i.period_start,
                      period_end=i.period_end, supporting_document_id=i.supporting_document_id)


def _race_ethnicity(patient_id: uuid.UUID, kind: str,
                    value: RaceOrEthnicity | None) -> list[PatientRaceEthnicity]:
    if value is None:
        return []
    return ([PatientRaceEthnicity(patient_id=patient_id, kind=kind, level="ombCategory", code=c)
             for c in value.omb_categories]
            + [PatientRaceEthnicity(patient_id=patient_id, kind=kind, level="detailed", code=c)
               for c in value.detailed])


def _employer(owner: dict[str, uuid.UUID], value: EmployerIn | None) -> list[Employer]:
    if value is None:
        return []
    a = value.address
    return [Employer(**owner, name=value.name, phone=value.phone,
                     address_lines=list(a.lines) if a else None, address_city=a.city if a else None,
                     address_state=a.state if a else None,
                     address_postal_code=a.postal_code if a else None,
                     address_country=a.country if a else None)]


def _language(patient_id: uuid.UUID, tag: str | None) -> list[PatientCommunication]:
    if tag is None:
        return []
    return [PatientCommunication(patient_id=patient_id, language_system=systems.LANGUAGE,
                                 language_code=tag, preferred=True)]


async def _replace(db: AsyncSession, model: type[Any], owner: dict[str, uuid.UUID],
                   rows: Sequence[Any], *conditions: Any) -> None:
    """Replaces an owner's rows of one kind: a list given on create or update."""
    (column, owner_id), = owner.items()
    await db.execute(delete(model).where(getattr(model, column) == owner_id, *conditions))
    db.add_all(rows)


def _apply_patient_fields(pt: Patient, data: PatientIn | PatientChanges) -> None:
    for field in ("birth_date", "gender"):
        if _given(getattr(data, field)):
            setattr(pt, field, getattr(data, field))
    if _given(data.birth_sex):
        pt.ext_birthsex = data.birth_sex
    for name in _D39:
        if _given(getattr(data, name)):
            _set_coded(pt, name, getattr(data, name))
    if _given(data.marital_status):
        pt.marital_status_system = systems.MARITAL_STATUS if data.marital_status else None
        pt.marital_status_code = data.marital_status
    for kind in ("race", "ethnicity"):
        value = getattr(data, kind)
        if _given(value):
            setattr(pt, f"ext_{kind}_text", value.text if value is not None else None)


async def _patient_children(db: AsyncSession, patient_id: uuid.UUID,
                            data: PatientIn | PatientChanges) -> None:
    owner = {"patient_id": patient_id}
    if _given(data.names):
        await _replace(db, HumanName, owner, _names(owner, data.names))
    if _given(data.telecoms):
        await _replace(db, ContactPoint, owner, _telecoms(owner, data.telecoms))
    if _given(data.addresses):
        await _replace(db, Address, owner, _addresses(owner, data.addresses))
    for kind in ("race", "ethnicity"):
        value = getattr(data, kind)
        if _given(value):
            await _replace(db, PatientRaceEthnicity, owner,
                           _race_ethnicity(patient_id, kind, value),
                           PatientRaceEthnicity.kind == kind)
    if _given(data.preferred_language):
        await _replace(db, PatientCommunication, owner,
                       _language(patient_id, data.preferred_language))
    if _given(data.employer):
        await _replace(db, Employer, owner, _employer(owner, data.employer))


async def _person_children(db: AsyncSession, person_id: uuid.UUID,
                           data: RelatedPersonIn | RelatedPersonChanges) -> None:
    owner = {"related_person_id": person_id}
    if _given(data.relationships):
        await _replace(db, RelatedPersonRelationship, owner, [
            RelatedPersonRelationship(related_person_id=person_id, code_system=r.system,
                                      code_code=r.code, code_display=r.display, code_text=r.text)
            for r in data.relationships])
    if _given(data.names):
        await _replace(db, HumanName, owner, _names(owner, data.names))
    if _given(data.telecoms):
        await _replace(db, ContactPoint, owner, _telecoms(owner, data.telecoms))
    if _given(data.addresses):
        await _replace(db, Address, owner, _addresses(owner, data.addresses))
    if _given(data.employer):
        await _replace(db, Employer, owner, _employer(owner, data.employer))


async def _coverage_children(db: AsyncSession, coverage_id: uuid.UUID,
                             data: CoverageIn | CoverageChanges) -> None:
    owner = {"coverage_id": coverage_id}
    if _given(data.member_id):
        member = ([Identifier(coverage_id=coverage_id, type_system=systems.V2_0203,
                              type_code="MB", value=data.member_id)]
                  if data.member_id is not None else [])
        await _replace(db, Identifier, owner, member, Identifier.type_code == "MB")
    if _given(data.classes):
        await _replace(db, CoverageClass, owner, [
            CoverageClass(coverage_id=coverage_id, type=c.type, value=c.value, name=c.name)
            for c in data.classes])
    if _given(data.costs):
        await _replace(db, CoverageCostToBeneficiary, owner, [
            CoverageCostToBeneficiary(coverage_id=coverage_id, type_system=c.type.system,
                                      type_code=c.type.code, type_display=c.type.display,
                                      type_text=c.type.text, value_money_value=c.money,
                                      value_money_currency="USD")
            for c in data.costs])


_COVERAGE_FIELDS = ("subscriber_id", "subscriber_patient_id", "subscriber_related_person_id",
                    "relationship_code", "dependent", "order", "network", "period_start",
                    "period_end")


async def _refuse_mrn_system(db: AsyncSession, identifiers: Sequence[IdentifierIn]) -> None:
    """Only the counter writes in the practice's MRN system (D41): an identifier sent with it,
    say with a value the counter will reach later, would make that registration fail."""
    if not identifiers:
        return
    mrn_system = (await db.execute(select(MrnCounter.system))).scalar_one_or_none()
    if mrn_system is not None and any(i.system == mrn_system for i in identifiers):
        raise InvalidInput("only an MR identifier uses the practice's MRN system (D41)")


async def _current_user(db: AsyncSession) -> AppUser:
    user_id = (await db.execute(text(
        "SELECT NULLIF(current_setting('app.current_user_id', true), '')"))).scalar_one()
    user = (await db.execute(select(AppUser).where(AppUser.id == uuid.UUID(user_id))
                             )).scalar_one_or_none() if user_id else None
    if user is None:
        raise RuntimeError("no current user to record in the Provenance")
    return user


class SqlFhirStore:
    """The FhirStore the API uses: writes through the request's session, under RLS."""

    # ------------------------------------------------------------------------- Patient
    async def create_patient(self, db: AsyncSession, data: PatientIn) -> Written:
        await _refuse_mrn_system(db, [i for i in data.identifiers if i.type_code != "MR"])
        pt = Patient(active=data.active, entry_source=data.entry_source)
        _apply_patient_fields(pt, data)
        db.add(pt)
        await db.flush()
        await _patient_children(db, pt.id, data)
        db.add_all(_identifier({"patient_id": pt.id}, i) for i in data.identifiers)
        return await _written(db, pt)

    async def update_patient(self, db: AsyncSession, patient_id: uuid.UUID,
                             changes: PatientChanges, *, if_version: int) -> Written:
        pt = await _locked(db, Patient, patient_id, if_version)
        _apply_patient_fields(pt, changes)
        await _patient_children(db, patient_id, changes)
        return await _written(db, pt)

    async def add_patient_identifier(self, db: AsyncSession, patient_id: uuid.UUID,
                                     identifier: IdentifierIn, *, if_version: int | None = None
                                     ) -> ChildWritten:
        if identifier.type_code == "MR":
            raise InvalidInput("an MR identifier comes only from admin.next_mrn() (D41)")
        await _refuse_mrn_system(db, [identifier])
        pt = await _locked(db, Patient, patient_id, if_version)
        row = _identifier({"patient_id": patient_id}, identifier)
        db.add(row)
        written = await _written(db, pt)          # flushes, which gives the row its ID
        return ChildWritten(row.id, written)

    async def set_patient_security(self, db: AsyncSession, patient_id: uuid.UUID,
                                   labels: frozenset[str], *, if_version: int | None = None
                                   ) -> Written:
        if not labels <= _RESTRICTED:
            raise InvalidInput("a chart is restricted with R or V, or unrestricted with none")
        pt = await _locked(db, Patient, patient_id, if_version)
        pt.meta_security = ([label for label in pt.meta_security
                             if label not in _CONFIDENTIALITY] + sorted(labels))
        return await _written(db, pt)

    # ------------------------------------------------------------------------- RelatedPerson
    async def create_related_person(self, db: AsyncSession, data: RelatedPersonIn) -> Written:
        person = RelatedPerson(patient_id=data.patient_id, active=data.active, gender=data.gender,
                               birth_date=data.birth_date)
        db.add(person)
        await db.flush()
        await _person_children(db, person.id, data)
        return await _written(db, person)

    async def update_related_person(self, db: AsyncSession, related_person_id: uuid.UUID,
                                    changes: RelatedPersonChanges, *, if_version: int
                                    ) -> Written:
        person = await _locked(db, RelatedPerson, related_person_id, if_version)
        for field in ("active", "gender", "birth_date"):
            if _given(getattr(changes, field)):
                setattr(person, field, getattr(changes, field))
        await _person_children(db, related_person_id, changes)
        return await _written(db, person)

    # ------------------------------------------------------------------------- Coverage
    async def create_coverage(self, db: AsyncSession, data: CoverageIn) -> Written:
        cov = Coverage(status=data.status, beneficiary_patient_id=data.beneficiary_patient_id,
                       ext_accept_assignment=data.accept_assignment,
                       **{f: getattr(data, f) for f in _COVERAGE_FIELDS})
        db.add(cov)
        await db.flush()
        db.add(CoveragePayor(coverage_id=cov.id, payer_id=data.payer_id))
        await _coverage_children(db, cov.id, data)
        return await _written(db, cov)

    async def update_coverage(self, db: AsyncSession, coverage_id: uuid.UUID,
                              changes: CoverageChanges, *, if_version: int) -> Written:
        cov = await _locked(db, Coverage, coverage_id, if_version)
        if cov.status == "entered-in-error":          # never used again (D45)
            raise InvalidTransition(cov.status)
        for field in _COVERAGE_FIELDS:
            if _given(getattr(changes, field)):
                setattr(cov, field, getattr(changes, field))
        if _given(changes.accept_assignment):
            cov.ext_accept_assignment = changes.accept_assignment
        await _coverage_children(db, coverage_id, changes)
        return await _written(db, cov)

    async def coverage_entered_in_error(self, db: AsyncSession, coverage_id: uuid.UUID,
                                        reason: Reason, *, if_version: int | None = None
                                        ) -> Written:
        if not reason.text.strip():
            raise InvalidInput("entered-in-error needs a reason")
        cov = await _locked(db, Coverage, coverage_id, if_version)
        if cov.status == "entered-in-error":
            raise InvalidTransition(cov.status)
        cov.status = "entered-in-error"
        written = await _written(db, cov)
        user = await _current_user(db)
        code = reason.code or Coded()
        prov = Provenance(target_resource_type="Coverage", target_id=coverage_id,
                          target_version_id=written.version, recorded=datetime.now(UTC),
                          activity_system=systems.V3_DATA_OPERATION, activity_code="NULLIFY",
                          reason_system=code.system, reason_code=code.code,
                          reason_display=code.display, reason_text=reason.text)
        db.add(prov)
        await db.flush()
        db.add(ProvenanceAgent(provenance_id=prov.id, type_system=systems.PROVENANCE_AGENT_TYPE,
                               type_code="author", who_practitioner_id=user.practitioner_id,
                               who_display=None if user.practitioner_id else user.display_name))
        await db.flush()
        return written

    # ------------------------------------------------------------------------- Consent
    async def create_consent(self, db: AsyncSession, data: ConsentIn) -> Written:
        consent = Consent(
            status=data.status, patient_id=data.patient_id, date_time=data.date_time,
            scope_system=systems.CONSENT_SCOPE,
            scope_code=_SCOPE_OF_KIND.get(data.kind, _DEFAULT_SCOPE),
            provision_type=data.provision_type, ext_kind=data.kind,
            ext_signature_method=data.signature_method, ext_policy_version=data.policy_version,
            ext_grantor_related_person_id=data.grantor_related_person_id,
            source_attachment_binary_object_id=data.source_attachment_binary_object_id,
            source_document_reference_id=data.source_document_reference_id,
            entry_source=data.entry_source)
        db.add(consent)
        await db.flush()
        db.add_all(ConsentCategory(consent_id=consent.id, category_system=c.system,
                                   category_code=c.code, category_display=c.display,
                                   category_text=c.text) for c in data.categories)
        if data.performer_patient_id or data.performer_related_person_id:
            db.add(ConsentPerformer(consent_id=consent.id, patient_id=data.performer_patient_id,
                                    related_person_id=data.performer_related_person_id))
        if data.verified or data.verified_with_patient_id or data.verified_with_related_person_id:
            db.add(ConsentVerification(
                consent_id=consent.id, verified=data.verified,
                verified_with_patient_id=data.verified_with_patient_id,
                verified_with_related_person_id=data.verified_with_related_person_id,
                verification_date=data.verification_date))
        return await _written(db, consent)


__all__ = [
    "UNSET", "ChildWritten", "Coded", "ConsentIn", "CostIn", "CoverageChanges", "CoverageClassIn",
    "CoverageIn", "EmployerIn", "FhirStore", "IdentifierIn", "InvalidInput", "InvalidTransition",
    "Name", "PatientChanges", "PatientIn", "PostalAddress", "RaceOrEthnicity", "Reason",
    "RelatedPersonChanges", "RelatedPersonIn", "ResourceNotFound", "SqlFhirStore", "StaleVersion",
    "Telecom", "Written",
]
