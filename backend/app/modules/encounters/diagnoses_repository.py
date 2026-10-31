"""Reads for the encounter's diagnoses, under the request's session (row-level security: another
clinic's rows are simply not found). Writes go through Anand's helpers
(``add_encounter_diagnosis``, ``remove_encounter_diagnosis``).

ICD-10-CM codes are checked against Anand's terminology table, ``admin.concept`` (loaded by
``python -m app.db.terminology icd10cm``, dotted codes with the billable flag), read-only.

``SqlDiagnosisRepository`` is the seam the API uses; the tests replace it with a fake.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import systems

from . import schemas
from .repository import Versioned


@dataclass(frozen=True)
class Concept:
    code: str
    display: str
    billable: bool


@dataclass(frozen=True)
class LiveDiagnosis:
    """A diagnosis that holds a rank on the encounter (not removed, not entered in error)."""
    id: UUID
    system: str | None
    code: str | None
    rank: int


class DiagnosisRepository(Protocol):
    async def icd10cm(self, db: AsyncSession, code: str) -> Concept | None: ...

    async def encounter_signed(self, db: AsyncSession, encounter_id: UUID) -> bool: ...

    async def live(self, db: AsyncSession, encounter_id: UUID) -> list[LiveDiagnosis]: ...

    async def get(self, db: AsyncSession, encounter_id: UUID, diagnosis_id: UUID
                  ) -> Versioned[schemas.EncounterDiagnosis] | None: ...


_CONCEPT = text("""
SELECT c.code, c.display, coalesce(c.is_billable, false) AS billable
FROM admin.concept c JOIN admin.code_system s ON s.id = c.code_system_id
WHERE s.uri = :system AND c.code = :code AND c.is_active
""")
# The encounter is signed once any of its notes is (D24, D73): diagnoses then change only
# through entered-in-error and addenda.
_SIGNED = text("""
SELECT EXISTS (SELECT 1 FROM clinical.composition c
                WHERE c.encounter_id = :e AND c.status IN ('final', 'amended'))
""")
_LIVE = text("""
SELECT c.id, c.code_system, c.code_code, d.rank
FROM clinical.encounter_diagnosis d JOIN clinical.condition c ON c.id = d.condition_id
WHERE d.encounter_id = :e AND c.verification_status IS DISTINCT FROM 'entered-in-error'
ORDER BY d.rank
""")
_ONE = text("""
SELECT c.id, c.encounter_id, d.rank, c.code_system, c.code_code, c.code_display,
       c.verification_status, c.onset_date_time, c.ai_suggestion_id, c.entry_source,
       c.meta_version_id, coalesce(c.recorded_date, c.created_at) AS recorded_at,
       cu.practitioner_id AS by_id, cu.display_name AS by_user_name,
       (SELECT concat_ws(' ', array_to_string(n.prefix, ' '), array_to_string(n.given, ' '),
                         n.family, array_to_string(n.suffix, ' '))
          FROM clinical.human_name n WHERE n.practitioner_id = cu.practitioner_id
         ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) AS by_name
FROM clinical.condition c
LEFT JOIN clinical.encounter_diagnosis d
       ON d.condition_id = c.id AND d.encounter_id = c.encounter_id
LEFT JOIN admin.app_user cu ON cu.id = c.created_by_user_id
WHERE c.id = :id AND c.encounter_id = :e
  AND EXISTS (SELECT 1 FROM clinical.condition_category k
               WHERE k.condition_id = c.id AND k.category_code = 'encounter-diagnosis')
""")


def diagnosis_out(r: Any) -> schemas.EncounterDiagnosis:
    by = None
    if r["by_id"] is not None:
        name = " ".join((r["by_name"] or r["by_user_name"] or "").split())
        by = schemas.ClinicianRef(id=r["by_id"], display_name=name or "Unnamed clinician")
    onset = r["onset_date_time"]
    return schemas.EncounterDiagnosis(
        id=r["id"], encounter_id=r["encounter_id"], rank=r["rank"],
        code=schemas.Coding(system=r["code_system"], code=r["code_code"],
                            display=r["code_display"]),
        verification_status=r["verification_status"] or "confirmed",
        onset_date=onset.date().isoformat() if onset else None,
        ai_suggestion_id=r["ai_suggestion_id"], entry_source=r["entry_source"],
        recorded_at=r["recorded_at"], recorded_by=by)


class SqlDiagnosisRepository:
    async def icd10cm(self, db: AsyncSession, code: str) -> Concept | None:
        r = (await db.execute(_CONCEPT, {"system": systems.ICD10CM, "code": code})
             ).mappings().first()
        return Concept(r["code"], r["display"], r["billable"]) if r else None

    async def encounter_signed(self, db: AsyncSession, encounter_id: UUID) -> bool:
        signed: bool = (await db.execute(_SIGNED, {"e": encounter_id})).scalar_one()
        return signed

    async def live(self, db: AsyncSession, encounter_id: UUID) -> list[LiveDiagnosis]:
        return [LiveDiagnosis(r[0], r[1], r[2], r[3])
                for r in (await db.execute(_LIVE, {"e": encounter_id})).all()]

    async def get(self, db: AsyncSession, encounter_id: UUID, diagnosis_id: UUID
                  ) -> Versioned[schemas.EncounterDiagnosis] | None:
        r = (await db.execute(_ONE, {"id": diagnosis_id, "e": encounter_id})).mappings().first()
        if r is None:
            return None
        return Versioned(diagnosis_out(r), r["meta_version_id"])
