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
- A patient has exactly one MR identifier (D41). ``create_patient`` takes the next one from
  ``admin.next_mrn()`` itself, unless an import (``entry_source`` ``imported``) supplies the
  MRN it had in its source system; no other helper adds or changes one. No identifier we did
  not issue may use the practice's MRN system, so a value the counter hasn't reached can never
  block a registration.
- ``create_consent`` makes the patient's earlier active consent of the same kind ``inactive``,
  in the same transaction: the latest one is the one in force.
- Input the API should refuse with ``422`` raises ``InvalidInput`` (a ``ValueError``);
  ``InvalidTransition`` is a change the record's state doesn't allow. ``RuntimeError`` is a
  programming error, such as a write with no signed-in user to record.
"""

from __future__ import annotations

import enum
import hashlib
import html
import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Protocol, TypeIs

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.errors import db_error_detail
from app.db.models import systems
from app.db.models.admin.ai import AISuggestion
from app.db.models.admin.core import AppUser, MrnCounter
from app.db.models.admin.medication import ErxTransaction, PatientPharmacy, Pharmacy
from app.db.models.admin.platform import DuplicateCandidate, PatientMerge
from app.db.models.admin.practice import CdsRule
from app.db.models.admin.rcm import Employer
from app.db.models.enums import ErxTransactionStatus
from app.db.models.fhir.clinical import (
    AllergyIntolerance,
    AllergyIntoleranceReaction,
    AllergyReactionManifestation,
    Condition,
    ConditionCategory,
    FamilyMemberHistory,
    FamilyMemberHistoryCondition,
    Observation,
    ObservationCategory,
    ObservationComponent,
    Procedure,
    ProcedureBodySite,
)
from app.db.models.fhir.datatypes import (
    Address,
    Annotation,
    ContactPoint,
    Dosage,
    HumanName,
    Identifier,
)
from app.db.models.fhir.directory import (
    Patient,
    PatientCommunication,
    PatientLink,
    PatientRaceEthnicity,
    Practitioner,
    RelatedPerson,
    RelatedPersonRelationship,
)
from app.db.models.fhir.documents import (
    Composition,
    CompositionAttester,
    CompositionAuthor,
    CompositionRelatesTo,
    CompositionSection,
)
from app.db.models.fhir.medication import (
    DetectedIssue,
    DetectedIssueImplicated,
    DetectedIssueMitigation,
    MedicationRequest,
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
    ProvenanceSignature,
)
from app.db.models.fhir.workflow import (
    Encounter,
    EncounterDiagnosis,
    EncounterParticipant,
    EncounterReason,
    EncounterStatusHistory,
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


class PatientMerged(InvalidTransition):
    """A write naming a patient merged into another (D103): the API's ``409 patient-merged``.
    ``surviving_patient_id`` is the chart to write to instead."""

    def __init__(self, surviving_patient_id: uuid.UUID) -> None:
        super().__init__("merged")
        self.surviving_patient_id = surviving_patient_id


class InvalidInput(ValueError):
    """Input the API refuses with 422; ``reason`` says why, in words for the problem detail, and
    ``field``, when set, names the input it is about (``reason``, ``order``), for the error's
    pointer."""

    def __init__(self, reason: str, *, field: str | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.field = field


class CoverageOrderTaken(InvalidInput):
    """Another coverage of the patient has this order for an overlapping period
    (``ex_coverage_order_no_overlap``, migration 0012): the API's 422 at ``/order``."""

    def __init__(self) -> None:
        super().__init__("another coverage has this order for an overlapping period",
                         field="order")


class SignRefused(InvalidInput):
    """Signing refused (422 business-rule-violation): one ``(pointer, code)`` per refusal, each
    a JSON Pointer into the prescription as GET reads it: ``required`` at ``/dosageText``,
    ``/quantity`` or ``/pharmacyId``; ``safety-check-stale`` at ``/alerts``;
    ``override-required`` at ``/alerts/{i}``, ``i`` the alert's index in
    ``prescription_alert_ids()``."""

    def __init__(self, errors: tuple[tuple[str, str], ...]) -> None:
        super().__init__("; ".join(f"{code} at {pointer}" for pointer, code in errors))
        self.errors = errors


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
    identifiers: tuple[IdentifierIn, ...] = ()  # no MR, except the one an import supplies
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
    date_time: datetime
    #: Leave empty: the helper sets the kind's category (_CONSENT_OF_KIND). One given must be
    #: exactly the kind's.
    categories: tuple[Coded, ...] = ()
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


# ------------------------------------------------------- visit data types (batch 2, Thu 5 Nov)
@dataclass(frozen=True)
class ParticipantIn:
    practitioner_id: uuid.UUID
    role: str = "PPRF"  # v3 ParticipationType: PPRF primary performer, ATND attender, SPRF …


@dataclass(frozen=True)
class EncounterIn:
    patient_id: uuid.UUID
    facility_id: uuid.UUID
    class_code: str = "AMB"  # v3 ActCode: AMB ambulatory, VR virtual
    status: str = "arrived"  # check-in creates it arrived (D16)
    appointment_id: uuid.UUID | None = None
    started_at: datetime | None = None
    service_provider_organization_id: uuid.UUID | None = None
    participants: tuple[ParticipantIn, ...] = ()
    reasons: tuple[Coded, ...] = ()
    self_pay: bool = False  # CheckInRequest.selfPay (#74)
    place_of_service_code: str | None = None


@dataclass(frozen=True)
class Measured:
    value: Decimal
    unit: str  # UCUM code as entered, e.g. mm[Hg], [degF], [lb_av] (D69: never converted)


@dataclass(frozen=True)
class VitalIn:
    type: str  # the contract's VitalType: blood-pressure, heart-rate, …
    value: Measured | None = None
    systolic: Measured | None = None  # blood-pressure only
    diastolic: Measured | None = None


@dataclass(frozen=True)
class ReactionIn:
    manifestations: tuple[Coded, ...]
    severity: str | None = None  # mild | moderate | severe
    description: str | None = None
    onset: datetime | None = None


@dataclass(frozen=True)
class AllergyIn:
    patient_id: uuid.UUID
    code: Coded
    clinical_status: str = "active"
    verification_status: str = "confirmed"
    encounter_id: uuid.UUID | None = None
    type: str | None = None  # allergy | intolerance
    categories: tuple[str, ...] = ()  # food | medication | environment | biologic
    criticality: str | None = None  # low | high | unable-to-assess
    onset_date_time: datetime | None = None
    reactions: tuple[ReactionIn, ...] = ()
    note: str | None = None
    entry_source: str = "clinician"


@dataclass(frozen=True)
class AllergyChanges:
    code: Coded | _Unset = UNSET
    clinical_status: str | _Unset = UNSET
    verification_status: str | _Unset = UNSET
    type: str | None | _Unset = UNSET
    categories: tuple[str, ...] | _Unset = UNSET
    criticality: str | None | _Unset = UNSET
    onset_date_time: datetime | None | _Unset = UNSET
    reactions: tuple[ReactionIn, ...] | _Unset = UNSET
    note: str | None | _Unset = UNSET


@dataclass(frozen=True)
class DiagnosisIn:
    code: Coded  # ICD-10-CM or SNOMED CT (the database refuses other systems)
    rank: int | None = None  # None: after the encounter's last diagnosis
    verification_status: str = "confirmed"
    onset_date_time: datetime | None = None
    entry_source: str = "clinician"


@dataclass(frozen=True)
class ProblemIn:
    """A problem on the patient's list (US Core Condition, category ``problem-list-item``).
    ``onset`` and ``abatement`` are dates as the contract's ``PartialDate`` gives them:
    ``YYYY``, ``YYYY-MM`` or ``YYYY-MM-DD``."""
    patient_id: uuid.UUID
    code: Coded  # ICD-10-CM or SNOMED CT (the database refuses other systems)
    clinical_status: str = "active"
    verification_status: str = "confirmed"
    onset: str | None = None
    abatement: str | None = None
    note: str | None = None
    encounter_id: uuid.UUID | None = None
    entry_source: str = "clinician"


@dataclass(frozen=True)
class ProblemChanges:
    """The code never changes: a wrong code is marked entered-in-error and the right one added."""
    clinical_status: str | _Unset = UNSET
    verification_status: str | _Unset = UNSET
    onset: str | None | _Unset = UNSET
    abatement: str | None | _Unset = UNSET
    note: str | None | _Unset = UNSET


@dataclass(frozen=True)
class FamilyConditionIn:
    code: Coded  # SNOMED CT or ICD-10-CM, or text only
    onset_age: int | None = None  # years
    contributed_to_death: bool | None = None


@dataclass(frozen=True)
class FamilyHistoryIn:
    """One relative's history (FamilyMemberHistory, FRS FR-PAT-03). ``conditions``, or status
    ``health-unknown``. ``sex`` is an AdministrativeGender code, stored as text: that code
    system isn't registered."""
    patient_id: uuid.UUID
    relationship: Coded  # v3 RoleCode: MTH, FTH, SIS ...
    status: str = "completed"
    sex: str | None = None
    deceased: bool | None = None
    conditions: tuple[FamilyConditionIn, ...] = ()
    note: str | None = None
    entry_source: str = "clinician"


@dataclass(frozen=True)
class SocialHistoryIn:
    """A social-history Observation. ``value`` is exactly one of a code, a quantity or text;
    ``effective`` a ``PartialDate``, today when absent."""
    patient_id: uuid.UUID
    code: Coded  # LOINC: what was asked
    value: Coded | Measured | str
    effective: str | None = None
    encounter_id: uuid.UUID | None = None
    entry_source: str = "clinician"


@dataclass(frozen=True)
class SurgicalHistoryIn:
    """A past surgery: a completed Procedure with category SNOMED CT 387713003 (D73)."""
    patient_id: uuid.UUID
    code: Coded
    performed: str  # PartialDate; US Core needs one on a completed procedure
    body_site: Coded | None = None
    note: str | None = None
    encounter_id: uuid.UUID | None = None
    entry_source: str = "clinician"


@dataclass(frozen=True)
class MergeWritten:
    merge_id: uuid.UUID
    surviving: Written  # both patients' versions move: the link rows are their children
    merged: Written


@dataclass(frozen=True)
class MergeStatus:
    """A merge as ``listPatientMerges`` shows it (D51)."""
    id: uuid.UUID
    surviving_patient_id: uuid.UUID
    merged_patient_id: uuid.UUID
    duplicate_id: uuid.UUID | None
    performed_at: datetime
    performed_by_user_id: uuid.UUID
    undone_at: datetime | None
    undone_by_user_id: uuid.UUID | None
    undo_blocked_reason: str | None  # already-undone, later-merge, or None: undo allowed


@dataclass(frozen=True)
class DiagnosisWritten:
    condition: Written
    encounter: Written  # the encounter's new version: the link is its child row
    rank: int


# ------------------------------------------------- prescription data types (D97, demo step 9)
@dataclass(frozen=True)
class DispenseQuantity:
    value: Decimal
    unit: str  # capsule, tablet, mL


@dataclass(frozen=True)
class PreferredPharmacy:
    """The patient's default pharmacy (D50): what ``PreferredPharmacy`` and ``Patient``'s
    ``preferredPharmacy`` show. ``updated_at`` is when it was chosen."""
    pharmacy_id: uuid.UUID
    name: str
    ncpdp_id: str
    phone: str | None
    address_line: str | None
    city: str | None
    state: str | None
    postal_code: str | None
    updated_at: datetime


@dataclass(frozen=True)
class MedicationIn:
    """A medication the patient already takes, for the list (MedicationCreate; D28): a
    MedicationRequest with intent ``plan``, reported. Prescriptions reach the list by signing."""
    patient_id: uuid.UUID
    medication: Coded  # RxNorm, or text alone
    dosage_text: str | None = None
    status: str = "active"  # active | completed | stopped
    note: str | None = None
    encounter_id: uuid.UUID | None = None  # the visit it was recorded at (rooming)


@dataclass(frozen=True)
class PrescriptionIn:
    """A draft prescription: a MedicationRequest with intent ``order`` (PrescriptionCreate)."""
    patient_id: uuid.UUID
    medication: Coded  # RxNorm (Current Prescribable Content), or text alone
    encounter_id: uuid.UUID | None = None
    dosage_text: str | None = None  # the sig; required to sign
    quantity: DispenseQuantity | None = None  # required to sign
    days_supply: int | None = None
    refills: int | None = None
    substitution_allowed: bool | None = None
    pharmacy_id: uuid.UUID | None = None  # admin.pharmacy; required to sign
    note_to_pharmacy: str | None = None
    dea_schedule: str | None = None  # CII to CV, the RxNorm concept's dea_schedule property


@dataclass(frozen=True)
class PrescriptionChanges:
    medication: Coded | _Unset = UNSET
    dosage_text: str | None | _Unset = UNSET
    quantity: DispenseQuantity | None | _Unset = UNSET
    days_supply: int | None | _Unset = UNSET
    refills: int | None | _Unset = UNSET
    substitution_allowed: bool | None | _Unset = UNSET
    pharmacy_id: uuid.UUID | None | _Unset = UNSET
    note_to_pharmacy: str | None | _Unset = UNSET
    dea_schedule: str | None | _Unset = UNSET


@dataclass(frozen=True)
class AlertIn:
    """One alert of a safety check (the contract's SafetyAlert), from a fixed rule (D99)."""
    rule_code: str  # admin.cds_rule.code of the rule that raised it (the clinic's, or platform)
    kind: str  # allergy | duplicate-medication | interaction (later, Q13)
    severity: str  # info | warning | high; high needs an override before signing
    message: str
    allergy_id: uuid.UUID | None = None  # behind an allergy alert
    medication_id: uuid.UUID | None = None  # the list entry behind a duplicate-medication alert


