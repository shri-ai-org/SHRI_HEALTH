"""The eligibility service booking, check-in and the pre-visit batch use (IMPL_BATCH1_PLAN §2.3).

So far it records the check: a ``pending`` row for the patient's primary active coverage, in the
caller's transaction (ADR-0011). Sending the 270 through core's outbox (``enqueue``, T29) and
filing the 271 come with PR-6a/6b; until then the row stays ``pending``.
"""

from __future__ import annotations

from datetime import date
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from . import repository

TRIGGERS = ("booking", "pre-visit-batch", "check-in", "manual")  # D15


async def primary_coverage(db: AsyncSession, patient_id: UUID, on: date) -> UUID | None:
    """The patient's active coverage with the lowest order that covers the day; None when the
    patient has none (self-pay, or check-in refuses, DATA_OWNERSHIP §5.1)."""
    return await repository.primary_coverage(db, patient_id, on)


async def record_check(db: AsyncSession, *, coverage_id: UUID, patient_id: UUID,
                       appointment_id: UUID | None, encounter_id: UUID | None,
                       trigger: str) -> UUID:
    if trigger not in TRIGGERS:
        raise ValueError(f"unknown eligibility trigger {trigger!r}")
    return await repository.insert_pending(db, coverage_id=coverage_id, patient_id=patient_id,
                                           appointment_id=appointment_id,
                                           encounter_id=encounter_id, trigger=trigger)
