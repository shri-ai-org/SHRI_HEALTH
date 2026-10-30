"""Eligibility rows, under the request's session (row-level security)."""

from __future__ import annotations

from datetime import date
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MAPPERS

M = MAPPERS
CLEARINGHOUSE = "clearinghouse"  # the outbox partner (D25); the vendor is Q11

_PRIMARY = text("""
SELECT c.id FROM clinical.coverage c
WHERE c.beneficiary_patient_id = :patient AND c.status = 'active'
  AND (c.period_start IS NULL OR c.period_start <= :on)
  AND (c.period_end IS NULL OR c.period_end >= :on)
ORDER BY c."order" NULLS LAST, c.created_at
LIMIT 1
""")


async def primary_coverage(db: AsyncSession, patient_id: UUID, on: date) -> UUID | None:
    found: UUID | None = (await db.execute(_PRIMARY, {"patient": patient_id, "on": on})
                          ).scalar_one_or_none()
    return found


async def insert_pending(db: AsyncSession, *, coverage_id: UUID, patient_id: UUID,
                         appointment_id: UUID | None, encounter_id: UUID | None,
                         trigger: str) -> UUID:
    now = (await db.execute(text("SELECT now()"))).scalar_one()
    user = (await db.execute(text(
        "SELECT NULLIF(current_setting('app.current_user_id', true), '')"))).scalar_one()
    row = M["eligibility_check"](
        coverage_id=coverage_id, patient_id=patient_id, appointment_id=appointment_id,
        encounter_id=encounter_id, trigger=trigger, clearinghouse=CLEARINGHOUSE,
        status="pending", requested_at=now, requested_by_user_id=UUID(user) if user else None)
    db.add(row)
    await db.flush()
    check_id: UUID = row.id
    return check_id