@dataclass(frozen=True)
class SafetyCheckWritten:
    prescription_id: uuid.UUID
    checked_at: datetime  # safetyCheckedAt, the database's now()
    checked_version: int  # the prescription's version, unchanged by the check (A58)
    alert_ids: tuple[uuid.UUID, ...]  # in the order given


@dataclass(frozen=True)
class TransmissionWritten:
    id: uuid.UUID  # the NewRx admin.erx_transaction
    status: str  # queued | sent | accepted | rejected | error
    updated_at: datetime


# --------------------------------------------------------- note data types (D73, demo step 8)
@dataclass(frozen=True)
class SectionIn:
    code: str  # LOINC section code
    title: str
    text: str = ""  # as typed; stored escaped in one XHTML div (section_text() reads it back)


@dataclass(frozen=True)
class NoteIn:
    """A draft note (``preliminary``) on an encounter; the template's sections, copied in by the
    service, or one free-text section."""
    encounter_id: uuid.UUID
    note_type: Coded  # LOINC, e.g. 11506-3 progress note
    title: str
    sections: tuple[SectionIn, ...]
    template_id: uuid.UUID | None = None


@dataclass(frozen=True)
class SectionText:
    id: uuid.UUID  # composition_section.id
    text: str


@dataclass(frozen=True)
class NoteChanges:
    """Autosave (NotePatch): sections are merged by id, never replaced."""
    title: str | _Unset = UNSET
    sections: tuple[SectionText, ...] = ()


@dataclass(frozen=True)
class AddendumWritten:
    addendum: Written  # the new, signed Composition that appends to the note
    note: Written  # the note's new version (now amended)


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
                                   labels: frozenset[str], *, if_version: int | None = None,
                                   reason: Reason | None = None) -> Written:
        """Restrict (R or V) or unrestrict (empty): replaces the confidentiality labels only.
        With a ``reason``, also writes the change's Provenance (``UPDATE``), as a merge does for
        the labels it changes; without one, none (the API's restriction is audited by core)."""
        ...

    async def set_preferred_pharmacy(self, db: AsyncSession, patient_id: uuid.UUID,
                                     pharmacy_id: uuid.UUID, *, if_version: int) -> Written:
        """Makes the pharmacy the patient's default (``admin.patient_pharmacy``, one default per
        patient) and returns the patient's new version: the preferred pharmacy is part of the
        patient record, so the patient's version and ``_history`` move. An earlier choice stays as
        a non-default row. ``ResourceNotFound`` for a pharmacy not in the directory,
        ``InvalidInput`` for an inactive one. The same pharmacy again changes nothing."""
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

    # Encounter (encounter, encounter_participant, encounter_reason, encounter_status_history)
    async def create_encounter(self, db: AsyncSession, data: EncounterIn) -> Written: ...

    async def set_encounter_status(self, db: AsyncSession, encounter_id: uuid.UUID, status: str,
                                   *, at: datetime | None = None, reason: Reason | None = None,
                                   if_version: int | None = None) -> Written:
        """Records the change in the status history. Starting sets the start time, finishing
        the end time. entered-in-error needs a reason and writes its Provenance (D55)."""
        ...

    # Vitals: one vital-signs Observation per entry, all in one transaction (VitalsCreate)
    async def record_vitals(self, db: AsyncSession, patient_id: uuid.UUID,
                            encounter_id: uuid.UUID | None, vitals: tuple[VitalIn, ...], *,
                            effective_at: datetime | None = None) -> list[Written]: ...

    async def vital_entered_in_error(self, db: AsyncSession, observation_id: uuid.UUID,
                                     reason: Reason, *, if_version: int | None = None
                                     ) -> Written: ...

    # AllergyIntolerance (allergy_intolerance, its reactions and manifestations, a note)
    async def create_allergy(self, db: AsyncSession, data: AllergyIn) -> Written: ...

    async def update_allergy(self, db: AsyncSession, allergy_id: uuid.UUID,
                             changes: AllergyChanges, *, if_version: int) -> Written: ...

    async def allergy_entered_in_error(self, db: AsyncSession, allergy_id: uuid.UUID,
                                       reason: Reason, *, if_version: int | None = None
                                       ) -> Written: ...

    # Encounter diagnoses: a Condition (encounter-diagnosis) and its ranked link (D24)
    async def add_encounter_diagnosis(self, db: AsyncSession, encounter_id: uuid.UUID,
                                      data: DiagnosisIn) -> DiagnosisWritten: ...

    async def remove_encounter_diagnosis(self, db: AsyncSession, encounter_id: uuid.UUID,
                                         condition_id: uuid.UUID, reason: Reason) -> Written:
        """Before signing (D24): the Condition becomes entered-in-error with its Provenance, and
        its link goes, freeing its rank; the ranks after it close up. Returns the encounter.
        ``InvalidTransition`` if the Condition is already entered-in-error."""
        ...

    async def diagnosis_entered_in_error(self, db: AsyncSession, condition_id: uuid.UUID,
                                         reason: Reason, *, if_version: int | None = None
                                         ) -> Written:
        """After signing (D14, D24): the Condition becomes entered-in-error with its Provenance;
        its rank link stays, so the signed visit keeps its record of what was diagnosed. Returns
        the Condition. It takes only the Condition: the caller checks first that it is an
        ``encounter-diagnosis`` of the visit named in the request, and that the visit is signed."""
        ...

    # The problem list: a Condition (problem-list-item), FRS FR-PAT-03
    async def create_problem(self, db: AsyncSession, data: ProblemIn) -> Written:
        """``InvalidInput`` for a malformed date (``field`` ``onsetDate`` or ``abatementDate``),
        an end before the start, an end on a problem that is still active (FHIR con-4), or an
        encounter that isn't this patient's live visit; ``ResourceNotFound`` for a patient the
        session can't see."""
        ...

    async def update_problem(self, db: AsyncSession, problem_id: uuid.UUID,
                             changes: ProblemChanges, *, if_version: int) -> Written:
        """``InvalidTransition`` once entered-in-error; ``ResourceNotFound`` for a Condition
        that isn't on a problem list (an encounter diagnosis has its own helpers)."""
        ...

    async def problem_entered_in_error(self, db: AsyncSession, problem_id: uuid.UUID,
                                       reason: Reason, *, if_version: int | None = None
                                       ) -> Written:
        """Entered-in-error with its Provenance; nothing is deleted (D14). The same errors as
        ``update_problem``."""
        ...

    # Duplicates and merges by link (D103): no record moves
    async def merge_patients(self, db: AsyncSession, duplicate_id: uuid.UUID,
                             surviving_patient_id: uuid.UUID, reason: str) -> MergeWritten:
        """``InvalidTransition`` for a pair that isn't open; ``PatientMerged`` when either
        patient is already merged away; ``InvalidInput`` at ``survivingPatientId`` for a
        patient outside the pair, at ``reason`` for a blank one."""
        ...

    async def undo_patient_merge(self, db: AsyncSession, merge_id: uuid.UUID, reason: str
                                 ) -> MergeWritten:
        """``InvalidTransition(already-undone | later-merge)``. The reason is checked, not
        stored: no column holds it, so it goes in the request's audit row (core)."""
        ...

    async def dismiss_duplicate(self, db: AsyncSession, duplicate_id: uuid.UUID, reason: str
                                ) -> None:
        """D46: the pair becomes ``not-duplicate``; ``InvalidTransition`` unless it is open."""
        ...

    # Family, social and surgical history (FRS FR-PAT-03): insert-only, corrected by
    # entered-in-error and a new entry
    async def create_family_history(self, db: AsyncSession, data: FamilyHistoryIn) -> Written:
        """``InvalidInput`` at ``conditions`` for none without status ``health-unknown``, or at
        ``status``/``sex`` for an unknown value; ``ResourceNotFound`` for an unseen patient."""
        ...

    async def family_history_entered_in_error(self, db: AsyncSession, history_id: uuid.UUID,
                                              reason: Reason, *, if_version: int | None = None
                                              ) -> Written: ...

    async def record_social_history(self, db: AsyncSession, data: SocialHistoryIn) -> Written:
        """``InvalidInput`` for a code that isn't LOINC, a malformed or future
        ``effectiveDate``, or an encounter that isn't this patient's live visit."""
        ...

    async def social_history_entered_in_error(self, db: AsyncSession, observation_id: uuid.UUID,
                                              reason: Reason, *, if_version: int | None = None
                                              ) -> Written:
        """``ResourceNotFound`` for an Observation that isn't social history."""
        ...

    async def create_surgical_history(self, db: AsyncSession, data: SurgicalHistoryIn
                                      ) -> Written:
        """``InvalidInput`` at ``performedDate`` for a malformed or future date."""
        ...

    async def surgical_history_entered_in_error(self, db: AsyncSession, procedure_id: uuid.UUID,
                                                reason: Reason, *, if_version: int | None = None
                                                ) -> Written:
        """``ResourceNotFound`` for a Procedure that isn't surgical history."""
        ...

    # The medication list: a reported MedicationRequest, intent plan (D28; demo step 7)
    async def record_medication(self, db: AsyncSession, data: MedicationIn) -> Written: ...

    # Prescriptions: MedicationRequest, intent order (medication_request, dosage), D97
    async def create_prescription(self, db: AsyncSession, data: PrescriptionIn) -> Written: ...

    async def update_prescription(self, db: AsyncSession, prescription_id: uuid.UUID,
                                  changes: PrescriptionChanges, *, if_version: int
                                  ) -> Written:
        """A draft only (InvalidTransition otherwise: 409 record-locked once signed). Any change
        is a new version, so the safety check must run again."""
        ...

    async def prescription_entered_in_error(self, db: AsyncSession, prescription_id: uuid.UUID,
                                            reason: Reason, *, if_version: int | None = None
                                            ) -> Written:
        """A draft only; its Provenance is written and its alerts are cancelled."""
        ...

    async def record_safety_check(self, db: AsyncSession, prescription_id: uuid.UUID,
                                  alerts: tuple[AlertIn, ...], *, if_version: int
                                  ) -> SafetyCheckWritten:
        """The alerts of a check run on version ``if_version`` of a draft, as DetectedIssue rows;
        the earlier check's alerts are cancelled. Doesn't change the draft's version (A58)."""
        ...

    async def override_alert(self, db: AsyncSession, alert_id: uuid.UUID, reason: str
                             ) -> Written:
        """The override and its reason (a mitigation by the current user's practitioner).
        Returns the alert's DetectedIssue; the draft's version doesn't change (A58)."""
        ...

    async def sign_prescription(self, db: AsyncSession, prescription_id: uuid.UUID, *,
                                if_version: int, integration_message_id: uuid.UUID | None = None
                                ) -> Written:
        """Signs and locks the draft, writes its Provenance and the NewRx transmission
        (``queued``; ``integration_message_id`` is the outbox message), in the transaction."""
        ...

    async def set_transmission_status(self, db: AsyncSession, prescription_id: uuid.UUID,
                                      status: str, *, message: str | None = None,
                                      vendor_message_id: str | None = None
                                      ) -> TransmissionWritten:
        """The NewRx's way to the pharmacy (``/hooks/erx``). The same status again changes
        nothing. Doesn't change the prescription, which is signed and frozen."""
        ...

    # Notes: Composition (composition, composition_author, composition_section, attesters)
    async def create_note(self, db: AsyncSession, data: NoteIn) -> Written: ...

    async def update_note(self, db: AsyncSession, note_id: uuid.UUID, changes: NoteChanges, *,
                          if_version: int) -> Written:
        """Autosave of a draft. Every committed save is a version (D73); a signed note raises
        InvalidTransition (409 record-locked)."""
        ...

    async def sign_note(self, db: AsyncSession, note_id: uuid.UUID, *, if_version: int,
                        cosigner_practitioner_id: uuid.UUID | None = None) -> Written:
        """final, with a legal attester and its Provenance; frozen from then on. With the
        co-signer the matching co-sign rule names, ``cosignStatus`` becomes ``pending``."""
        ...

    async def add_note_addendum(self, db: AsyncSession, note_id: uuid.UUID, text: str, *,
                                if_version: int) -> AddendumWritten:
        """A new signed Composition that appends to the signed note, which becomes amended; a
        returned note is pending again."""
        ...

    async def cosign_note(self, db: AsyncSession, note_id: uuid.UUID, *, if_version: int
                          ) -> Written:
        """By the named co-signer, while pending: a professional attester and its Provenance;
        ``cosigned``."""
        ...

    async def return_note_to_author(self, db: AsyncSession, note_id: uuid.UUID, comment: str,
                                    *, if_version: int) -> Written:
        """By the named co-signer, while pending: ``returned`` with the comment. The note stays
        signed and frozen; the author answers with an addendum (D73)."""
        ...

    async def note_entered_in_error(self, db: AsyncSession, note_id: uuid.UUID, reason: Reason,
                                    *, if_version: int | None = None) -> Written: ...


# ---------------------------------------------------------------- the implementation
#: The D39 coded demographics, each patient.ext_<name>_{system,code,display,text}.
_D39 = ("gender_identity", "sexual_orientation", "occupation", "industry", "tribal_affiliation")
#: v3 Confidentiality labels in meta_security. set_patient_security replaces these and keeps the
#: sensitivity labels (PSY, SUD, …).
_CONFIDENTIALITY = frozenset({"L", "M", "N", "R", "V"})
_RESTRICTED = frozenset({"R", "V"})
#: Confidentiality, strictest first (HL7 v3 Confidentiality): a merge keeps the stricter.
_CONFIDENTIALITY_ORDER = ("V", "R", "N", "M", "L")


def merged_labels(*charts: list[str]) -> list[str]:
    """The security labels both charts of a merge carry (D103 with Thulasi's #277 review): the
    strictest confidentiality of either (V over R over N over M over L), and every sensitivity
    label (PSY, SUD, ...) of either, so no part of the person's chart is readable under a
    weaker rule than any part was."""
    labels = {label for chart in charts for label in chart}
    strictest = next((c for c in _CONFIDENTIALITY_ORDER if c in labels), None)
    return sorted(labels - _CONFIDENTIALITY) + ([strictest] if strictest else [])
