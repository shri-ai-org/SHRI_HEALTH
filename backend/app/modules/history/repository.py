"""Allergy reads under the request's session (row-level security: another clinic's patient or
allergy is simply not found). Allergies are written through Anand's helpers
(``app.db.fhir_store``: ``create_allergy``, ``update_allergy``, ``allergy_entered_in_error``),
never here. Columns as ``backend/app/db/docs/contract_mapping.yaml`` maps them; ``onsetDate`` is
read back from ``onset_date_time`` (see the service on partial dates).

``SqlAllergyRepository`` is the seam the API uses; the tests replace it with an in-memory fake.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.db.fhir_store import partial_date_span

from ..encounters import service as encounters
from ..encounters.schemas import ClinicianRef, CodeableConcept, Coding, Quantity
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

    async def visit_of(self, db: AsyncSession, encounter_id: UUID,
                       facility_ids: Collection[UUID]) -> tuple[UUID, str] | None:
        """The encounter's patient and status (the encounters service), or None, also for a
        visit at a facility not in ``facility_ids``."""
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

    async def visit_of(self, db: AsyncSession, encounter_id: UUID,
                       facility_ids: Collection[UUID]) -> tuple[UUID, str] | None:
        return await encounters.visit_of(db, encounter_id, facility_ids)


# ------------------------------------------------------------------ problems and history (reads)
# Reads only: these records are written through Anand's helpers (``create_problem``,
# ``create_family_history``, ``record_social_history``, ``create_surgical_history`` and their
# entered-in-error actions). Columns as the helpers write them; partial dates are read back from
# the date-time or period columns the helpers fill (``fhir_store.partial_date_span``).
_PROBLEMS = text("""
SELECT c.id, c.subject_patient_id AS patient_id, c.clinical_status, c.verification_status,
       c.code_system, c.code_code, c.code_display, c.code_text, c.encounter_id,
       c.onset_date_time, c.onset_period_start, c.onset_period_end,
       c.abatement_date_time, c.abatement_period_start, c.abatement_period_end,
       c.entry_source, c.meta_version_id, coalesce(c.recorded_date, c.created_at) AS recorded_at,
       (SELECT a.text FROM clinical.annotation a WHERE a.condition_id = c.id
         ORDER BY a.created_at DESC, a.id LIMIT 1) AS note,
       ru.practitioner_id AS by_id, coalesce(rn.name, ru.display_name) AS by_name
FROM clinical.condition c LEFT JOIN admin.app_user ru ON ru.id = c.created_by_user_id
LEFT JOIN LATERAL (SELECT concat_ws(' ', array_to_string(n.prefix, ' '),
                                    array_to_string(n.given, ' '), n.family,
                                    array_to_string(n.suffix, ' ')) AS name
                     FROM clinical.human_name n WHERE n.practitioner_id = ru.practitioner_id
                    ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) rn ON true
WHERE c.subject_patient_id = :patient
  AND EXISTS (SELECT 1 FROM clinical.condition_category k
               WHERE k.condition_id = c.id AND k.category_code = 'problem-list-item')
  AND (CAST(:id AS uuid) IS NULL OR c.id = :id)
  AND (:include_eie OR c.verification_status IS DISTINCT FROM 'entered-in-error')
ORDER BY coalesce(c.recorded_date, c.created_at) DESC, c.id
LIMIT :limit OFFSET :offset
""")
_FAMILY = text("""
SELECT f.id, f.patient_id, f.status, f.relationship_system, f.relationship_code,
       f.relationship_display, f.relationship_text, f.sex_text, f.deceased_boolean,
       f.entry_source, coalesce(f.date, f.created_at) AS recorded_at,
       (SELECT a.text FROM clinical.annotation a WHERE a.family_member_history_id = f.id
         ORDER BY a.created_at DESC, a.id LIMIT 1) AS note,
       ru.practitioner_id AS by_id, coalesce(rn.name, ru.display_name) AS by_name
