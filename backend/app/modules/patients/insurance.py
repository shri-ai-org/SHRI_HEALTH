"""Rules for coverages and consents (patients.yaml; batch 1 plan, PR-2; D45).

As in service.py: reads through the repositories, writes through Anand's FHIR write helpers, one
commit per request, and core's middleware writes the audit rows in the same commit (#79).
"""

from __future__ import annotations

from datetime import date
from typing import cast
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound, ValidationFailed, field_error

from . import schemas
from .insurance_repository import InsuranceRepository
from .repository import Versioned
from .service import business_rule, if_match_version, stale, to_pointer, writable
from .store import (
    UNSET,
    Coded,
    ConsentIn,
    CoverageChanges,
    CoverageClassIn,
    CoverageIn,
    FhirStore,
    InvalidInput,
    InvalidTransition,
    Reason,
    ResourceNotFound,
    StaleVersion,
)

LOINC = "http://loinc.org"
CONSENT_CATEGORY = "http://terminology.hl7.org/CodeSystem/consentcategorycodes"
ACT_CODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode"

#: Category by consent kind, as agreed with Anand on #88 (FHIR R4 Consent Category value set;
#: financial keeps one fixed code). The scope comes from the kind in the helpers.
CATEGORIES: dict[str, tuple[Coded, ...]] = {
    "treatment": (Coded(LOINC, "59284-0", "Patient Consent"),),
    "telehealth": (Coded(LOINC, "59284-0", "Patient Consent"),),
    "financial": (Coded(LOINC, "59284-0", "Patient Consent"),),
    "privacy-notice": (Coded(CONSENT_CATEGORY, "npp", "Notice of Privacy Practices"),
                       Coded(LOINC, "57016-8", "Privacy policy acknowledgement Document")),
    "information-sharing": (Coded(LOINC, "64292-6", "Release of information consent"),
                            Coded(ACT_CODE, "IDSCL", "information disclosure")),
    "ambient-recording": (Coded(ACT_CODE, "ICOL", "information collection"),),
    "research": (Coded(CONSENT_CATEGORY, "research", "Research Information Access"),),
}

_ORDER_TAKEN = "uq_coverage_active_order"


def _invalid(where: str, code: str) -> ValidationFailed:
    return ValidationFailed(errors=[field_error("body", where, code)])


# ------------------------------------------------------------------------------- coverage rules
async def _check_coverage(db: AsyncSession, repo: InsuranceRepository, patient_id: UUID, *,
                          relationship: str, subscriber_related_person_id: UUID | None,
                          group_number: str | None, group_name: str | None,
                          start: date | None, end: date | None) -> None:
    if relationship == "self" and subscriber_related_person_id is not None:
        raise business_rule("body", "/subscriberRelatedPersonId", "conflicting-fields")
    if subscriber_related_person_id is not None and not await repo.is_related_person(
            db, patient_id, subscriber_related_person_id):
        raise business_rule("body", "/subscriberRelatedPersonId", "invalid-reference")
    if group_name and not group_number:  # a group needs its number (mapping, #87)
        raise business_rule("body", "/groupNumber", "required")
    if start is not None and end is not None and end < start:
        raise business_rule("body", "/endDate", "out-of-range")


async def _check_payer(db: AsyncSession, repo: InsuranceRepository, payer_id: UUID) -> None:
    usable = await repo.payer_usable(db, payer_id)
    if usable is None:
        raise business_rule("body", "/payerId", "invalid-reference")
    if not usable:
        raise business_rule("body", "/payerId", "not-allowed-value")  # the payer is inactive


async def _check_order(db: AsyncSession, repo: InsuranceRepository, patient_id: UUID, order: int,
                       exclude: UUID | None = None) -> None:
    if order in await repo.active_orders(db, patient_id, exclude):
        raise business_rule("body", "/order", "not-allowed-value")