#: Consent.scope (consentscope, required by FHIR) and Consent.category (the R4 Consent Category
#: value set) by the practice's consent kind: one fixed set per kind, agreed on #88 (Vimal).
#: financial is LOINC 59284-0 only (a release to the payer would be its own kind);
#: ambient-recording is a privacy consent (information collection).
_PATIENT_CONSENT = Coded(system=systems.LOINC, code="59284-0", display="Patient Consent")
_RELEASE_OF_INFORMATION = Coded(system=systems.LOINC, code="64292-6",
                                display="Release of information consent")
_CONSENT_OF_KIND: dict[str, tuple[str, tuple[Coded, ...]]] = {
    "treatment": ("treatment", (_PATIENT_CONSENT,)),
    "telehealth": ("treatment", (_PATIENT_CONSENT,)),
    "financial": ("treatment", (_PATIENT_CONSENT,)),
    "privacy-notice": ("patient-privacy", (
        Coded(system=systems.CONSENT_CATEGORY, code="npp",
              display="Notice of Privacy Practices"),
        Coded(system=systems.LOINC, code="57016-8", display="Privacy policy acknowledgment"))),
    "information-sharing": ("patient-privacy", (
        _RELEASE_OF_INFORMATION,
        Coded(system=systems.V3_ACT_CODE, code="IDSCL", display="information disclosure"))),
    "ambient-recording": ("patient-privacy", (
        Coded(system=systems.V3_ACT_CODE, code="ICOL", display="information collection"),)),
    "research": ("research", (
        Coded(system=systems.CONSENT_CATEGORY, code="research", display="Research"),)),
}

def _given[T](value: T | _Unset) -> TypeIs[T]:
    return value is not UNSET


async def _locked[R: (Patient, RelatedPerson, Coverage, Encounter, Condition, AllergyIntolerance,
                     Observation, MedicationRequest, DetectedIssue, Composition,
                     FamilyMemberHistory, Procedure)](
        db: AsyncSession, model: type[R], row_id: uuid.UUID, if_version: int | None) -> R:
    row = (await db.execute(select(model).where(model.id == row_id).with_for_update()
                            .execution_options(populate_existing=True))).scalar_one_or_none()
    if row is None:
        raise ResourceNotFound
    if if_version is not None and row.meta_version_id != if_version:
        raise StaleVersion(row.meta_version_id)
    return row


type _Resource = (Patient | RelatedPerson | Coverage | Consent | Encounter | Condition
                  | AllergyIntolerance | Observation | MedicationRequest | DetectedIssue
                  | Composition | FamilyMemberHistory | Procedure)


async def _written(db: AsyncSession, row: _Resource) -> Written:
    """Records who changed the row last (``app.current_user_id``), flushes, then reads back the
    version the database gave the row in this transaction (child rows bump their parent through
    its touch trigger)."""
    user_id = await _user_id(db)
    if user_id is not None:
        row.updated_by_user_id = user_id
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
    say with a value the counter will reach later, would make that registration fail. An
    imported MRN keeps its source system."""
    if not identifiers:
        return
    mrn_system = (await db.execute(select(MrnCounter.system))).scalar_one_or_none()
    if mrn_system is not None and any(i.system == mrn_system for i in identifiers):
        raise InvalidInput("only an MR identifier uses the practice's MRN system (D41)")


async def _user_id(db: AsyncSession) -> uuid.UUID | None:
    value = (await db.execute(text(
        "SELECT NULLIF(current_setting('app.current_user_id', true), '')"))).scalar_one()
    return uuid.UUID(value) if value else None


async def _new[R: (Patient, RelatedPerson, Coverage, Consent, Encounter, Condition, Observation,
                  AllergyIntolerance, MedicationRequest, DetectedIssue, Composition,
                  FamilyMemberHistory, Procedure)](
        db: AsyncSession, row: R) -> R:
    """A new resource row records who created it (``app.current_user_id``)."""
    row.created_by_user_id = await _user_id(db)
    return row


async def _db_now(db: AsyncSession) -> datetime:
    """The transaction's time, as the database records it (``now()``, the time the triggers
    give ``meta_last_updated``), so times this module writes compare with the database's."""
    now: datetime = (await db.execute(text("SELECT now()"))).scalar_one()
    return now


async def _current_user(db: AsyncSession) -> AppUser:
    user_id = (await db.execute(text(
        "SELECT NULLIF(current_setting('app.current_user_id', true), '')"))).scalar_one()
    user = (await db.execute(select(AppUser).where(AppUser.id == uuid.UUID(user_id))
                             )).scalar_one_or_none() if user_id else None
    if user is None:
        raise RuntimeError("no current user to record in the Provenance")
    return user


async def _nullify_provenance(db: AsyncSession, resource_type: str, written: Written,
                              reason: Reason) -> None:
    """The Provenance of an entered-in-error change: who (the current user's practitioner, or
    their name), why, and the version it applies to."""
    await _provenance(db, resource_type, written, (systems.V3_DATA_OPERATION, "NULLIFY", None),
                      reason=reason)


#: A signature's Provenance: the activity (v3 ParticipationType), the agent's type
#: (provenance-participant-type) and the signature's type (ASTM E1762-95).
_SIGNED = ((systems.V3_PARTICIPATION_TYPE, "LA", "legal authenticator"), "author",
           "1.2.840.10065.1.12.1.1")                                  # Author's Signature
_ADDENDUM_SIGNED = (_SIGNED[0], "author", "1.2.840.10065.1.12.1.15")   # Addendum Signature
_COSIGNED = ((systems.V3_PARTICIPATION_TYPE, "AUTHEN", "authenticator"), "attester",
             "1.2.840.10065.1.12.1.5")                                # Verification Signature


async def _provenance(db: AsyncSession, resource_type: str, written: Written,
                      activity: tuple[str, str, str | None], *, reason: Reason | None = None,
                      agent_type: str = "author",
                      signature: tuple[str, str] | None = None) -> None:
    """One Provenance for the version ``written`` of a resource, by the current user (their
    practitioner, or their name), recorded at the database's now(). ``signature`` is (the
    E1762-95 type, the SHA-256 of the signed content), and needs a practitioner."""
    user = await _current_user(db)
    code = reason.code if reason and reason.code else Coded()
    now = await _db_now(db)
    prov = Provenance(target_resource_type=resource_type, target_id=written.id,
                      target_version_id=written.version, recorded=now,
                      created_by_user_id=user.id, updated_by_user_id=user.id,
                      activity_system=activity[0], activity_code=activity[1],
                      activity_display=activity[2],
                      reason_system=code.system, reason_code=code.code,
                      reason_display=code.display, reason_text=reason.text if reason else None)
    db.add(prov)
    await db.flush()
    db.add(ProvenanceAgent(provenance_id=prov.id, type_system=systems.PROVENANCE_AGENT_TYPE,
                           type_code=agent_type, who_practitioner_id=user.practitioner_id,
                           who_display=None if user.practitioner_id else user.display_name))
    if signature is not None and user.practitioner_id is not None:
        db.add(ProvenanceSignature(provenance_id=prov.id, type_code=signature[0], when=now,
                                   who_practitioner_id=user.practitioner_id,
                                   data_sha256=signature[1]))
    await db.flush()


async def _signed_provenance(db: AsyncSession, resource_type: str, written: Written,
                             kind: tuple[tuple[str, str, str], str, str], digest: str) -> None:
    activity, agent_type, signature_type = kind
    await _provenance(db, resource_type, written, activity, agent_type=agent_type,
                      signature=(signature_type, digest))


async def _practitioner(db: AsyncSession) -> AppUser:
    """The current user, who must be a practitioner (a prescriber, a note's signer)."""
    user = await _current_user(db)
    if user.practitioner_id is None:
        raise InvalidInput("only a user linked to a practitioner may do this")
    return user


def _require_reason(reason: Reason) -> Reason:
    """The reason as stored: trimmed, and never blank (InvalidInput at ``reason``)."""
    trimmed = reason.text.strip()
    if not trimmed:
        raise InvalidInput("a reason is required", field="reason")
    return replace(reason, text=trimmed)


_COVERAGE_ORDER = "ex_coverage_order_no_overlap"


async def _flush_coverage(db: AsyncSession) -> None:
    """Flush a coverage row; an order clash with an overlapping period is CoverageOrderTaken."""
    try:
        await db.flush()
    except DBAPIError as exc:
        constraint = db_error_detail(exc).constraint or getattr(
            getattr(exc.orig, "__cause__", None), "constraint_name", None)
        if constraint == _COVERAGE_ORDER:
            raise CoverageOrderTaken() from exc
        raise