FROM clinical.family_member_history f LEFT JOIN admin.app_user ru ON ru.id = f.created_by_user_id
LEFT JOIN LATERAL (SELECT concat_ws(' ', array_to_string(n.prefix, ' '),
                                    array_to_string(n.given, ' '), n.family,
                                    array_to_string(n.suffix, ' ')) AS name
                     FROM clinical.human_name n WHERE n.practitioner_id = ru.practitioner_id
                    ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) rn ON true
WHERE f.patient_id = :patient
  AND (:include_eie OR f.status IS DISTINCT FROM 'entered-in-error')
ORDER BY coalesce(f.date, f.created_at) DESC, f.id
LIMIT :limit OFFSET :offset
""")
_FAMILY_CONDITIONS = text("""
SELECT k.family_member_history_id, k.code_system, k.code_code, k.code_display, k.code_text,
       k.onset_age_value, k.contributed_to_death
FROM clinical.family_member_history_condition k
WHERE k.family_member_history_id = ANY(:ids)
ORDER BY k.created_at, k.id
""")
_SOCIAL = text("""
SELECT o.id, o.subject_patient_id AS patient_id, o.status, o.code_system, o.code_code,
       o.code_display, o.code_text, o.effective_date_time, o.effective_period_start,
       o.effective_period_end, o.value_quantity_value, o.value_quantity_unit,
       o.value_codeable_concept_system, o.value_codeable_concept_code,
       o.value_codeable_concept_display, o.value_codeable_concept_text, o.value_string,
       o.entry_source, coalesce(o.issued, o.created_at) AS recorded_at,
       ru.practitioner_id AS by_id, coalesce(rn.name, ru.display_name) AS by_name
FROM clinical.observation o LEFT JOIN admin.app_user ru ON ru.id = o.created_by_user_id
LEFT JOIN LATERAL (SELECT concat_ws(' ', array_to_string(n.prefix, ' '),
                                    array_to_string(n.given, ' '), n.family,
                                    array_to_string(n.suffix, ' ')) AS name
                     FROM clinical.human_name n WHERE n.practitioner_id = ru.practitioner_id
                    ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) rn ON true
WHERE o.subject_patient_id = :patient
  AND EXISTS (SELECT 1 FROM clinical.observation_category k
               WHERE k.observation_id = o.id AND k.category_code = 'social-history')
  AND (:include_eie OR o.status IS DISTINCT FROM 'entered-in-error')
ORDER BY coalesce(o.issued, o.created_at) DESC, o.id
LIMIT :limit OFFSET :offset
""")
_SURGICAL = text("""
SELECT p.id, p.subject_patient_id AS patient_id, p.status, p.code_system, p.code_code,
       p.code_display, p.code_text, p.performed_date_time, p.performed_period_start,
       p.performed_period_end, p.entry_source, p.created_at AS recorded_at,
       (SELECT a.text FROM clinical.annotation a WHERE a.procedure_id = p.id
         ORDER BY a.created_at DESC, a.id LIMIT 1) AS note,
       (SELECT array[b.body_site_system, b.body_site_code, b.body_site_display,
                     b.body_site_text]
          FROM clinical.procedure_body_site b WHERE b.procedure_id = p.id
         ORDER BY b.created_at, b.id LIMIT 1) AS body_site,
       ru.practitioner_id AS by_id, coalesce(rn.name, ru.display_name) AS by_name
FROM clinical.procedure p LEFT JOIN admin.app_user ru ON ru.id = p.created_by_user_id
LEFT JOIN LATERAL (SELECT concat_ws(' ', array_to_string(n.prefix, ' '),
                                    array_to_string(n.given, ' '), n.family,
                                    array_to_string(n.suffix, ' ')) AS name
                     FROM clinical.human_name n WHERE n.practitioner_id = ru.practitioner_id
                    ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) rn ON true
