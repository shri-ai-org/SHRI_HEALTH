"""Reads and the payment insert for the billing API, in plain SQL under the request's session.

Row-level security does the clinic filtering: the session from ``tenant_db`` sees only the
caller's clinic, so another clinic's patient, appointment or encounter is simply not found, and
no query here names a tenant except the insert, which must fill ``tenant_id`` (the session's
clinic, ``session.info``; the policy's WITH CHECK refuses any other).

Contract to column (``backend/app/db/CLAUDE.md``, "Payment receipts"):

- Payment: ``admin.patient_payment``; ``refund`` is ``is_refund``, ``checkNumber``
  ``check_number``, ``receiptFileId`` ``receipt_file_id`` (required, D104).
- A merged patient (D103) is one with a ``clinical.patient_link`` of type ``replaced-by``; its
  ``other_patient_id`` is the contract's ``mergedIntoId``.
- The patient's name on the receipt is its ``official`` ``human_name`` (else the first one).
- The practice is ``admin.tenant`` (its ``name`` and ``timezone``), visible to its own clinic only.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import TENANT_ID_INFO_KEY


@dataclass(frozen=True)
class PatientForPayment:
    id: UUID
    name: str  # official name, "Given Family", for the receipt
    merged_into_id: UUID | None  # the surviving patient, when this one was merged (D103)


@dataclass(frozen=True)
class EncounterLink:
    patient_id: UUID
    appointment_id: UUID | None


@dataclass(frozen=True)
class Practice:
    name: str
    time_zone: str


@dataclass(frozen=True)
class NewPayment:
    id: UUID
    patient_id: UUID
    appointment_id: UUID | None
    encounter_id: UUID | None
    amount: Decimal
    method: str
    collected_at: datetime
    collected_by_user_id: UUID
    receipt_file_id: UUID
    check_number: str | None
    note: str | None


class PaymentRepository(Protocol):
    async def patient(self, db: AsyncSession, patient_id: UUID) -> PatientForPayment | None: ...

    async def appointment_patient(self, db: AsyncSession, appointment_id: UUID
                                  ) -> UUID | None:
        """The appointment's patient, or None when the clinic has no such appointment."""
        ...

    async def encounter(self, db: AsyncSession, encounter_id: UUID) -> EncounterLink | None: ...

    async def practice(self, db: AsyncSession) -> Practice: ...

    async def insert_payment(self, db: AsyncSession, payment: NewPayment) -> None: ...


_PATIENT = text("""
SELECT p.id,
       (SELECT l.other_patient_id FROM clinical.patient_link l
         WHERE l.patient_id = p.id AND l.type = 'replaced-by' LIMIT 1) AS merged_into_id
FROM clinical.patient p WHERE p.id = :id
""")
_NAMES = text("""
SELECT use, family, given, text FROM clinical.human_name WHERE patient_id = :id
ORDER BY (use = 'official') DESC NULLS LAST, created_at, id
""")
_APPOINTMENT = text("SELECT subject_patient_id FROM clinical.appointment WHERE id = :id")
_ENCOUNTER = text("""
SELECT subject_patient_id, appointment_id FROM clinical.encounter WHERE id = :id
""")
_PRACTICE = text("SELECT name, timezone FROM admin.tenant")
_INSERT = text("""
INSERT INTO admin.patient_payment
    (id, tenant_id, patient_id, appointment_id, encounter_id, amount, method, collected_at,
     collected_by_user_id, is_refund, receipt_file_id, check_number, note,
     created_by_user_id, updated_by_user_id)
VALUES (:id, :tenant_id, :patient_id, :appointment_id, :encounter_id, :amount, :method,
        :collected_at, :user_id, false, :receipt_file_id, :check_number, :note,
        :user_id, :user_id)
""")


def display_name(given: Sequence[str] | None, family: str | None, fallback: str | None) -> str:
    parts = [*(given or ()), *([family] if family else [])]
    return " ".join(p for p in parts if p) or (fallback or "")


class SqlPaymentRepository:
    async def patient(self, db: AsyncSession, patient_id: UUID) -> PatientForPayment | None:
        row = (await db.execute(_PATIENT, {"id": patient_id})).one_or_none()
        if row is None:
            return None
        name = (await db.execute(_NAMES, {"id": patient_id})).first()
        return PatientForPayment(
            id=row.id, merged_into_id=row.merged_into_id,
            name=display_name(name.given, name.family, name.text) if name else "")

    async def appointment_patient(self, db: AsyncSession, appointment_id: UUID
                                  ) -> UUID | None:
        found: UUID | None = (await db.execute(_APPOINTMENT, {"id": appointment_id})
                              ).scalar_one_or_none()
        return found

    async def encounter(self, db: AsyncSession, encounter_id: UUID) -> EncounterLink | None:
        row = (await db.execute(_ENCOUNTER, {"id": encounter_id})).one_or_none()
        return EncounterLink(row.subject_patient_id, row.appointment_id) if row else None

    async def practice(self, db: AsyncSession) -> Practice:
        row = (await db.execute(_PRACTICE)).one()
        return Practice(name=row.name, time_zone=row.timezone)

    async def insert_payment(self, db: AsyncSession, payment: NewPayment) -> None:
        await db.execute(_INSERT, {
            "id": payment.id, "tenant_id": db.info[TENANT_ID_INFO_KEY],
            "patient_id": payment.patient_id, "appointment_id": payment.appointment_id,
            "encounter_id": payment.encounter_id, "amount": payment.amount,
            "method": payment.method, "collected_at": payment.collected_at,
            "user_id": payment.collected_by_user_id, "receipt_file_id": payment.receipt_file_id,
            "check_number": payment.check_number, "note": payment.note})