class SqlFhirStore:
    """The FhirStore the API uses: writes through the request's session, under RLS."""

    # ------------------------------------------------------------------------- Patient
    async def create_patient(self, db: AsyncSession, data: PatientIn) -> Written:
        mrns = [i for i in data.identifiers if i.type_code == "MR"]
        if len(mrns) > 1:
            raise InvalidInput("a patient has exactly one MRN (D41)")
        if mrns and data.entry_source != "imported":
            raise InvalidInput("an MRN comes only from admin.next_mrn(), unless an import "
                               "supplies one (D41)")
        await _refuse_mrn_system(db, data.identifiers)
        identifiers = list(data.identifiers)
        if not mrns:
            # Taken in this transaction: the counter row stays locked until it commits, and a
            # rollback gives the number back.
            row = (await db.execute(text("SELECT system, value FROM admin.next_mrn()"))).one()
            identifiers.append(IdentifierIn(system=row.system, value=row.value, type_code="MR",
                                            use="usual"))
        pt = Patient(active=data.active, entry_source=data.entry_source)
        _apply_patient_fields(pt, data)
        db.add(await _new(db, pt))
        await db.flush()
        await _patient_children(db, pt.id, data)
        db.add_all(_identifier({"patient_id": pt.id}, i) for i in identifiers)
        return await _written(db, pt)

    async def update_patient(self, db: AsyncSession, patient_id: uuid.UUID,
                             changes: PatientChanges, *, if_version: int) -> Written:
        await _not_merged(db, patient_id)
        pt = await _locked(db, Patient, patient_id, if_version)
        _apply_patient_fields(pt, changes)
        await _patient_children(db, patient_id, changes)
        return await _written(db, pt)

    async def add_patient_identifier(self, db: AsyncSession, patient_id: uuid.UUID,
                                     identifier: IdentifierIn, *, if_version: int | None = None
                                     ) -> ChildWritten:
        await _not_merged(db, patient_id)
        if identifier.type_code == "MR":
            raise InvalidInput("an MR identifier comes only from admin.next_mrn() (D41)")
        await _refuse_mrn_system(db, [identifier])
        pt = await _locked(db, Patient, patient_id, if_version)
        row = _identifier({"patient_id": patient_id}, identifier)
        db.add(row)
        written = await _written(db, pt)          # flushes, which gives the row its ID
        return ChildWritten(row.id, written)

    async def set_patient_security(self, db: AsyncSession, patient_id: uuid.UUID,
                                   labels: frozenset[str], *, if_version: int | None = None,
                                   reason: Reason | None = None) -> Written:
        await _not_merged(db, patient_id)
        if not labels <= _RESTRICTED:
            raise InvalidInput("a chart is restricted with R or V, or unrestricted with none")
        reason = _require_reason(reason) if reason is not None else None
        pt = await _locked(db, Patient, patient_id, if_version)
        pt.meta_security = ([label for label in pt.meta_security
                             if label not in _CONFIDENTIALITY] + sorted(labels))
        written = await _written(db, pt)
        if reason is not None:
            await _provenance(db, "Patient", written, (systems.V3_DATA_OPERATION, "UPDATE", None),
                              reason=reason)
        return written

    async def set_preferred_pharmacy(self, db: AsyncSession, patient_id: uuid.UUID,
                                     pharmacy_id: uuid.UUID, *, if_version: int) -> Written:
        await _not_merged(db, patient_id)
        pt = await _locked(db, Patient, patient_id, if_version)
        await _check_pharmacy(db, pharmacy_id)
        rows = {r.pharmacy_id: r for r in (await db.execute(
            select(PatientPharmacy).where(PatientPharmacy.patient_id == patient_id)
            .with_for_update())).scalars()}
        chosen = rows.get(pharmacy_id)
        if chosen is not None and chosen.is_default:
            return Written(pt.id, pt.meta_version_id, pt.meta_last_updated)
        user_id = await _user_id(db)
        for row in rows.values():                   # the old default first: one per patient
            if row.is_default:
                row.is_default, row.updated_by_user_id = False, user_id
        await db.flush()
        if chosen is None:
            db.add(PatientPharmacy(patient_id=patient_id, pharmacy_id=pharmacy_id,
                                   is_default=True, created_by_user_id=user_id,
                                   updated_by_user_id=user_id))
        else:
            chosen.is_default, chosen.updated_by_user_id = True, user_id
        # patient_pharmacy has no touch trigger, so the patient row is updated here, as
        # employer's trigger does, and the version trigger gives it its new version.
        pt.meta_last_updated = func.now()
        return await _written(db, pt)

    # ------------------------------------------------------------------------- RelatedPerson
    async def create_related_person(self, db: AsyncSession, data: RelatedPersonIn) -> Written:
        await _not_merged(db, data.patient_id)
        person = RelatedPerson(patient_id=data.patient_id, active=data.active, gender=data.gender,
                               birth_date=data.birth_date)
        db.add(await _new(db, person))
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
        await _not_merged(db, data.beneficiary_patient_id)
        cov = Coverage(status=data.status, beneficiary_patient_id=data.beneficiary_patient_id,
                       ext_accept_assignment=data.accept_assignment,
                       **{f: getattr(data, f) for f in _COVERAGE_FIELDS})
        db.add(await _new(db, cov))
        await _flush_coverage(db)
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
        await _flush_coverage(db)
        await _coverage_children(db, coverage_id, changes)
        return await _written(db, cov)

    async def coverage_entered_in_error(self, db: AsyncSession, coverage_id: uuid.UUID,
                                        reason: Reason, *, if_version: int | None = None
                                        ) -> Written:
        reason = _require_reason(reason)
        cov = await _locked(db, Coverage, coverage_id, if_version)
        if cov.status == "entered-in-error":
            raise InvalidTransition(cov.status)
        cov.status = "entered-in-error"
        written = await _written(db, cov)
        await _nullify_provenance(db, "Coverage", written, reason)
        return written

    # ------------------------------------------------------------------------- Consent
    async def create_consent(self, db: AsyncSession, data: ConsentIn) -> Written:
        await _not_merged(db, data.patient_id)
        if data.kind not in _CONSENT_OF_KIND:
            raise InvalidInput(f"unknown consent kind {data.kind!r}")
        scope, categories = _CONSENT_OF_KIND[data.kind]
        if data.categories and ({(c.system, c.code) for c in data.categories}
                                != {(c.system, c.code) for c in categories}):
            raise InvalidInput(f"a {data.kind} consent's category is set by its kind")
        if data.status == "active":
            # The latest consent of a kind is the one in force (patients.yaml, Consent.status).
            earlier = (await db.execute(
                select(Consent).where(Consent.patient_id == data.patient_id,
                                      Consent.ext_kind == data.kind,
                                      Consent.status == "active").with_for_update())).scalars()
            for old in earlier:
                old.status = "inactive"
        consent = Consent(
            status=data.status, patient_id=data.patient_id, date_time=data.date_time,
            scope_system=systems.CONSENT_SCOPE,
            scope_code=scope,
            provision_type=data.provision_type, ext_kind=data.kind,
            ext_signature_method=data.signature_method, ext_policy_version=data.policy_version,
            ext_grantor_related_person_id=data.grantor_related_person_id,
            source_attachment_binary_object_id=data.source_attachment_binary_object_id,
            source_document_reference_id=data.source_document_reference_id,
            entry_source=data.entry_source)
        db.add(await _new(db, consent))
        await db.flush()
        db.add_all(ConsentCategory(consent_id=consent.id, category_system=c.system,
                                   category_code=c.code, category_display=c.display,
                                   category_text=c.text) for c in categories)
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

    # ------------------------------------------------------------------------- Encounter
    async def create_encounter(self, db: AsyncSession, data: EncounterIn) -> Written:
        await _not_merged(db, data.patient_id)
        start = data.started_at or await _db_now(db)
        enc = Encounter(status=data.status, class_=data.class_code,
                        subject_patient_id=data.patient_id, appointment_id=data.appointment_id,
                        period_start=start, ext_facility_id=data.facility_id,
                        service_provider_organization_id=data.service_provider_organization_id,
                        ext_self_pay=data.self_pay,
                        ext_place_of_service_code=data.place_of_service_code)
        db.add(await _new(db, enc))
        await db.flush()
        db.add(EncounterStatusHistory(encounter_id=enc.id, status=data.status,
                                      period_start=start))
        db.add_all(EncounterParticipant(encounter_id=enc.id,
                                        type_system=systems.V3_PARTICIPATION_TYPE,
                                        type_code=p.role,
                                        individual_practitioner_id=p.practitioner_id)
                   for p in data.participants)
        db.add_all(EncounterReason(encounter_id=enc.id, reason_code_system=r.system,
                                   reason_code_code=r.code, reason_code_display=r.display,
                                   reason_code_text=r.text) for r in data.reasons)
        return await _written(db, enc)

    async def set_encounter_status(self, db: AsyncSession, encounter_id: uuid.UUID, status: str,
                                   *, at: datetime | None = None, reason: Reason | None = None,
                                   if_version: int | None = None) -> Written:
        enc = await _locked(db, Encounter, encounter_id, if_version)
        if enc.status == "entered-in-error":
            raise InvalidTransition(enc.status)
        if status == "entered-in-error":
            if reason is None:
                raise InvalidInput("a reason is required", field="reason")
            reason = _require_reason(reason)
        when = at or await _db_now(db)
        history = EncounterStatusHistory
        for open_row in (await db.execute(select(history).where(
                history.encounter_id == encounter_id, history.period_end.is_(None)))).scalars():
            open_row.period_end = when
        db.add(EncounterStatusHistory(encounter_id=encounter_id, status=status,
                                      period_start=when))
        enc.status = status
        if status in ("in-progress", "finished") and enc.period_start is None:
            enc.period_start = when
        if status == "finished":
            enc.period_end = when
        written = await _written(db, enc)
        if status == "entered-in-error" and reason is not None:
            await _nullify_provenance(db, "Encounter", written, reason)
        return written

    # ------------------------------------------------------------------------- Vitals
    async def record_vitals(self, db: AsyncSession, patient_id: uuid.UUID,
                            encounter_id: uuid.UUID | None, vitals: tuple[VitalIn, ...], *,
                            effective_at: datetime | None = None) -> list[Written]:
        await _not_merged(db, patient_id)
        now = await _db_now(db)
        effective = effective_at or now
        if effective > now:
            raise InvalidInput("vitals are never measured in the future")
        types = [v.type for v in vitals]
        if len(set(types)) != len(types):
            raise InvalidInput("at most one entry per vital type")
        rows = []
        for v in vitals:
            if v.type not in _VITALS:
                raise InvalidInput(f"unknown vital type {v.type!r}")
            loinc, display = _VITALS[v.type]
            obs = Observation(status="final", code_system=systems.LOINC, code_code=loinc,
                              code_display=display, subject_patient_id=patient_id,
                              encounter_id=encounter_id, effective_date_time=effective,
                              issued=now)
            obs.category = [ObservationCategory(category_system=systems.OBSERVATION_CATEGORY,
                                                category_code="vital-signs")]
            if v.type == "blood-pressure":
                if v.systolic is None or v.diastolic is None:
                    raise InvalidInput("blood-pressure needs systolic and diastolic")
                obs.component = [
                    _component(1, "8480-6", "Systolic blood pressure", v.systolic),
                    _component(2, "8462-4", "Diastolic blood pressure", v.diastolic)]
            else:
                if v.value is None:
                    raise InvalidInput(f"{v.type} needs a value")
                obs.value_quantity_value = v.value.value
                obs.value_quantity_unit = obs.value_quantity_code = v.value.unit
                obs.value_quantity_system = systems.UCUM
            db.add(await _new(db, obs))
            rows.append(obs)
        return [await _written(db, obs) for obs in rows]

    async def vital_entered_in_error(self, db: AsyncSession, observation_id: uuid.UUID,
                                     reason: Reason, *, if_version: int | None = None
                                     ) -> Written:
        reason = _require_reason(reason)
        obs = await _locked(db, Observation, observation_id, if_version)
        if obs.status == "entered-in-error":
            raise InvalidTransition(obs.status)
        obs.status = "entered-in-error"
        written = await _written(db, obs)
        await _nullify_provenance(db, "Observation", written, reason)
        return written

    # ------------------------------------------------------------------------- Allergy
    async def create_allergy(self, db: AsyncSession, data: AllergyIn) -> Written:
        await _not_merged(db, data.patient_id)
        allergy = AllergyIntolerance(
            patient_id=data.patient_id, encounter_id=data.encounter_id,
            clinical_status=data.clinical_status, verification_status=data.verification_status,
            code_system=data.code.system, code_code=data.code.code,
            code_display=data.code.display, code_text=data.code.text, type=data.type,
            category=list(data.categories), criticality=data.criticality,
            onset_date_time=data.onset_date_time, recorded_date=await _db_now(db),
            entry_source=data.entry_source)
        db.add(await _new(db, allergy))
        await db.flush()
        await _allergy_children(db, allergy.id, data)
        return await _written(db, allergy)

    async def update_allergy(self, db: AsyncSession, allergy_id: uuid.UUID,
                             changes: AllergyChanges, *, if_version: int) -> Written:
        allergy = await _locked(db, AllergyIntolerance, allergy_id, if_version)
        if allergy.verification_status == "entered-in-error":
            raise InvalidTransition(allergy.verification_status)
        if _given(changes.code):
            allergy.code_system, allergy.code_code = changes.code.system, changes.code.code
            allergy.code_display, allergy.code_text = changes.code.display, changes.code.text
        for field in ("clinical_status", "verification_status", "type", "criticality",
                      "onset_date_time"):
            if _given(getattr(changes, field)):
                setattr(allergy, field, getattr(changes, field))
        if _given(changes.categories):
            allergy.category = list(changes.categories)
        await _allergy_children(db, allergy_id, changes)
        return await _written(db, allergy)

    async def allergy_entered_in_error(self, db: AsyncSession, allergy_id: uuid.UUID,
                                       reason: Reason, *, if_version: int | None = None
                                       ) -> Written:
        reason = _require_reason(reason)
        allergy = await _locked(db, AllergyIntolerance, allergy_id, if_version)
        if allergy.verification_status == "entered-in-error":
            raise InvalidTransition(allergy.verification_status)
        allergy.verification_status, allergy.clinical_status = "entered-in-error", None
        written = await _written(db, allergy)
        await _nullify_provenance(db, "AllergyIntolerance", written, reason)
        return written

    # ------------------------------------------------------------------------- Diagnoses
    async def add_encounter_diagnosis(self, db: AsyncSession, encounter_id: uuid.UUID,
                                      data: DiagnosisIn) -> DiagnosisWritten:
        enc = await _locked(db, Encounter, encounter_id, None)
        link = EncounterDiagnosis
        last = (await db.execute(select(func.coalesce(func.max(link.rank), 0))
                                 .where(link.encounter_id == encounter_id))).scalar_one()
        rank = data.rank if data.rank is not None else last + 1
        if not 1 <= rank <= last + 1:
            raise InvalidInput(f"rank must be between 1 and {last + 1}")
        # Make room, highest first: UNIQUE (encounter_id, rank) is checked row by row.
        for row in (await db.execute(select(link).where(
                link.encounter_id == encounter_id, link.rank >= rank)
                .order_by(link.rank.desc()))).scalars():
            row.rank += 1
            await db.flush()
        cond = Condition(clinical_status="active", verification_status=data.verification_status,
                         code_system=data.code.system, code_code=data.code.code,
                         code_display=data.code.display, code_text=data.code.text,
                         subject_patient_id=enc.subject_patient_id, encounter_id=encounter_id,
                         onset_date_time=data.onset_date_time, recorded_date=await _db_now(db),
                         entry_source=data.entry_source)
        cond.category = [ConditionCategory(category_system=systems.CONDITION_CATEGORY,
                                           category_code="encounter-diagnosis")]
        db.add(await _new(db, cond))
        await db.flush()
        db.add(EncounterDiagnosis(encounter_id=encounter_id, condition_id=cond.id, rank=rank))
        condition = await _written(db, cond)
        return DiagnosisWritten(condition, await _written(db, enc), rank)

    async def remove_encounter_diagnosis(self, db: AsyncSession, encounter_id: uuid.UUID,
                                         condition_id: uuid.UUID, reason: Reason) -> Written:
        reason = _require_reason(reason)
        enc = await _locked(db, Encounter, encounter_id, None)
        link = EncounterDiagnosis
        row = (await db.execute(select(link).where(link.encounter_id == encounter_id,
                                                   link.condition_id == condition_id)
                                )).scalar_one_or_none()
        if row is None:
            raise ResourceNotFound
        cond = await _locked(db, Condition, condition_id, None)
        # One marked in error after signing keeps its link (diagnosis_entered_in_error): removing
        # it now would free a signed visit's rank and add a second Provenance (#194 review).
        if cond.verification_status == "entered-in-error":
            raise InvalidTransition(cond.verification_status)
        cond.verification_status, cond.clinical_status = "entered-in-error", None
        await _nullify_provenance(db, "Condition", await _written(db, cond), reason)
        removed = row.rank
        await db.delete(row)
        await db.flush()
        # Close the gap, lowest first, for the same reason.
        for later in (await db.execute(select(link).where(
                link.encounter_id == encounter_id, link.rank > removed)
                .order_by(link.rank))).scalars():
            later.rank -= 1
            await db.flush()
        return await _written(db, enc)

    async def diagnosis_entered_in_error(self, db: AsyncSession, condition_id: uuid.UUID,
                                         reason: Reason, *, if_version: int | None = None
                                         ) -> Written:
        reason = _require_reason(reason)
        cond = await _locked(db, Condition, condition_id, if_version)
        if cond.verification_status == "entered-in-error":
            raise InvalidTransition(cond.verification_status)
        cond.verification_status, cond.clinical_status = "entered-in-error", None
        written = await _written(db, cond)
        await _nullify_provenance(db, "Condition", written, reason)
        return written

    # ------------------------------------------------------------------------- Problem list
    async def create_problem(self, db: AsyncSession, data: ProblemIn) -> Written:
        _check_problem_status(data.clinical_status, data.verification_status)
        await _patient_seen(db, data.patient_id)
        if data.encounter_id is not None:
            await _live_visit_of(db, data.encounter_id, data.patient_id)
        cond = Condition(clinical_status=data.clinical_status,
                         verification_status=data.verification_status,
                         code_system=data.code.system, code_code=data.code.code,
                         code_display=data.code.display, code_text=data.code.text,
                         subject_patient_id=data.patient_id, encounter_id=data.encounter_id,
                         recorded_date=await _db_now(db), entry_source=data.entry_source)
        _set_problem_dates(cond, data.onset, data.abatement)
        cond.category = [ConditionCategory(category_system=systems.CONDITION_CATEGORY,
                                           category_code=PROBLEM_LIST_ITEM)]
        db.add(await _new(db, cond))
        await db.flush()
        if data.note:
            db.add(Annotation(condition_id=cond.id, text=data.note, time=await _db_now(db)))
        return await _written(db, cond)

    async def update_problem(self, db: AsyncSession, problem_id: uuid.UUID,
                             changes: ProblemChanges, *, if_version: int) -> Written:
        cond = await _problem(db, problem_id, if_version)
        if _given(changes.clinical_status):
            cond.clinical_status = changes.clinical_status
        if _given(changes.verification_status):
            cond.verification_status = changes.verification_status
        _check_problem_status(cond.clinical_status, cond.verification_status)
        onset = changes.onset if _given(changes.onset) else _partial_date(
            cond.onset_date_time, cond.onset_period_start, cond.onset_period_end)
        abatement = changes.abatement if _given(changes.abatement) else _partial_date(
            cond.abatement_date_time, cond.abatement_period_start, cond.abatement_period_end)
        _set_problem_dates(cond, onset, abatement)
        if _given(changes.note):
            await db.execute(delete(Annotation).where(Annotation.condition_id == problem_id))
            if changes.note:
                db.add(Annotation(condition_id=problem_id, text=changes.note,
                                  time=await _db_now(db)))
        try:
            return await _written(db, cond)
        except DBAPIError as refused:
            raise _con4(refused) from None

    async def problem_entered_in_error(self, db: AsyncSession, problem_id: uuid.UUID,
                                       reason: Reason, *, if_version: int | None = None
                                       ) -> Written:
        reason = _require_reason(reason)
        cond = await _problem(db, problem_id, if_version)
        cond.verification_status, cond.clinical_status = "entered-in-error", None
        written = await _written(db, cond)
        await _nullify_provenance(db, "Condition", written, reason)
        return written

    # ------------------------------------------------------------------------- Merges
    async def merge_patients(self, db: AsyncSession, duplicate_id: uuid.UUID,
                             surviving_patient_id: uuid.UUID, reason: str) -> MergeWritten:
        why = _require_reason(Reason(reason)).text
        pair = await _open_pair(db, duplicate_id)
        if surviving_patient_id not in (pair.patient_a_id, pair.patient_b_id):
            raise InvalidInput("survivingPatientId is one of the pair",
                               field="survivingPatientId")
        merged_id = pair.patient_b_id if surviving_patient_id == pair.patient_a_id \
            else pair.patient_a_id
        patients = await _lock_pair(db, surviving_patient_id, merged_id)
        for patient_id in patients:
            await _not_merged(db, patient_id)           # no chains: merge into a chart's end
        labels = merged_labels(*(pt.meta_security for pt in patients.values()))
        relabelled = [pid for pid, pt in patients.items()
                      if set(pt.meta_security) != set(labels)]
        for pid in relabelled:
            patients[pid].meta_security = labels
        now, user = await _db_now(db), await _user_id(db)
        merge = PatientMerge(surviving_patient_id=surviving_patient_id,
                             merged_patient_id=merged_id, duplicate_candidate_id=duplicate_id,
                             reason=why, performed_at=now, performed_by_user_id=user)
        db.add_all([merge, PatientLink(patient_id=merged_id, other_patient_id=surviving_patient_id,
                                       type="replaced-by"),
                    PatientLink(patient_id=surviving_patient_id, other_patient_id=merged_id,
                                type="replaces")])
        patients[merged_id].active = False
        pair.status, pair.reviewed_by_user_id, pair.reviewed_at = "merged", user, now
        await db.flush()
        written = {pid: await _written(db, pt) for pid, pt in patients.items()}
        for pid in relabelled:      # who changed the chart's labels, and why
            await _provenance(db, "Patient", written[pid],
                              (systems.V3_DATA_OPERATION, "UPDATE", None),
                              reason=Reason(f"Security labels of the merged charts ({merge.id})"))
        return MergeWritten(merge.id, written[surviving_patient_id], written[merged_id])

    async def undo_patient_merge(self, db: AsyncSession, merge_id: uuid.UUID, reason: str
                                 ) -> MergeWritten:
        _require_reason(Reason(reason))
        merge = (await db.execute(select(PatientMerge).where(PatientMerge.id == merge_id)
                                  .with_for_update())).scalar_one_or_none()
        if merge is None:
            raise ResourceNotFound
        blocked = (await db.execute(text("SELECT admin.patient_merge_undo_blocked_reason(:m)"),
                                    {"m": merge_id})).scalar_one()
        if blocked is not None:
            raise InvalidTransition(blocked)
        surviving, merged = merge.surviving_patient_id, merge.merged_patient_id
        patients = await _lock_pair(db, surviving, merged)
        merge.unmerged_at, merge.unmerged_by_user_id = await _db_now(db), await _user_id(db)
        await db.execute(delete(PatientLink).where(
            ((PatientLink.patient_id == merged) & (PatientLink.other_patient_id == surviving)
             & (PatientLink.type == "replaced-by"))
            | ((PatientLink.patient_id == surviving) & (PatientLink.other_patient_id == merged)
               & (PatientLink.type == "replaces"))))
        patients[merged].active = True
        return MergeWritten(merge_id, await _written(db, patients[surviving]),
                            await _written(db, patients[merged]))

    async def dismiss_duplicate(self, db: AsyncSession, duplicate_id: uuid.UUID, reason: str
                                ) -> None:
        why = _require_reason(Reason(reason)).text
        pair = await _open_pair(db, duplicate_id)
        user, now = await _user_id(db), await _db_now(db)   # before any change: autoflush
        pair.status, pair.review_note = "not-duplicate", why
        pair.reviewed_by_user_id, pair.reviewed_at = user, now
        await db.flush()

    # ------------------------------------------------------------------------- History
    async def create_family_history(self, db: AsyncSession, data: FamilyHistoryIn) -> Written:
        if data.status not in _FAMILY_STATUSES:
            raise InvalidInput(f"status is one of {sorted(_FAMILY_STATUSES)}", field="status")
        if not data.conditions and data.status != "health-unknown":
            raise InvalidInput("give conditions, or status health-unknown", field="conditions")
        if data.sex is not None and data.sex not in _SEXES:
            raise InvalidInput(f"sex is one of {sorted(_SEXES)}", field="sex")
        await _patient_seen(db, data.patient_id)
        fmh = FamilyMemberHistory(
            status=data.status, patient_id=data.patient_id, date=await _db_now(db),
            relationship_system=data.relationship.system, relationship_code=data.relationship.code,
            relationship_display=data.relationship.display,
            relationship_text=data.relationship.text, sex_text=data.sex,
            deceased_boolean=data.deceased, entry_source=data.entry_source)
        fmh.condition = [FamilyMemberHistoryCondition(
            code_system=c.code.system, code_code=c.code.code, code_display=c.code.display,
            code_text=c.code.text, contributed_to_death=c.contributed_to_death,
            **_age_years(c.onset_age)) for c in data.conditions]
        db.add(await _new(db, fmh))
        await db.flush()
        if data.note:
            db.add(Annotation(family_member_history_id=fmh.id, text=data.note,
                              time=await _db_now(db)))
        return await _written(db, fmh)

    async def family_history_entered_in_error(self, db: AsyncSession, history_id: uuid.UUID,
                                              reason: Reason, *, if_version: int | None = None
                                              ) -> Written:
        reason = _require_reason(reason)
        fmh = await _locked(db, FamilyMemberHistory, history_id, if_version)
        if fmh.status == "entered-in-error":
            raise InvalidTransition(fmh.status)
        fmh.status = "entered-in-error"
        written = await _written(db, fmh)
        await _nullify_provenance(db, "FamilyMemberHistory", written, reason)
        return written

    async def record_social_history(self, db: AsyncSession, data: SocialHistoryIn) -> Written:
        if data.code.system != systems.LOINC or not data.code.code:
            raise InvalidInput("a social-history code is LOINC", field="code")
        await _patient_seen(db, data.patient_id)
        if data.encounter_id is not None:
            await _live_visit_of(db, data.encounter_id, data.patient_id)
        now = await _db_now(db)
        at, start, end = (now, None, None) if data.effective is None else \
            _partial_columns(data.effective, "effectiveDate", now)
        obs = Observation(status="final", code_system=data.code.system,
                          code_code=data.code.code, code_display=data.code.display,
                          code_text=data.code.text, subject_patient_id=data.patient_id,
                          encounter_id=data.encounter_id, effective_date_time=at,
                          effective_period_start=start, effective_period_end=end, issued=now,
                          entry_source=data.entry_source)
        v = data.value
        if isinstance(v, Measured):
            obs.value_quantity_value = v.value
            obs.value_quantity_unit = obs.value_quantity_code = v.unit
            obs.value_quantity_system = systems.UCUM
        elif isinstance(v, Coded):
            obs.value_codeable_concept_system, obs.value_codeable_concept_code = v.system, v.code
            obs.value_codeable_concept_display = v.display
            obs.value_codeable_concept_text = v.text
        else:
            obs.value_string = v
        obs.category = [ObservationCategory(category_system=systems.OBSERVATION_CATEGORY,
                                            category_code=SOCIAL_HISTORY)]
        db.add(await _new(db, obs))
        return await _written(db, obs)

    async def social_history_entered_in_error(self, db: AsyncSession, observation_id: uuid.UUID,
                                              reason: Reason, *, if_version: int | None = None
                                              ) -> Written:
        reason = _require_reason(reason)
        if (await db.execute(select(ObservationCategory.observation_id).where(
                ObservationCategory.observation_id == observation_id,
                ObservationCategory.category_code == SOCIAL_HISTORY))).first() is None:
            raise ResourceNotFound
        obs = await _locked(db, Observation, observation_id, if_version)
        if obs.status == "entered-in-error":
            raise InvalidTransition(obs.status)
        obs.status = "entered-in-error"
        written = await _written(db, obs)
        await _nullify_provenance(db, "Observation", written, reason)
        return written

    async def create_surgical_history(self, db: AsyncSession, data: SurgicalHistoryIn
                                      ) -> Written:
        await _patient_seen(db, data.patient_id)
        if data.encounter_id is not None:
            await _live_visit_of(db, data.encounter_id, data.patient_id)
        at, start, end = _partial_columns(data.performed, "performedDate", await _db_now(db))
        proc = Procedure(status="completed", category_system=systems.SNOMED,
                         category_code=SURGICAL_PROCEDURE, category_display="Surgical procedure",
                         code_system=data.code.system, code_code=data.code.code,
                         code_display=data.code.display, code_text=data.code.text,
                         subject_patient_id=data.patient_id, encounter_id=data.encounter_id,
                         performed_date_time=at, performed_period_start=start,
                         performed_period_end=end, entry_source=data.entry_source)
        if data.body_site is not None:
            b = data.body_site
            proc.body_site = [ProcedureBodySite(body_site_system=b.system, body_site_code=b.code,
                                                body_site_display=b.display, body_site_text=b.text)]
        db.add(await _new(db, proc))
        await db.flush()
        if data.note:
            db.add(Annotation(procedure_id=proc.id, text=data.note, time=await _db_now(db)))
        return await _written(db, proc)

    async def surgical_history_entered_in_error(self, db: AsyncSession, procedure_id: uuid.UUID,
                                                reason: Reason, *, if_version: int | None = None
                                                ) -> Written:
        reason = _require_reason(reason)
        proc = await _locked(db, Procedure, procedure_id, if_version)
        if proc.category_code != SURGICAL_PROCEDURE:
            raise ResourceNotFound
        if proc.status == "entered-in-error":
            raise InvalidTransition(proc.status)
        proc.status = "entered-in-error"
        written = await _written(db, proc)
        await _nullify_provenance(db, "Procedure", written, reason)
        return written

    # ------------------------------------------------------------------------- Medication list
    async def record_medication(self, db: AsyncSession, data: MedicationIn) -> Written:
        _check_medication(data.medication)
        if data.status not in _LIST_STATUSES:
            raise InvalidInput(f"a medication on the list is one of {sorted(_LIST_STATUSES)}")
        await _patient_seen(db, data.patient_id)
        if data.encounter_id is not None:
            await _live_visit_of(db, data.encounter_id, data.patient_id)
        user = await _current_user(db)
        now = await _db_now(db)
        # The patient says they take it: reportedBoolean, never signed or sent. FHIR needs a
        # requester; the prescriber isn't known, so it is the patient, who reported it.
        mr = MedicationRequest(status=data.status, intent="plan", reported_boolean=True,
                               subject_patient_id=data.patient_id,
                               requester_patient_id=data.patient_id,
                               encounter_id=data.encounter_id, authored_on=now,
                               recorder_practitioner_id=user.practitioner_id)
        _apply_prescription(mr, PrescriptionChanges(medication=data.medication))
        db.add(await _new(db, mr))
        await db.flush()
        await _replace_dosage(db, mr.id, data.dosage_text)
        if data.note and data.note.strip():
            db.add(Annotation(medication_request_id=mr.id, text=data.note, time=now))
        return await _written(db, mr)

    # ------------------------------------------------------------------------- Prescriptions
    async def create_prescription(self, db: AsyncSession, data: PrescriptionIn) -> Written:
        _check_medication(data.medication)
        await _patient_seen(db, data.patient_id)
        if data.encounter_id is not None:
            await _live_visit_of(db, data.encounter_id, data.patient_id)
        await _check_pharmacy(db, data.pharmacy_id)
        prescriber = await _practitioner(db)
        mr = MedicationRequest(status="draft", intent="order", category=["community"],
                               subject_patient_id=data.patient_id,
                               encounter_id=data.encounter_id,
                               requester_practitioner_id=prescriber.practitioner_id)
        _apply_prescription(mr, data)
        db.add(await _new(db, mr))
        await db.flush()
        await _replace_dosage(db, mr.id, data.dosage_text)
        return await _written(db, mr)

    async def update_prescription(self, db: AsyncSession, prescription_id: uuid.UUID,
                                  changes: PrescriptionChanges, *, if_version: int
                                  ) -> Written:
        mr = await _prescription(db, prescription_id, if_version)
        if mr.status != "draft":
            raise InvalidTransition(mr.status)
        if _given(changes.medication):
            _check_medication(changes.medication)
        if _given(changes.pharmacy_id):
            await _check_pharmacy(db, changes.pharmacy_id)
        _apply_prescription(mr, changes)
        if _given(changes.dosage_text):
            await _replace_dosage(db, mr.id, changes.dosage_text)
        return await _written(db, mr)

    async def prescription_entered_in_error(self, db: AsyncSession, prescription_id: uuid.UUID,
                                            reason: Reason, *, if_version: int | None = None
                                            ) -> Written:
        reason = _require_reason(reason)
        mr = await _prescription(db, prescription_id, if_version)
        if mr.status != "draft":              # a signed prescription is cancelled (later)
            raise InvalidTransition(mr.status)
        mr.status = "entered-in-error"
        mr.status_reason_text = reason.text
        written = await _written(db, mr)
        await _nullify_provenance(db, "MedicationRequest", written, reason)
        await _cancel_alerts(db, mr.id)
        return written

    async def record_safety_check(self, db: AsyncSession, prescription_id: uuid.UUID,
                                  alerts: tuple[AlertIn, ...], *, if_version: int
                                  ) -> SafetyCheckWritten:
        mr = await _prescription(db, prescription_id, if_version)
        if mr.status != "draft":
            raise InvalidTransition(mr.status)
        now = await _db_now(db)
        rows = [await _alert(db, mr, a, now) for a in alerts]   # checks every alert first
        await _cancel_alerts(db, mr.id)
        for issue, implicated in rows:
            db.add(await _new(db, issue))
            await db.flush()
            db.add_all(DetectedIssueImplicated(detected_issue_id=issue.id, **i)
                       for i in implicated)
            await _written(db, issue)
        # Not a version of the prescription (A58): only these two columns change, which its
        # version trigger ignores, and updated_at / updated_by_user_id stay as they are.
        await db.execute(
            update(MedicationRequest).where(MedicationRequest.id == mr.id)
            .values(ext_safety_checked_at=now, ext_safety_checked_version=mr.meta_version_id,
                    updated_at=MedicationRequest.updated_at)
            .execution_options(synchronize_session=False))
        await db.refresh(mr)
        return SafetyCheckWritten(mr.id, now, mr.meta_version_id,
                                  tuple(issue.id for issue, _ in rows))

    async def override_alert(self, db: AsyncSession, alert_id: uuid.UUID, reason: str
                             ) -> Written:
        if len(reason.strip()) < 3:
            raise InvalidInput("an override needs a reason of at least 3 characters",
                               field="reason")
        prescription_id = await _alert_prescription(db, alert_id)
        mr = await _prescription(db, prescription_id, None)   # as signing does
        issue = await _locked(db, DetectedIssue, alert_id, None)
        user = await _practitioner(db)
        if mr.status != "draft":
            raise InvalidTransition(mr.status)
        if issue.status in ("cancelled", "entered-in-error"):
            raise InvalidTransition(issue.status)
        if (await db.execute(select(DetectedIssueMitigation.id).where(
                DetectedIssueMitigation.detected_issue_id == alert_id))).first() is not None:
            raise InvalidTransition("overridden")
        db.add(DetectedIssueMitigation(detected_issue_id=alert_id,
                                       action_system=systems.DETECTED_ISSUE_MITIGATION,
                                       action_code="1", action_display="Therapy Appropriate",
                                       date=await _db_now(db),
                                       author_practitioner_id=user.practitioner_id,
                                       ext_reason=reason.strip()))
        return await _written(db, issue)

    async def sign_prescription(self, db: AsyncSession, prescription_id: uuid.UUID, *,
                                if_version: int, integration_message_id: uuid.UUID | None = None
                                ) -> Written:
        mr = await _prescription(db, prescription_id, if_version)
        if mr.status != "draft":
            raise InvalidTransition(mr.status)
        signer = await _practitioner(db)
        dosage = await _dosage_text(db, mr.id)
        errors = [(pointer, "required") for pointer, missing in (
            ("/dosageText", not dosage), ("/quantity", mr.dispense_request_quantity_value is None),
            ("/pharmacyId", mr.dispense_request_performer_pharmacy_id is None)) if missing]
        if mr.ext_safety_checked_version != mr.meta_version_id:
            errors.append(("/alerts", "safety-check-stale"))     # its alerts are not this draft's
        else:
            errors += [(f"/alerts/{i}", "override-required")
                       for i in await _unmitigated_high_alerts(db, mr)]
        if errors:
            raise SignRefused(tuple(errors))
        now = await _db_now(db)
        mr.status, mr.authored_on = "active", now
        mr.ext_signed_at, mr.ext_signed_by_user_id = now, signer.id
        mr.ext_signed_by_practitioner_id = signer.practitioner_id
        written = await _written(db, mr)
        await _signed_provenance(db, "MedicationRequest", written, _SIGNED,
                                 _digest(await _prescription_content(db, mr, dosage)))
        db.add(ErxTransaction(medication_request_id=mr.id, patient_id=mr.subject_patient_id,
                              pharmacy_id=mr.dispense_request_performer_pharmacy_id,
                              message_type="NewRx", direction="outbound", status="queued",
                              integration_message_id=integration_message_id, occurred_at=now,
                              created_by_user_id=signer.id, updated_by_user_id=signer.id))
        await db.flush()
        return written

    async def set_transmission_status(self, db: AsyncSession, prescription_id: uuid.UUID,
                                      status: str, *, message: str | None = None,
                                      vendor_message_id: str | None = None
                                      ) -> TransmissionWritten:
        if status not in _TRANSMISSION:
            raise InvalidInput(f"unknown transmission status {status!r}")
        if status == "error" and not (message or "").strip():
            raise InvalidInput("an error needs its message")
        tx = (await db.execute(
            select(ErxTransaction).where(ErxTransaction.medication_request_id == prescription_id,
                                         ErxTransaction.message_type == "NewRx",
                                         ErxTransaction.direction == "outbound")
            .order_by(ErxTransaction.occurred_at.desc()).limit(1).with_for_update()
            .execution_options(populate_existing=True))).scalar_one_or_none()
        if tx is None:                        # a draft: not sent
            raise ResourceNotFound
        if status != tx.status:
            if status not in _TRANSMISSION[tx.status]:
                raise InvalidTransition(tx.status)
            tx.status = ErxTransactionStatus(status)
            tx.error_message = message if status in ("rejected", "error") else None
            if vendor_message_id is not None:
                tx.vendor_message_id = vendor_message_id
            tx.updated_by_user_id = await _user_id(db)
            await db.flush()
            await db.refresh(tx, attribute_names=["updated_at"])
        return TransmissionWritten(tx.id, tx.status, tx.updated_at)

    # ------------------------------------------------------------------------- Notes
    async def create_note(self, db: AsyncSession, data: NoteIn) -> Written:
        if not data.title.strip():
            raise InvalidInput("a note needs a title")
        enc = (await db.execute(select(Encounter).where(Encounter.id == data.encounter_id))
               ).scalar_one_or_none()
        if enc is None:
            raise ResourceNotFound
        if enc.status == "entered-in-error":
            raise InvalidTransition(enc.status)
        author = await _practitioner(db)
        note = Composition(status="preliminary", type_system=data.note_type.system,
                           type_code=data.note_type.code, type_display=data.note_type.display,
                           type_text=data.note_type.text, subject_patient_id=enc.subject_patient_id,
                           encounter_id=enc.id, date=await _db_now(db), title=data.title,
                           ext_template_id=data.template_id)
        db.add(await _new(db, note))
        await db.flush()
        db.add(CompositionAuthor(composition_id=note.id, practitioner_id=author.practitioner_id))
        db.add_all(CompositionSection(composition_id=note.id, sequence=i, title=s.title,
                                      code_system=systems.LOINC, code_code=s.code,
                                      **_section_text(s.text))
                   for i, s in enumerate(data.sections, start=1))
        return await _written(db, note)

    async def update_note(self, db: AsyncSession, note_id: uuid.UUID, changes: NoteChanges, *,
                          if_version: int) -> Written:
        note = await _locked(db, Composition, note_id, if_version)
        if note.status != "preliminary":
            raise InvalidTransition(note.status)
        if _given(changes.title):
            if not changes.title.strip():
                raise InvalidInput("a note needs a title")
            note.title = changes.title
        sections = {s.id: s for s in (await db.execute(select(CompositionSection).where(
            CompositionSection.composition_id == note_id))).scalars()}
        for change in changes.sections:
            if change.id not in sections:
                raise InvalidInput("a section that is not in this note")
            for column, value in _section_text(change.text).items():
                setattr(sections[change.id], column, value)
        note.date = await _db_now(db)
        return await _written(db, note)

    async def sign_note(self, db: AsyncSession, note_id: uuid.UUID, *, if_version: int,
                        cosigner_practitioner_id: uuid.UUID | None = None) -> Written:
        note = await _locked(db, Composition, note_id, if_version)
        if note.status != "preliminary":
            raise InvalidTransition(note.status)
        signer = await _practitioner(db)
        if cosigner_practitioner_id is not None:
            if cosigner_practitioner_id in await _authors(db, note_id):
                raise InvalidInput("the co-signer is never the author")
            if (await db.execute(select(Practitioner.id).where(
                    Practitioner.id == cosigner_practitioner_id))).scalar_one_or_none() is None:
                raise ResourceNotFound
        undecided = (await db.execute(
            select(CompositionSection.sequence).join(
                AISuggestion, AISuggestion.id == CompositionSection.ai_suggestion_id)
            .where(CompositionSection.composition_id == note_id,
                   AISuggestion.decision.not_in(("accepted", "edited"))))).first()
        if undecided is not None:              # the database refuses it too, at commit
            raise InvalidInput("an AI-drafted section has no accept or edit decision")
        now = await _db_now(db)
        note.status, note.date = "final", now
        if cosigner_practitioner_id is not None:          # with the status: a draft has none
            note.ext_cosign_status = "pending"
            note.ext_cosigner_practitioner_id = cosigner_practitioner_id
        written = await _attest(db, note, signer, "legal", now)
        await _signed_provenance(db, "Composition", written, _SIGNED, await _note_digest(db, note))
        return written

    async def add_note_addendum(self, db: AsyncSession, note_id: uuid.UUID, text: str, *,
                                if_version: int) -> AddendumWritten:
        if not text.strip():
            raise InvalidInput("an addendum needs text")
        note = await _locked(db, Composition, note_id, if_version)
        if note.status not in ("final", "amended"):
            raise InvalidTransition(note.status)
        author = await _practitioner(db)
        now = await _db_now(db)
        # The addendum keeps the note's labels (a PSY note's addendum is PSY too).
        add = Composition(status="final", type_system=note.type_system, type_code=note.type_code,
                          type_display=note.type_display, type_text=note.type_text,
                          subject_patient_id=note.subject_patient_id,
                          encounter_id=note.encounter_id, date=now, title="Addendum",
                          confidentiality=note.confidentiality,
                          meta_security=list(note.meta_security))
        db.add(await _new(db, add))
        await db.flush()
        db.add(CompositionAuthor(composition_id=add.id, practitioner_id=author.practitioner_id))
        db.add(CompositionSection(composition_id=add.id, sequence=1, title="Addendum",
                                  **_section_text(text)))
        db.add(CompositionRelatesTo(composition_id=add.id, code="appends",
                                    target_composition_id=note.id))
        added = await _attest(db, add, author, "legal", now)
        await _signed_provenance(db, "Composition", added, _ADDENDUM_SIGNED,
                                 await _note_digest(db, add))
        note.status = "amended"
        if note.ext_cosign_status == "returned":          # the author's answer (D73)
            note.ext_cosign_status = "pending"
            note.ext_cosign_return_comment = note.ext_cosign_returned_at = None
        return AddendumWritten(added, await _written(db, note))

    async def cosign_note(self, db: AsyncSession, note_id: uuid.UUID, *, if_version: int
                          ) -> Written:
        note, cosigner = await _pending_cosign(db, note_id, if_version)
        note.ext_cosign_status = "cosigned"
        written = await _attest(db, note, cosigner, "professional", await _db_now(db))
        await _signed_provenance(db, "Composition", written, _COSIGNED,
                                 await _note_digest(db, note))
        return written

    async def return_note_to_author(self, db: AsyncSession, note_id: uuid.UUID, comment: str,
                                    *, if_version: int) -> Written:
        comment = comment.strip()
        if not comment:
            raise InvalidInput("a return needs a comment", field="comment")
        if len(comment) > 2000:
            raise InvalidInput("a return comment is at most 2,000 characters", field="comment")
        note, _ = await _pending_cosign(db, note_id, if_version)
        now = await _db_now(db)
        note.ext_cosign_status, note.ext_cosign_return_comment = "returned", comment
        note.ext_cosign_returned_at = now
        return await _written(db, note)

    async def note_entered_in_error(self, db: AsyncSession, note_id: uuid.UUID, reason: Reason,
                                    *, if_version: int | None = None) -> Written:
        reason = _require_reason(reason)
        note = await _locked(db, Composition, note_id, if_version)
        if note.status == "entered-in-error":
            raise InvalidTransition(note.status)
        note.status = "entered-in-error"
        written = await _written(db, note)
        await _nullify_provenance(db, "Composition", written, reason)
        return written


