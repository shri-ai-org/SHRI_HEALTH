"""Allergy reads under the request's session (row-level security: another clinic's patient or
allergy is simply not found). Allergies are written through Anand's helpers
(``app.db.fhir_store``: ``create_allergy``, ``update_allergy``, ``allergy_entered_in_error``),
never here. Columns as ``backend/app/db/docs/contract_mapping.yaml`` maps them; ``onsetDate`` is
read back from ``onset_date_time`` (see the service on partial dates).

``SqlAllergyRepository`` is the seam the API uses; the tests replace it with an in-memory fake.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound

from ..encounters import service as encounters
from ..encounters.schemas import ClinicianRef, CodeableConcept, Coding
from . import schemas


@dataclass(frozen=True)
class AllergyRow:
    value: schemas.Allergy
    version: int  # the ETag's source
    created_by_user_id: UUID | None  # RN marks only their own entries entered-in-error


class AllergyRepository(Protocol):
    async def list(self, db: AsyncSession, patient_id: UUID, *, include_entered_in_error: bool,
                   limit: int, offset: int) -> list[schemas.Allergy]: ...

    async def get(self, db: AsyncSession, patient_id: UUID, allergy_id: UUID) -> AllergyRow: ...

    async def visit_of(self, db: AsyncSession, encounter_id: UUID) -> tuple[UUID, str] | None:
        """The encounter's patient and status (the encounters service), or None."""
        ...


_ALLERGIES = text("""
SELECT a.id, a.patient_id, a.clinical_status, a.verification_status, a.encounter_id,
       a.code_system, a.code_code, a.code_display, a.code_text, a.type, a.category,
       a.criticality, a.onset_date_time, a.entry_source, a.meta_version_id,
       a.created_by_user_id, coalesce(a.recorded_date, a.created_at) AS recorded_at,
       (SELECT n.text FROM clinical.annotation n WHERE n.allergy_intolerance_id = a.id
         ORDER BY n.created_at DESC, n.id LIMIT 1) AS note,
       ru.practitioner_id AS by_id, coalesce(rn.name, ru.display_name) AS by_name
FROM clinical.allergy_intolerance a
LEFT JOIN admin.app_user ru ON ru.id = a.created_by_user_id
LEFT JOIN LATERAL (SELECT concat_ws(' ', array_to_string(n.prefix, ' '),
                                    array_to_string(n.given, ' '), n.family,
                                    array_to_string(n.suffix, ' ')) AS name
                     FROM clinical.human_name n WHERE n.practitioner_id = ru.practitioner_id
                    ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) rn ON true
WHERE a.patient_id = :patient
  AND (CAST(:id AS uuid) IS NULL OR a.id = :id)
  AND (:include_eie OR a.verification_status IS DISTINCT FROM 'entered-in-error')
ORDER BY coalesce(a.recorded_date, a.created_at) DESC, a.id
LIMIT :limit OFFSET :offset
""")
_REACTIONS = text("""
SELECT r.allergy_intolerance_id, r.id, r.severity, r.description, r.onset,
       m.manifestation_system, m.manifestation_code, m.manifestation_display,
       m.manifestation_text
FROM clinical.allergy_intolerance_reaction r
LEFT JOIN clinical.allergy_reaction_manifestation m ON m.reaction_id = r.id
WHERE r.allergy_intolerance_id = ANY(:ids)
ORDER BY r.created_at, r.id, m.created_at, m.id
""")


def concept(system: str | None, code: str | None, display: str | None, txt: str | None
            ) -> CodeableConcept:
    codings = [Coding(system=system, code=code, display=display)] if system and code else []
    return CodeableConcept(codings=codings, text=txt)


def _who(by_id: UUID | None, by_name: str | None) -> ClinicianRef | None:
    if by_id is None:
        return None
    return ClinicianRef(id=by_id, display_name=" ".join((by_name or "").split())
                        or "Unnamed clinician")


def _allergy(r: Any, reactions: list[schemas.AllergyReactionOut]) -> schemas.Allergy:
    return schemas.Allergy(
        id=r["id"], patient_id=r["patient_id"], clinical_status=r["clinical_status"],
        verification_status=r["verification_status"], encounter_id=r["encounter_id"],
        code=concept(r["code_system"], r["code_code"], r["code_display"], r["code_text"]),
        type=r["type"], categories=list(r["category"] or []) or None,
        criticality=r["criticality"],
        onset_date=r["onset_date_time"].date().isoformat() if r["onset_date_time"] else None,
        reactions=reactions or None, note=r["note"], entry_source=r["entry_source"],
        recorded_at=r["recorded_at"], recorded_by=_who(r["by_id"], r["by_name"]))


class SqlAllergyRepository:
    async def _reactions(self, db: AsyncSession, ids: Sequence[UUID]
                         ) -> dict[UUID, list[schemas.AllergyReactionOut]]:
        if not ids:
            return {}
        grouped: dict[UUID, dict[UUID, schemas.AllergyReactionOut]] = {}
        for r in (await db.execute(_REACTIONS, {"ids": list(ids)})).mappings():
            reactions = grouped.setdefault(r["allergy_intolerance_id"], {})
            reaction = reactions.get(r["id"])
            if reaction is None:
                reaction = reactions[r["id"]] = schemas.AllergyReactionOut(
                    manifestations=[], severity=r["severity"], description=r["description"],
                    onset_date=r["onset"].date().isoformat() if r["onset"] else None)
            if r["manifestation_code"] or r["manifestation_text"]:
                reaction.manifestations.append(concept(
                    r["manifestation_system"], r["manifestation_code"],
                    r["manifestation_display"], r["manifestation_text"]))
        return {k: list(v.values()) for k, v in grouped.items()}

    async def _rows(self, db: AsyncSession, patient_id: UUID, allergy_id: UUID | None, *,
                    include_entered_in_error: bool, limit: int, offset: int) -> list[Any]:
        return list((await db.execute(_ALLERGIES, {
            "patient": patient_id, "id": allergy_id, "include_eie": include_entered_in_error,
            "limit": limit, "offset": offset})).mappings())

    async def list(self, db: AsyncSession, patient_id: UUID, *, include_entered_in_error: bool,
                   limit: int, offset: int) -> list[schemas.Allergy]:
        rows = await self._rows(db, patient_id, None, limit=limit, offset=offset,
                                include_entered_in_error=include_entered_in_error)
        reactions = await self._reactions(db, [r["id"] for r in rows])
        return [_allergy(r, reactions.get(r["id"], [])) for r in rows]

    async def get(self, db: AsyncSession, patient_id: UUID, allergy_id: UUID) -> AllergyRow:
        rows = await self._rows(db, patient_id, allergy_id, include_entered_in_error=True,
                                limit=1, offset=0)
        if not rows:
            raise NotFound()
        r = rows[0]
        reactions = await self._reactions(db, [allergy_id])
        return AllergyRow(_allergy(r, reactions.get(allergy_id, [])), r["meta_version_id"],
                          r["created_by_user_id"])

    async def visit_of(self, db: AsyncSession, encounter_id: UUID) -> tuple[UUID, str] | None:
        return await encounters.visit_of(db, encounter_id)