WHERE p.subject_patient_id = :patient
  AND p.category_system = 'http://snomed.info/sct' AND p.category_code = '387713003'
  AND (:include_eie OR p.status IS DISTINCT FROM 'entered-in-error')
ORDER BY coalesce(p.performed_date_time, p.performed_period_start) DESC, p.created_at DESC,
         p.id
LIMIT :limit OFFSET :offset
""")


def partial_date(at: datetime | None, start: datetime | None, end: datetime | None
                 ) -> str | None:
    """The ``PartialDate`` a stored date stands for, the inverse of how the helpers store one: a
    full date as the date-time, a whole year (``YYYY``) or month (``YYYY-MM``) as a period."""
    if at is not None:
        return at.astimezone(UTC).date().isoformat()
    if start is None or end is None:
        return None
    first, last = start.astimezone(UTC).date(), end.astimezone(UTC).date()
    if partial_date_span(f"{first.year:04d}") == (first, last):
        return f"{first.year:04d}"
    if partial_date_span(f"{first:%Y-%m}") == (first, last):
        return f"{first:%Y-%m}"
    return first.isoformat()


@dataclass(frozen=True)
class ProblemRow:
    value: schemas.Problem
    version: int  # the ETag's source


class HistoryRepository(Protocol):
    async def problems(self, db: AsyncSession, patient_id: UUID, *, include_entered_in_error: bool,
                       limit: int, offset: int) -> list[schemas.Problem]: ...

    async def problem(self, db: AsyncSession, patient_id: UUID, problem_id: UUID
                      ) -> ProblemRow: ...

    async def family_history(self, db: AsyncSession, patient_id: UUID, *,
                             include_entered_in_error: bool, limit: int, offset: int
                             ) -> list[schemas.FamilyHistory]: ...

    async def social_history(self, db: AsyncSession, patient_id: UUID, *,
                             include_entered_in_error: bool, limit: int, offset: int
                             ) -> list[schemas.SocialHistory]: ...

    async def surgical_history(self, db: AsyncSession, patient_id: UUID, *,
                               include_entered_in_error: bool, limit: int, offset: int
                               ) -> list[schemas.SurgicalHistory]: ...


def _problem(r: Any) -> schemas.Problem:
    return schemas.Problem(
        id=r["id"], patient_id=r["patient_id"], clinical_status=r["clinical_status"],
        verification_status=r["verification_status"], encounter_id=r["encounter_id"],
        code=concept(r["code_system"], r["code_code"], r["code_display"], r["code_text"]),
        onset_date=partial_date(r["onset_date_time"], r["onset_period_start"],
                                r["onset_period_end"]),
        abatement_date=partial_date(r["abatement_date_time"], r["abatement_period_start"],
                                    r["abatement_period_end"]),
        note=r["note"], entry_source=r["entry_source"], recorded_at=r["recorded_at"],
        recorded_by=_who(r["by_id"], r["by_name"]))


def _social_value(r: Any) -> schemas.SocialHistoryValue:
    if r["value_quantity_value"] is not None:
        return schemas.SocialHistoryValue(quantity=Quantity(
            value=float(r["value_quantity_value"]), unit=r["value_quantity_unit"] or "1"))
    if r["value_codeable_concept_code"] or r["value_codeable_concept_text"]:
        return schemas.SocialHistoryValue(codeable_concept=concept(
            r["value_codeable_concept_system"], r["value_codeable_concept_code"],
            r["value_codeable_concept_display"], r["value_codeable_concept_text"]))
    return schemas.SocialHistoryValue(text=r["value_string"])


class SqlHistoryRepository:
    async def _rows(self, db: AsyncSession, query: Any, patient_id: UUID, *,
                    include_entered_in_error: bool, limit: int, offset: int,
                    **extra: Any) -> list[Any]:
        return list((await db.execute(query, {
            "patient": patient_id, "include_eie": include_entered_in_error, "limit": limit,
            "offset": offset, **extra})).mappings())

    async def problems(self, db: AsyncSession, patient_id: UUID, *, include_entered_in_error: bool,
                       limit: int, offset: int) -> list[schemas.Problem]:
        rows = await self._rows(db, _PROBLEMS, patient_id, id=None, limit=limit, offset=offset,
                                include_entered_in_error=include_entered_in_error)
        return [_problem(r) for r in rows]

    async def problem(self, db: AsyncSession, patient_id: UUID, problem_id: UUID
                      ) -> ProblemRow:
        rows = await self._rows(db, _PROBLEMS, patient_id, id=problem_id, limit=1, offset=0,
                                include_entered_in_error=True)
        if not rows:
            raise NotFound()
        return ProblemRow(_problem(rows[0]), rows[0]["meta_version_id"])

    async def family_history(self, db: AsyncSession, patient_id: UUID, *,
                             include_entered_in_error: bool, limit: int, offset: int
                             ) -> list[schemas.FamilyHistory]:
        rows = await self._rows(db, _FAMILY, patient_id, limit=limit, offset=offset,
                                include_entered_in_error=include_entered_in_error)
        conditions: dict[UUID, list[schemas.FamilyCondition]] = {}
        if rows:
            for k in (await db.execute(_FAMILY_CONDITIONS,
                                       {"ids": [r["id"] for r in rows]})).mappings():
                conditions.setdefault(k["family_member_history_id"], []).append(
                    schemas.FamilyCondition(
                        code=concept(k["code_system"], k["code_code"], k["code_display"],
                                     k["code_text"]),
                        onset_age=int(k["onset_age_value"])
                        if k["onset_age_value"] is not None else None,
                        contributed_to_death=k["contributed_to_death"]))
        return [schemas.FamilyHistory(
            id=r["id"], patient_id=r["patient_id"], status=r["status"],
            relationship=concept(r["relationship_system"], r["relationship_code"],
                                 r["relationship_display"], r["relationship_text"]),
            sex=r["sex_text"], deceased=r["deceased_boolean"],
            conditions=conditions.get(r["id"]) or None, note=r["note"],
            entry_source=r["entry_source"], recorded_at=r["recorded_at"],
            recorded_by=_who(r["by_id"], r["by_name"])) for r in rows]

    async def social_history(self, db: AsyncSession, patient_id: UUID, *,
                             include_entered_in_error: bool, limit: int, offset: int
                             ) -> list[schemas.SocialHistory]:
        rows = await self._rows(db, _SOCIAL, patient_id, limit=limit, offset=offset,
                                include_entered_in_error=include_entered_in_error)
        return [schemas.SocialHistory(
            id=r["id"], patient_id=r["patient_id"], status=r["status"],
            code=concept(r["code_system"], r["code_code"], r["code_display"], r["code_text"]),
            value=_social_value(r),
            effective_date=partial_date(r["effective_date_time"], r["effective_period_start"],
                                        r["effective_period_end"]),
            entry_source=r["entry_source"], recorded_at=r["recorded_at"],
            recorded_by=_who(r["by_id"], r["by_name"])) for r in rows]

    async def surgical_history(self, db: AsyncSession, patient_id: UUID, *,
                               include_entered_in_error: bool, limit: int, offset: int
                               ) -> list[schemas.SurgicalHistory]:
        rows = await self._rows(db, _SURGICAL, patient_id, limit=limit, offset=offset,
                                include_entered_in_error=include_entered_in_error)
        return [schemas.SurgicalHistory(
            id=r["id"], patient_id=r["patient_id"], status=r["status"],
            code=concept(r["code_system"], r["code_code"], r["code_display"], r["code_text"]),
            performed_date=partial_date(r["performed_date_time"], r["performed_period_start"],
                                        r["performed_period_end"]) or "",
            body_site=concept(*r["body_site"]) if r["body_site"] else None, note=r["note"],
            entry_source=r["entry_source"], recorded_at=r["recorded_at"],
            recorded_by=_who(r["by_id"], r["by_name"])) for r in rows]