#: The contract's VitalType: its US Core vital-sign LOINC code (checked against the NLM LOINC
#: tables) and display.
_VITALS = {
    "blood-pressure": ("85354-9", "Blood pressure panel"),
    "heart-rate": ("8867-4", "Heart rate"),
    "respiratory-rate": ("9279-1", "Respiratory rate"),
    "body-temperature": ("8310-5", "Body temperature"),
    "body-height": ("8302-2", "Body height"),
    "body-weight": ("29463-7", "Body weight"),
    "bmi": ("39156-5", "Body mass index (BMI)"),
    "oxygen-saturation": ("59408-5", "Oxygen saturation by pulse oximetry"),
    "head-circumference": ("9843-4", "Head occipital-frontal circumference"),
}


def _component(sequence: int, loinc: str, display: str, m: Measured) -> ObservationComponent:
    return ObservationComponent(sequence=sequence, code_system=systems.LOINC, code_code=loinc,
                                code_display=display, value_quantity_value=m.value,
                                value_quantity_unit=m.unit, value_quantity_code=m.unit,
                                value_quantity_system=systems.UCUM)


async def _allergy_children(db: AsyncSession, allergy_id: uuid.UUID,
                            data: AllergyIn | AllergyChanges) -> None:
    owner = {"allergy_intolerance_id": allergy_id}
    if _given(data.reactions):
        reactions = []
        for r in data.reactions:
            reaction = AllergyIntoleranceReaction(allergy_intolerance_id=allergy_id,
                                                  severity=r.severity,
                                                  description=r.description, onset=r.onset)
            reaction.manifestation = [AllergyReactionManifestation(
                manifestation_system=m.system, manifestation_code=m.code,
                manifestation_display=m.display, manifestation_text=m.text)
                for m in r.manifestations]
            reactions.append(reaction)
        await _replace(db, AllergyIntoleranceReaction, owner, reactions)
    if _given(data.note):
        await _replace(db, Annotation, owner,
                       [Annotation(allergy_intolerance_id=allergy_id, text=data.note,
                                   time=await _db_now(db))] if data.note else [])


