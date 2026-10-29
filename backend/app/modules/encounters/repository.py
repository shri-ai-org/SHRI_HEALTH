"""Encounter reads for check-in and its undo, under the request's session (row-level security)."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_LIVE = text("""
SELECT e.id FROM clinical.encounter e
WHERE e.appointment_id = :appointment AND e.status <> 'entered-in-error'
""")
# D55: vitals (vital-signs observations), notes (compositions) and diagnoses, none of them
# entered in error.
_CLINICAL = text("""
SELECT EXISTS (SELECT 1 FROM clinical.observation o
                WHERE o.encounter_id = :e AND o.status <> 'entered-in-error')
    OR EXISTS (SELECT 1 FROM clinical.composition c
                WHERE c.encounter_id = :e AND c.status <> 'entered-in-error')
    OR EXISTS (SELECT 1 FROM clinical.encounter_diagnosis d WHERE d.encounter_id = :e)
""")


async def live_encounter(db: AsyncSession, appointment_id: UUID) -> UUID | None:
    found: UUID | None = (await db.execute(_LIVE, {"appointment": appointment_id})
                          ).scalar_one_or_none()
    return found


async def has_clinical_data(db: AsyncSession, encounter_id: UUID) -> bool:
    found: bool = (await db.execute(_CLINICAL, {"e": encounter_id})).scalar_one()
    return found