def _classes(group_number: str | None, group_name: str | None, plan_name: str | None
             ) -> tuple[CoverageClassIn, ...]:
    """A group row (its number, and its name), and a plan row: the contract has no plan ID and
    FHIR requires a value, so value and name are both the plan name (mapping, #87)."""
    group = (CoverageClassIn("group", group_number, group_name),) if group_number else ()
    plan = (CoverageClassIn("plan", plan_name, plan_name),) if plan_name else ()
    return group + plan


async def _commit_coverage(db: AsyncSession) -> None:
    """Two requests racing for the same order: the database's unique index decides."""
    try:
        await db.commit()
    except IntegrityError as clash:
        await db.rollback()
        if _ORDER_TAKEN in str(clash.orig):
            raise business_rule("body", "/order", "not-allowed-value") from clash
        raise


async def add_coverage(db: AsyncSession, repo: InsuranceRepository, store: FhirStore,
                       patient: schemas.Patient, body: schemas.CoverageCreate
                       ) -> Versioned[schemas.Coverage]:
    writable(patient)
    await _check_coverage(db, repo, patient.id, relationship=body.relationship_to_subscriber,
                          subscriber_related_person_id=body.subscriber_related_person_id,
                          group_number=body.group_number, group_name=body.group_name,
                          start=body.start_date, end=body.end_date)
    await _check_payer(db, repo, body.payer_id)
    await _check_order(db, repo, patient.id, body.order)
    self_paid = body.relationship_to_subscriber == "self"
    written = await store.create_coverage(db, CoverageIn(
        beneficiary_patient_id=patient.id, payer_id=body.payer_id, member_id=body.member_id,
        subscriber_id=body.subscriber_id,
        subscriber_patient_id=patient.id if self_paid else None,
        subscriber_related_person_id=body.subscriber_related_person_id,
        relationship_code=body.relationship_to_subscriber, order=body.order,
        period_start=body.start_date, period_end=body.end_date,
        classes=_classes(body.group_number, body.group_name, body.plan_name)))
    await _commit_coverage(db)
    return await repo.get_coverage(db, patient.id, written.id)


_NOT_NULLABLE = ("order", "payer_id", "member_id", "relationship_to_subscriber", "start_date",
                 "end_date")