# ---------------------------------------------------------------- prescription internals
#: The contract's SafetyAlert severity -> DetectedIssue.severity.
_SEVERITY = {"info": "low", "warning": "moderate", "high": "high"}
#: The contract's SafetyAlert kind -> DetectedIssue.code (v3 ActCode).
_ALERT_CODE = {"allergy": ("ALGY", "Allergy Alert"),
               "duplicate-medication": ("DUPTHPY", "Duplicate Therapy Alert"),
               "interaction": ("DRG", "Drug Interaction Alert")}
#: Where a NewRx may go next; accepted and rejected are final. An error is replayed (queued).
_TRANSMISSION = {"queued": {"sent", "accepted", "rejected", "error"},
                 "sent": {"accepted", "rejected", "error"},
                 "error": {"queued"}, "accepted": set(), "rejected": set()}
_MED_SYSTEMS = (systems.RXNORM, systems.NDC)


async def _prescription(db: AsyncSession, prescription_id: uuid.UUID, if_version: int | None
                        ) -> MedicationRequest:
    """A prescription (intent order), locked; a medication-list entry the patient reported is
    not one (ResourceNotFound)."""
    mr = await _locked(db, MedicationRequest, prescription_id, if_version)
    if mr.intent != "order":
        raise ResourceNotFound
    return mr


