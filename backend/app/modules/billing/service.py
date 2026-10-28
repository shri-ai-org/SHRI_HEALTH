"""Rules for recording a patient payment (``recordPayment``; D58, D100, D104).

The service owns the transaction: it reads through the repository, makes the receipt, stores it
through the file service and inserts the payment, then commits once, so the payment and its
receipt row land together or not at all. Core writes the audit rows inside that commit and
handles the Idempotency-Key around it (``tenant_db``); nothing here does either.

The order of the checks:

1. ``404 not-found``: the clinic has no such patient (row-level security hides other clinics').
2. ``409 patient-merged``: the patient was merged into another chart (D103), with
   ``mergedIntoId`` (API_STANDARDS §9.3).
3. ``422 business-rule-violation``, every rule that fails at once, each naming its field:
   - ``card`` is refused (``/method``, ``not-allowed-value``): card sessions don't exist yet, so
     the demo takes cash, check and ACH;
   - ``cardSessionId`` is refused with any method (``/cardSessionId``, ``not-allowed-value``),
     as the contract says for a method other than card;
   - ``checkNumber`` without ``check`` (``/checkNumber``, ``conflicting-fields``);
   - an amount that isn't positive (``/amount/value``, ``out-of-range``);
   - an ``appointmentId`` or ``encounterId`` that isn't this patient's, or an encounter that
     isn't the given appointment's (``invalid-reference``).

There is no restricted-chart check: payment is collected at check-in or check-out, so it works
for a restricted patient as check-in does (the contract; SECURITY_MODEL §5.2).
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import Conflict, NotFound, ValidationFailed, field_error
from app.modules.files.storage import FileStore, store_generated

from . import receipt, schemas
from .repository import NewPayment, PaymentRepository

RECEIPT_PURPOSE = "receipt"


def _rule(errors: list[dict[str, str]]) -> ValidationFailed:
    detail = "1 rule is not met." if len(errors) == 1 else f"{len(errors)} rules are not met."
    return ValidationFailed(detail, code="business-rule-violation", errors=errors)


def body_rule_errors(body: schemas.PaymentCreate) -> list[dict[str, str]]:
    """The rules on the body alone (no reads)."""
    errors = []
    if body.method == "card":
        errors.append(field_error("body", "/method", "not-allowed-value"))
    if body.card_session_id is not None:
        errors.append(field_error("body", "/cardSessionId", "not-allowed-value"))
    if body.check_number is not None and body.method != "check":
        errors.append(field_error("body", "/checkNumber", "conflicting-fields"))
    if body.amount.amount <= Decimal(0):
        errors.append(field_error("body", "/amount/value", "out-of-range"))
    return errors


async def reference_errors(db: AsyncSession, repo: PaymentRepository, patient_id: UUID,
                           body: schemas.PaymentCreate) -> list[dict[str, str]]:
    """The appointment and the encounter must be this patient's, and the encounter the
    appointment's when both are given. A record the clinic doesn't have counts the same."""
    errors = []
    if body.appointment_id is not None:
        owner = await repo.appointment_patient(db, body.appointment_id)
        if owner != patient_id:
            errors.append(field_error("body", "/appointmentId", "invalid-reference"))
    if body.encounter_id is not None:
        encounter = await repo.encounter(db, body.encounter_id)
        if (encounter is None or encounter.patient_id != patient_id
                or (body.appointment_id is not None
                    and encounter.appointment_id != body.appointment_id)):
            errors.append(field_error("body", "/encounterId", "invalid-reference"))
    return errors


def _now() -> datetime:
    """Whole seconds: responses carry at most millisecond precision (Timestamp.yaml)."""
    return datetime.now(UTC).replace(microsecond=0)


async def record_payment(db: AsyncSession, repo: PaymentRepository, store: FileStore,
                         user: CurrentUser, patient_id: UUID, body: schemas.PaymentCreate
                         ) -> schemas.Payment:
    patient = await repo.patient(db, patient_id)
    if patient is None:
        raise NotFound("Patient not found")
    if patient.merged_into_id is not None:
        raise Conflict("The patient was merged into another record", code="patient-merged",
                       mergedIntoId=str(patient.merged_into_id))
    errors = body_rule_errors(body)
    errors += await reference_errors(db, repo, patient_id, body)
    if errors:
        raise _rule(errors)

    practice = await repo.practice(db)
    payment_id, collected_at = uuid4(), _now()
    amount = body.amount.amount
    pdf = receipt.render(receipt.ReceiptDetails(
        practice_name=practice.name, patient_name=patient.name, payment_id=payment_id,
        collected_at=collected_at, amount=amount, currency=body.amount.currency,
        method=body.method, check_number=body.check_number, note=body.note,
        time_zone=practice.time_zone))
    receipt_file_id = await store_generated(db, store, purpose=RECEIPT_PURPOSE,
                                            content_type=receipt.CONTENT_TYPE, data=pdf)
    await repo.insert_payment(db, NewPayment(
        id=payment_id, patient_id=patient_id, appointment_id=body.appointment_id,
        encounter_id=body.encounter_id, amount=amount, method=body.method,
        collected_at=collected_at, collected_by_user_id=user.id,
        receipt_file_id=receipt_file_id, check_number=body.check_number, note=body.note))
    await db.commit()
    return schemas.Payment(
        id=payment_id, patient_id=patient_id, appointment_id=body.appointment_id,
        encounter_id=body.encounter_id, amount=schemas.Money.of(amount, body.amount.currency),
        method=body.method, receipt_file_id=receipt_file_id, collected_at=collected_at,
        collected_by_user_id=user.id, refund=False)


def etag() -> str:
    """A payment is never edited through the API (a correction is a refund, a new payment) and
    its table has no version column, so every payment's first and only version is ``"1"``."""
    return '"1"'


def location(patient_id: UUID, payment_id: UUID) -> str:
    return f"/api/v1/patients/{patient_id}/payments/{payment_id}"