async def update_coverage(db: AsyncSession, repo: InsuranceRepository, store: FhirStore,
                          patient: schemas.Patient, coverage_id: UUID,
                          patch: schemas.CoveragePatch, if_match: str | None
                          ) -> Versioned[schemas.Coverage]:
    """JSON Merge Patch. Setting `endDate` ends the coverage (D45); an entered-in-error coverage
    never changes again."""
    version = if_match_version(if_match)
    writable(patient)
    current = (await repo.get_coverage(db, patient.id, coverage_id)).value
    sent = patch.model_fields_set
    for field in _NOT_NULLABLE:
        if field in sent and getattr(patch, field) is None:
            raise _invalid("/" + to_pointer(field), "invalid-type")
    if "payer_id" in sent and patch.payer_id != current.payer_id:
        # Anand's update_coverage can't replace the payer yet (#88 review): refused, not dropped.
        raise business_rule("body", "/payerId", "not-editable")

    def value[T](field: str, now: T) -> T:
        return cast(T, getattr(patch, field)) if field in sent else now

    relationship = value("relationship_to_subscriber", current.relationship_to_subscriber)
    subscriber = value("subscriber_related_person_id", current.subscriber_related_person_id)
    if relationship == "self" and "subscriber_related_person_id" not in sent:
        subscriber = None  # becoming self clears the related subscriber
    group_number = value("group_number", current.group_number)
    group_name = value("group_name", current.group_name)
    plan_name = value("plan_name", current.plan_name)
    start, end = value("start_date", current.start_date), value("end_date", current.end_date)
    await _check_coverage(db, repo, patient.id, relationship=relationship,
                          subscriber_related_person_id=subscriber, group_number=group_number,
                          group_name=group_name, start=start, end=end)
    if patch.order is not None and patch.order != current.order and current.status == "active":
        await _check_order(db, repo, patient.id, patch.order, exclude=coverage_id)
    subscriber_sent = "relationship_to_subscriber" in sent or "subscriber_related_person_id" in sent
    classes_sent = bool({"group_number", "group_name", "plan_name"} & sent)
    changes = CoverageChanges(
        member_id=patch.member_id if "member_id" in sent else UNSET,
        subscriber_id=patch.subscriber_id if "subscriber_id" in sent else UNSET,
        subscriber_patient_id=(patient.id if relationship == "self" else None)
        if subscriber_sent else UNSET,
        subscriber_related_person_id=subscriber if subscriber_sent else UNSET,
        relationship_code=relationship if "relationship_to_subscriber" in sent else UNSET,
        order=patch.order if "order" in sent else UNSET,
        period_start=start if "start_date" in sent else UNSET,
        period_end=end if "end_date" in sent else UNSET,
        classes=_classes(group_number, group_name, plan_name) if classes_sent else UNSET)
    try:
        await store.update_coverage(db, coverage_id, changes, if_version=version)
    except StaleVersion as changed:
        raise stale(changed) from changed
    except ResourceNotFound as gone:
        raise NotFound() from gone
    except InvalidTransition as final:  # entered-in-error: never used or changed again (D45)
        raise business_rule("body", "", "not-editable") from final
    except InvalidInput as refused:
        raise business_rule("body", "", "not-allowed-value") from refused
    await _commit_coverage(db)
    return await repo.get_coverage(db, patient.id, coverage_id)


async def coverage_entered_in_error(db: AsyncSession, repo: InsuranceRepository,
                                    store: FhirStore, patient: schemas.Patient, coverage_id: UUID,
                                    body: schemas.EnteredInErrorRequest
                                    ) -> Versioned[schemas.Coverage]:
    """Recorded by mistake (D45): kept, with its Provenance, and never used again."""
    writable(patient)
    await repo.get_coverage(db, patient.id, coverage_id)  # 404 if not this patient's
    try:
        await store.coverage_entered_in_error(db, coverage_id, Reason(text=body.reason))
    except InvalidTransition as already:
        raise Conflict(code="invalid-state-transition",
                       currentState=already.current_state) from already
    except ResourceNotFound as gone:
        raise NotFound() from gone
    await db.commit()
    return await repo.get_coverage(db, patient.id, coverage_id)


# -------------------------------------------------------------------------------------- consents
async def record_consent(db: AsyncSession, repo: InsuranceRepository, store: FhirStore,
                         patient: schemas.Patient, body: schemas.ConsentCreate
                         ) -> Versioned[schemas.Consent]:
    """Insert-only: the helpers make the patient's earlier active consent of the same kind
    inactive, in the same transaction."""
    writable(patient)
    grantor = body.grantor_related_person_id
    if grantor is not None and not await repo.is_related_person(db, patient.id, grantor):
        raise business_rule("body", "/grantorRelatedPersonId", "invalid-reference")
    if body.signed_form_file_id is not None and not await repo.file_ready(
            db, body.signed_form_file_id, "document"):
        raise ValidationFailed(code="file-not-ready", fileId=str(body.signed_form_file_id))
    written = await store.create_consent(db, ConsentIn(
        patient_id=patient.id, kind=body.kind, status="active", categories=CATEGORIES[body.kind],
        date_time=body.signed_at, policy_version=body.policy_version,
        signature_method=body.signature_method, provision_type=body.decision,
        grantor_related_person_id=grantor,
        source_attachment_binary_object_id=body.signed_form_file_id,
        performer_patient_id=None if grantor else patient.id,
        performer_related_person_id=grantor))
    await db.commit()
    return await repo.get_consent(db, patient.id, written.id)