def _check_medication(code: Coded) -> None:
    if not (code.code or code.text):
        raise InvalidInput("the drug needs an RxNorm code or text")
    if code.code and code.system not in _MED_SYSTEMS:
        raise InvalidInput("the drug's code is RxNorm (or NDC)")


#: MedicationCreate.status.
_LIST_STATUSES = frozenset({"active", "completed", "stopped"})


async def _live_visit_of(db: AsyncSession, encounter_id: uuid.UUID, patient_id: uuid.UUID
                         ) -> None:
    enc = (await db.execute(select(Encounter).where(Encounter.id == encounter_id))
           ).scalar_one_or_none()
    if enc is None:
        raise ResourceNotFound
    if enc.subject_patient_id != patient_id or enc.status == "entered-in-error":
        raise InvalidInput("the encounter is not this patient's live visit")


async def _check_pharmacy(db: AsyncSession, pharmacy_id: uuid.UUID | None) -> None:
    if pharmacy_id is None:
        return
    active = (await db.execute(select(Pharmacy.is_active).where(Pharmacy.id == pharmacy_id))
              ).scalar_one_or_none()
    if active is None:
        raise ResourceNotFound
    if not active:
        raise InvalidInput("the pharmacy no longer accepts prescriptions")


def _apply_prescription(mr: MedicationRequest, data: PrescriptionIn | PrescriptionChanges
                        ) -> None:
    if _given(data.medication):
        m = data.medication
        (mr.medication_codeable_concept_system, mr.medication_codeable_concept_code,
         mr.medication_codeable_concept_display, mr.medication_codeable_concept_text) = (
            m.system, m.code, m.display, m.text)
    if _given(data.quantity):
        q = data.quantity
        mr.dispense_request_quantity_value = q.value if q else None
        mr.dispense_request_quantity_unit = q.unit if q else None
    if _given(data.days_supply):
        days = data.days_supply
        mr.dispense_request_expected_supply_duration_value = (Decimal(days) if days is not None
                                                              else None)
        (mr.dispense_request_expected_supply_duration_unit,
         mr.dispense_request_expected_supply_duration_system,
         mr.dispense_request_expected_supply_duration_code) = (
            ("d", systems.UCUM, "d") if days is not None else (None, None, None))
    for field, column in (("refills", "dispense_request_number_of_repeats_allowed"),
                          ("substitution_allowed", "substitution_allowed_boolean"),
                          ("pharmacy_id", "dispense_request_performer_pharmacy_id"),
                          ("note_to_pharmacy", "ext_note_to_pharmacist"),
                          ("dea_schedule", "ext_dea_schedule")):
        if _given(getattr(data, field)):
            setattr(mr, column, getattr(data, field))


async def _replace_dosage(db: AsyncSession, prescription_id: uuid.UUID, sig: str | None
                          ) -> None:
    owner = {"medication_request_id": prescription_id}
    await _replace(db, Dosage, owner,
                   [Dosage(**owner, sequence=1, text=sig)] if sig and sig.strip() else [])


async def _dosage_text(db: AsyncSession, prescription_id: uuid.UUID) -> str | None:
    sig: str | None = (await db.execute(select(Dosage.text).where(
        Dosage.medication_request_id == prescription_id).order_by(Dosage.sequence).limit(1))
                       ).scalar_one_or_none()
    return sig


async def _alert(db: AsyncSession, mr: MedicationRequest, a: AlertIn, now: datetime
                 ) -> tuple[DetectedIssue, list[dict[str, uuid.UUID]]]:
    """A DetectedIssue for one alert (not yet added) and the rows it implicates: the draft, and
    the allergy or list entry behind it, both the draft's patient's."""
    if a.kind not in _ALERT_CODE or a.severity not in _SEVERITY:
        raise InvalidInput(f"unknown alert kind or severity: {a.kind!r}, {a.severity!r}")
    if not a.message.strip():
        raise InvalidInput("an alert needs its message")
    rule = (await db.execute(
        select(CdsRule.id).where(CdsRule.code == a.rule_code, CdsRule.is_active)
        .order_by(CdsRule.tenant_id.is_(None)).limit(1))).scalar_one_or_none()
    if rule is None:
        raise InvalidInput(f"no active CDS rule {a.rule_code!r}")
    implicated: list[dict[str, uuid.UUID]] = [{"medication_request_id": mr.id}]
    if a.allergy_id is not None:
        if (await db.execute(select(AllergyIntolerance.patient_id).where(
                AllergyIntolerance.id == a.allergy_id))).scalar_one_or_none() \
                != mr.subject_patient_id:
            raise InvalidInput("the alert's allergy is not this patient's")
        implicated.append({"allergy_intolerance_id": a.allergy_id})
    if a.medication_id is not None:
        if a.medication_id == mr.id or (await db.execute(
                select(MedicationRequest.subject_patient_id).where(
                    MedicationRequest.id == a.medication_id))).scalar_one_or_none() \
                != mr.subject_patient_id:
            raise InvalidInput("the alert's medication is not another of this patient's")
        implicated.append({"medication_request_id": a.medication_id})
    code, display = _ALERT_CODE[a.kind]
    issue = DetectedIssue(status="final", code_system=systems.DETECTED_ISSUE_CATEGORY,
                          code_code=code, code_display=display, severity=_SEVERITY[a.severity],
                          patient_id=mr.subject_patient_id, identified_date_time=now,
                          detail=a.message, ext_rule_source="deterministic",
                          ext_cds_rule_id=rule)
    return issue, implicated


def _alerts_of(mr: MedicationRequest) -> Any:
    """The alerts of the prescription's latest check: the live DetectedIssues that implicate it,
    identified at its check time (a duplicate alert also implicates the other medication)."""
    return (select(DetectedIssue)
            .join(DetectedIssueImplicated,
                  DetectedIssueImplicated.detected_issue_id == DetectedIssue.id)
            .where(DetectedIssueImplicated.medication_request_id == mr.id,
                   DetectedIssue.identified_date_time == mr.ext_safety_checked_at,
                   DetectedIssue.status.not_in(("cancelled", "entered-in-error")))
            .order_by(DetectedIssue.id))


async def preferred_pharmacy(db: AsyncSession, patient_id: uuid.UUID
                             ) -> PreferredPharmacy | None:
    """The patient's default pharmacy, or None when none is set. ``ResourceNotFound`` for a
    patient the session can't see."""
    if (await db.execute(select(Patient.id).where(Patient.id == patient_id))
            ).scalar_one_or_none() is None:
        raise ResourceNotFound
    row = (await db.execute(
        select(Pharmacy.id, Pharmacy.name, Pharmacy.ncpdp_id, Pharmacy.phone,
               Pharmacy.address_line, Pharmacy.city, Pharmacy.state, Pharmacy.postal_code,
               PatientPharmacy.updated_at)
        .join(PatientPharmacy, PatientPharmacy.pharmacy_id == Pharmacy.id)
        .where(PatientPharmacy.patient_id == patient_id, PatientPharmacy.is_default))).first()
    return PreferredPharmacy(*row) if row is not None else None


async def prescription_alert_ids(db: AsyncSession, prescription_id: uuid.UUID
                                 ) -> list[uuid.UUID]:
    """The prescription's ``alerts`` (its latest check's, live), in the order GET returns them
    and ``SignRefused``'s ``/alerts/{i}`` counts them. Empty when no check has run."""
    mr = (await db.execute(select(MedicationRequest).where(
        MedicationRequest.id == prescription_id))).scalar_one_or_none()
    if mr is None:
        raise ResourceNotFound
    return list((await db.execute(_alerts_of(mr).with_only_columns(DetectedIssue.id))).scalars())


async def _cancel_alerts(db: AsyncSession, prescription_id: uuid.UUID) -> None:
    """Cancels a draft's live alerts (an earlier check's). A draft is never the other
    medication of a duplicate alert, which only names active ones."""
    for issue in (await db.execute(
            select(DetectedIssue).join(DetectedIssueImplicated,
                                       DetectedIssueImplicated.detected_issue_id
                                       == DetectedIssue.id)
            .where(DetectedIssueImplicated.medication_request_id == prescription_id,
                   DetectedIssue.status.not_in(("cancelled", "entered-in-error")))
            .with_for_update(of=DetectedIssue))).scalars().unique():
        issue.status = "cancelled"
        await _written(db, issue)


async def _unmitigated_high_alerts(db: AsyncSession, mr: MedicationRequest) -> list[int]:
    """The indexes, in ``_alerts_of`` order, of the high alerts that have no override yet."""
    mitigated = select(DetectedIssueMitigation.id).where(
        DetectedIssueMitigation.detected_issue_id == DetectedIssue.id).exists()
    rows = (await db.execute(_alerts_of(mr).with_only_columns(
        DetectedIssue.severity, mitigated))).all()
    return [i for i, (severity, done) in enumerate(rows) if severity == "high" and not done]


async def _alert_prescription(db: AsyncSession, alert_id: uuid.UUID) -> uuid.UUID:
    """The prescription whose check raised the alert."""
    prescription_id: uuid.UUID | None = (await db.execute(
        select(MedicationRequest.id)
        .join(DetectedIssueImplicated,
              DetectedIssueImplicated.medication_request_id == MedicationRequest.id)
        .join(DetectedIssue, DetectedIssue.id == DetectedIssueImplicated.detected_issue_id)
        .where(DetectedIssue.id == alert_id,
               DetectedIssue.identified_date_time == MedicationRequest.ext_safety_checked_at)
        .limit(1))).scalar_one_or_none()
    if prescription_id is None:
        raise ResourceNotFound
    return prescription_id


async def _prescription_content(db: AsyncSession, mr: MedicationRequest, sig: str | None
                                ) -> dict[str, Any]:
    """What the prescriber signs: the drug, the sig, the dispense request and the pharmacy."""
    return {"patient": mr.subject_patient_id, "encounter": mr.encounter_id,
            "medication": [mr.medication_codeable_concept_system,
                           mr.medication_codeable_concept_code,
                           mr.medication_codeable_concept_display,
                           mr.medication_codeable_concept_text],
            "dosage": sig, "quantity": [mr.dispense_request_quantity_value,
                                        mr.dispense_request_quantity_unit],
            "days_supply": mr.dispense_request_expected_supply_duration_value,
            "refills": mr.dispense_request_number_of_repeats_allowed,
            "substitution_allowed": mr.substitution_allowed_boolean,
            "pharmacy": mr.dispense_request_performer_pharmacy_id,
            "note_to_pharmacy": mr.ext_note_to_pharmacist, "dea_schedule": mr.ext_dea_schedule}


def _digest(content: dict[str, Any]) -> str:
    """SHA-256 (hex) of the signed content as canonical JSON (sorted keys, no spaces)."""
    body = json.dumps(content, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode()).hexdigest()


# ---------------------------------------------------------------- note internals
_XHTML_OPEN = '<div xmlns="http://www.w3.org/1999/xhtml">'


def _section_text(text: str) -> dict[str, str | None]:
    """A section's text as typed, escaped in one XHTML div; no text is no narrative."""
    if not text:
        return {"text_status": None, "text_div": None}
    return {"text_status": "additional",
            "text_div": f"{_XHTML_OPEN}{html.escape(text, quote=False)}</div>"}


#: US Core's category of a Condition on the problem list (an encounter diagnosis is
#: ``encounter-diagnosis``).
PROBLEM_LIST_ITEM = "problem-list-item"
_PROBLEM_CLINICAL = {"active", "recurrence", "relapse", "inactive", "remission", "resolved"}
_PROBLEM_VERIFICATION = {"unconfirmed", "provisional", "differential", "confirmed", "refuted"}
#: FHIR con-4: a problem with an end date is inactive, resolved or in remission.
_ABATED = {"inactive", "resolved", "remission"}


def _check_problem_status(clinical: str | None, verification: str | None) -> None:
    if clinical not in _PROBLEM_CLINICAL:
        raise InvalidInput(f"clinicalStatus is one of {sorted(_PROBLEM_CLINICAL)}",
                           field="clinicalStatus")
    if verification not in _PROBLEM_VERIFICATION:
        raise InvalidInput(f"verificationStatus is one of {sorted(_PROBLEM_VERIFICATION)}",
                           field="verificationStatus")


def partial_date_span(value: str) -> tuple[date, date]:
    """The days a ``PartialDate`` covers: ``2019`` is 1 Jan to 31 Dec 2019, ``2019-03`` the
    month, ``2019-03-14`` that day. ``ValueError`` for anything else."""
    parts = value.split("-")
    if not 1 <= len(parts) <= 3 or not all(p.isdigit() for p in parts) or len(parts[0]) != 4 \
            or any(len(p) != 2 for p in parts[1:]):
        raise ValueError(f"{value!r} is not YYYY, YYYY-MM or YYYY-MM-DD")
    year = int(parts[0])
    if len(parts) == 1:
        return date(year, 1, 1), date(year, 12, 31)
    month = int(parts[1])
    if len(parts) == 2:
        first = date(year, month, 1)
        following = date(year + month // 12, month % 12 + 1, 1)
        return first, date.fromordinal(following.toordinal() - 1)
    day = date(year, month, int(parts[2]))
    return day, day


def _midnight(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def _partial_date(at: datetime | None, start: datetime | None, end: datetime | None
                  ) -> str | None:
    """The ``PartialDate`` a stored onset or abatement stands for (the inverse of
    ``_set_problem_dates``): a whole year as ``YYYY``, a whole month as ``YYYY-MM``."""
    if at is not None:
        return at.astimezone(UTC).date().isoformat()
    if start is None or end is None:
        return None
    first, last = start.astimezone(UTC).date(), end.astimezone(UTC).date()
    if (first.month, first.day, last.month, last.day) == (1, 1, 12, 31) \
            and first.year == last.year:
        return f"{first.year:04d}"
    if first.day == 1 and partial_date_span(f"{first:%Y-%m}") == (first, last):
        return f"{first:%Y-%m}"
    return first.isoformat()


def problem_dates(cond: Condition) -> tuple[str | None, str | None]:
    """A problem's ``onsetDate`` and ``abatementDate`` as the contract shows them."""
    return (_partial_date(cond.onset_date_time, cond.onset_period_start, cond.onset_period_end),
            _partial_date(cond.abatement_date_time, cond.abatement_period_start,
                          cond.abatement_period_end))


def _set_problem_dates(cond: Condition, onset: str | None, abatement: str | None) -> None:
    """A full date in ``*_date_time``; a year or a month as a period spanning it (the
    conventions in CLAUDE.md), so it stays queryable and reads back as it was given."""
    spans: dict[str, tuple[date, date]] = {}
    for name, value in (("onset", onset), ("abatement", abatement)):
        if value is None:
            continue
        try:
            spans[name] = partial_date_span(value)
        except ValueError as bad:
            raise InvalidInput(str(bad), field=f"{name}Date") from None
    if "onset" in spans and "abatement" in spans and spans["abatement"][1] < spans["onset"][0]:
        raise InvalidInput("abatementDate is before onsetDate", field="abatementDate")
    if "abatement" in spans and cond.clinical_status not in _ABATED:
        raise InvalidInput("a problem with an abatementDate is inactive, resolved or in "
                           "remission", field="clinicalStatus")
    for name in ("onset", "abatement"):
        value = onset if name == "onset" else abatement
        at = start = end = None
        if value is not None:
            first, last = spans[name]
            if len(value) == 10:
                at = _midnight(first)
            else:
                start, end = _midnight(first), _midnight(last)
        setattr(cond, f"{name}_date_time", at)
        setattr(cond, f"{name}_period_start", start)
        setattr(cond, f"{name}_period_end", end)


async def _problem(db: AsyncSession, problem_id: uuid.UUID, if_version: int | None
                   ) -> Condition:
    """A problem-list Condition, locked; not one on a problem list is not found here."""
    on_list = (await db.execute(select(ConditionCategory.condition_id).where(
        ConditionCategory.condition_id == problem_id,
        ConditionCategory.category_code == PROBLEM_LIST_ITEM))).first()
    if on_list is None:
        raise ResourceNotFound
    cond = await _locked(db, Condition, problem_id, if_version)
    if cond.verification_status == "entered-in-error":
        raise InvalidTransition(cond.verification_status)
    return cond


#: Observation category of social history; SNOMED CT "Surgical procedure", the category of a
#: past surgery (D73).
SOCIAL_HISTORY = "social-history"
SURGICAL_PROCEDURE = "387713003"
_FAMILY_STATUSES = {"completed", "partial", "health-unknown"}
_SEXES = {"male", "female", "other", "unknown"}


async def _patient_seen(db: AsyncSession, patient_id: uuid.UUID) -> None:
    """The patient is visible to the session and not merged away (D103)."""
    if (await db.execute(select(Patient.id).where(Patient.id == patient_id))
            ).scalar_one_or_none() is None:
        raise ResourceNotFound
    await _not_merged(db, patient_id)


async def _not_merged(db: AsyncSession, patient_id: uuid.UUID) -> None:
    """A deliberate MVP choice (10 Nov 2026): the ``409 patient-merged`` rule lives in these
    helpers, not in a trigger on every clinical table. A write that bypasses them isn't
    refused."""
    surviving = await merged_into(db, patient_id)
    if surviving is not None:
        raise PatientMerged(surviving)


async def merged_into(db: AsyncSession, patient_id: uuid.UUID) -> uuid.UUID | None:
    """The patient this one was merged into (the contract's ``mergedIntoId``), or None."""
    return (await db.execute(select(PatientLink.other_patient_id).where(
        PatientLink.patient_id == patient_id, PatientLink.type == "replaced-by"))
            ).scalar_one_or_none()


async def chart_patient_ids(db: AsyncSession, patient_id: uuid.UUID) -> list[uuid.UUID]:
    """The patient and every patient merged into it, through earlier merges too: the records a
    read of the surviving chart presents as one (D103)."""
    rows = await db.execute(text(
        "WITH RECURSIVE chart(id) AS (SELECT CAST(:p AS uuid) UNION SELECT l.other_patient_id "
        "FROM clinical.patient_link l JOIN chart c ON l.patient_id = c.id "
        "WHERE l.type = 'replaces') SELECT id FROM chart"), {"p": patient_id})
    return [r[0] for r in rows]


async def patient_merges(db: AsyncSession, patient_id: uuid.UUID) -> list[MergeStatus]:
    """A patient's merges, newest first, each with whether it can still be undone (D51)."""
    blocked = func.admin.patient_merge_undo_blocked_reason(PatientMerge.id)
    rows = await db.execute(select(PatientMerge, blocked).where(
        (PatientMerge.surviving_patient_id == patient_id)
        | (PatientMerge.merged_patient_id == patient_id))
        .order_by(PatientMerge.performed_at.desc(), PatientMerge.created_at.desc()))
    return [MergeStatus(m.id, m.surviving_patient_id, m.merged_patient_id,
                        m.duplicate_candidate_id, m.performed_at, m.performed_by_user_id,
                        m.unmerged_at, m.unmerged_by_user_id, why) for m, why in rows]


async def _open_pair(db: AsyncSession, duplicate_id: uuid.UUID) -> DuplicateCandidate:
    pair = (await db.execute(select(DuplicateCandidate).where(
        DuplicateCandidate.id == duplicate_id).with_for_update())).scalar_one_or_none()
    if pair is None:
        raise ResourceNotFound
    if pair.status != "open":
        raise InvalidTransition(pair.status)
    return pair


async def _lock_pair(db: AsyncSession, a: uuid.UUID, b: uuid.UUID) -> dict[uuid.UUID, Patient]:
    """Both patients locked in id order, so two merges of overlapping pairs can't deadlock."""
    return {pid: await _locked(db, Patient, pid, None) for pid in sorted((a, b))}


def _partial_columns(value: str, field: str, now: datetime
                     ) -> tuple[datetime | None, datetime | None, datetime | None]:
    """A past ``PartialDate`` as (date-time, period start, period end), as
    ``_set_problem_dates`` stores one: a full date as the date-time, a year or month as a
    period spanning it."""
    try:
        first, last = partial_date_span(value)
    except ValueError as bad:
        raise InvalidInput(str(bad), field=field) from None
    if first > now.astimezone(UTC).date():
        raise InvalidInput(f"{field} is in the future", field=field)
    if len(value) == 10:
        return _midnight(first), None, None
    return None, _midnight(first), _midnight(last)


def _age_years(years: int | None) -> dict[str, Any]:
    """An onset age in whole years, as a UCUM ``a`` Age."""
    if years is None:
        return {}
    return {"onset_age_value": Decimal(years), "onset_age_unit": "a",
            "onset_age_system": systems.UCUM, "onset_age_code": "a"}


def _con4(refused: DBAPIError) -> Exception:
    """The database's FHIR con-4 refusal as the input error it is; anything else unchanged."""
    if "fhir_con_4" in str(refused.orig):
        return InvalidInput("a problem with an abatementDate is inactive, resolved or in "
                            "remission", field="clinicalStatus")
    return refused


def section_text(text_div: str | None) -> str:
    """The text of a section the helpers wrote (the contract's ``sections[].text``)."""
    if not text_div:
        return ""
    if not (text_div.startswith(_XHTML_OPEN) and text_div.endswith("</div>")):
        raise ValueError("not a section written by app.db.fhir_store")
    return html.unescape(text_div[len(_XHTML_OPEN):-len("</div>")])


async def _note_digest(db: AsyncSession, note: Composition) -> str:
    """What is signed: the note's type, title, patient, visit and sections (their order, code,
    title and text)."""
    sections = (await db.execute(
        select(CompositionSection.sequence, CompositionSection.code_code,
               CompositionSection.title, CompositionSection.text_div)
        .where(CompositionSection.composition_id == note.id)
        .order_by(CompositionSection.sequence))).all()
    return _digest({"type": [note.type_system, note.type_code], "title": note.title,
                    "patient": note.subject_patient_id, "encounter": note.encounter_id,
                    "sections": [list(s) for s in sections]})


async def _authors(db: AsyncSession, note_id: uuid.UUID) -> set[uuid.UUID | None]:
    return set((await db.execute(select(CompositionAuthor.practitioner_id).where(
        CompositionAuthor.composition_id == note_id))).scalars())


async def _pending_cosign(db: AsyncSession, note_id: uuid.UUID, if_version: int
                          ) -> tuple[Composition, AppUser]:
    """The note, locked, waiting for its co-signature, and the current user, who must be the
    co-signer it names (never its author: checked when it was signed)."""
    note = await _locked(db, Composition, note_id, if_version)
    if note.status not in ("final", "amended"):
        raise InvalidTransition(note.status)
    if note.ext_cosign_status != "pending":
        raise InvalidTransition(note.ext_cosign_status)
    user = await _practitioner(db)
    if user.practitioner_id != note.ext_cosigner_practitioner_id:
        raise InvalidInput("only the co-signer the co-sign rule names may decide")
    return note, user


async def _attest(db: AsyncSession, note: Composition, user: AppUser, mode: str,
                  when: datetime) -> Written:
    """An attester (legal: the signature; professional: the co-signature) with the content's
    digest, and the note's new version."""
    if user.practitioner_id is None:
        raise InvalidInput("only a user linked to a practitioner may do this")
    db.add(CompositionAttester(composition_id=note.id, mode=mode, time=when,
                               party_practitioner_id=user.practitioner_id, ext_user_id=user.id,
                               ext_content_sha256=await _note_digest(db, note)))
    return await _written(db, note)


__all__ = [
    "CoverageOrderTaken",
    "UNSET", "AddendumWritten", "AlertIn", "AllergyChanges", "AllergyIn", "ChildWritten", "Coded",
    "ConsentIn", "CostIn", "CoverageChanges", "CoverageClassIn", "CoverageIn", "DiagnosisIn",
    "DiagnosisWritten", "DispenseQuantity", "EmployerIn", "EncounterIn", "FhirStore",
    "IdentifierIn", "InvalidInput", "InvalidTransition", "Measured", "MedicationIn", "Name",
    "NoteChanges",
    "NoteIn", "ParticipantIn", "PatientChanges", "PatientIn", "PostalAddress",
    "PrescriptionChanges", "PrescriptionIn", "RaceOrEthnicity", "ReactionIn", "Reason",
    "RelatedPersonChanges", "RelatedPersonIn", "ResourceNotFound", "SafetyCheckWritten",
    "SectionIn", "SectionText", "SignRefused", "SqlFhirStore", "StaleVersion", "Telecom",
    "TransmissionWritten", "VitalIn", "Written", "prescription_alert_ids", "section_text",
]
