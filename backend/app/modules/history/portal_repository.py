"""The patient portal's reads of the patient's own problems, allergies and vital signs (B8a, D84,
D90, D93; listPortalProblems, getPortalProblem, listPortalAllergies, getPortalAllergy,
listPortalVitals).

Everything runs in core's ``portal_db`` session: role ``shri_portal`` with the session's patient
set, so the own-chart policies (migration 0011) show this patient's rows only, never an
entered-in-error one, and never a problem a clinician holds (D90): a held problem doesn't exist
here, so the list leaves it out rather than showing it as held (``shri_portal`` can't read the
holds themselves; a follow-up for Anand, noted on the PR). Each query also names the session's
patient, so the rule holds twice. Only clinical tables are read: the portal has no grant on
``admin.app_user``, so nobody's name is shown, as the contract's shapes say.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import systems

from ..encounters.repository import DIASTOLIC, LOINC_VITAL, SYSTOLIC, VITAL_LOINC
from ..encounters.schemas import Quantity
from . import portal_schemas as ps
from .repository import partial_date

_PROBLEMS = text("""
SELECT c.id, c.clinical_status, c.code_display, c.code_text,
       c.onset_date_time, c.onset_period_start, c.onset_period_end,
       c.abatement_date_time, c.abatement_period_start, c.abatement_period_end,
       coalesce(c.recorded_date, c.created_at) AS recorded_at
FROM clinical.condition c
WHERE c.subject_patient_id = :patient
  AND c.verification_status IS DISTINCT FROM 'entered-in-error'
  AND EXISTS (SELECT 1 FROM clinical.condition_category k
               WHERE k.condition_id = c.id AND k.category_code = 'problem-list-item')
  AND (CAST(:id AS uuid) IS NULL OR c.id = :id)
ORDER BY coalesce(c.recorded_date, c.created_at) DESC, c.id
LIMIT :limit OFFSET :offset
""")

_ALLERGIES = text("""
SELECT a.id, a.clinical_status, a.code_display, a.code_text, a.criticality,
       coalesce(a.recorded_date, a.created_at) AS recorded_at
FROM clinical.allergy_intolerance a
WHERE a.patient_id = :patient
  AND a.verification_status IS DISTINCT FROM 'entered-in-error'
  AND (CAST(:id AS uuid) IS NULL OR a.id = :id)
ORDER BY coalesce(a.recorded_date, a.created_at) DESC, a.id
LIMIT :limit OFFSET :offset
""")

_REACTIONS = text("""
SELECT r.allergy_intolerance_id, r.id, r.severity,
       coalesce(m.manifestation_display, m.manifestation_text) AS manifestation
FROM clinical.allergy_intolerance_reaction r
LEFT JOIN clinical.allergy_reaction_manifestation m ON m.reaction_id = r.id
WHERE r.allergy_intolerance_id = ANY(:ids)
ORDER BY r.created_at, r.id, m.created_at, m.id
""")

_VITALS = text("""
SELECT o.id, o.code_code, o.effective_date_time, o.value_quantity_value, o.value_quantity_unit,
       s.value_quantity_value AS sys_value, s.value_quantity_unit AS sys_unit,
       d.value_quantity_value AS dia_value, d.value_quantity_unit AS dia_unit
FROM clinical.observation o
LEFT JOIN clinical.observation_component s
       ON s.observation_id = o.id AND s.code_code = :systolic
LEFT JOIN clinical.observation_component d
       ON d.observation_id = o.id AND d.code_code = :diastolic
WHERE o.subject_patient_id = :patient
  AND o.code_system = :loinc AND o.code_code = ANY(:codes)
  AND o.status <> 'entered-in-error' AND o.effective_date_time IS NOT NULL
  AND EXISTS (SELECT 1 FROM clinical.observation_category k
               WHERE k.observation_id = o.id AND k.category_code = 'vital-signs')
  AND (CAST(:day_from AS date) IS NULL OR o.effective_date_time >= CAST(:day_from AS date))
  AND (CAST(:day_to AS date) IS NULL OR o.effective_date_time < CAST(:day_to AS date) + 1)
ORDER BY o.effective_date_time DESC, o.id
LIMIT :limit OFFSET :offset
""")

PROBLEM_STATUSES = {"active", "recurrence", "relapse", "inactive", "remission", "resolved"}
ALLERGY_STATUSES = {"active", "inactive", "resolved"}
CRITICALITIES = {"low", "high", "unable-to-assess"}
SEVERITIES = {"mild", "moderate", "severe"}


def _display(r: Mapping[str, Any]) -> str | None:
    shown: str | None = r["code_display"] or r["code_text"]
    return shown


def _qty(value: Any, unit: str | None) -> Quantity | None:
    return Quantity(value=float(value), unit=unit or "1") if value is not None else None


class PortalHistoryReads(Protocol):
    async def problems(self, db: AsyncSession, patient_id: UUID, *, problem_id: UUID | None,
                       limit: int, offset: int) -> list[ps.PortalProblem]: ...

    async def allergies(self, db: AsyncSession, patient_id: UUID, *, allergy_id: UUID | None,
                        limit: int, offset: int) -> list[ps.PortalAllergy]: ...

    async def vitals(self, db: AsyncSession, patient_id: UUID, *, vital_type: str | None,
                     date_from: date | None, date_to: date | None, limit: int,
                     offset: int) -> list[ps.PortalVital]: ...


class SqlPortalHistoryReads:
    async def problems(self, db: AsyncSession, patient_id: UUID, *, problem_id: UUID | None,
                       limit: int, offset: int) -> list[ps.PortalProblem]:
        rows = [dict(x) for x in (await db.execute(_PROBLEMS, {
            "patient": patient_id, "id": problem_id, "limit": limit, "offset": offset})
            ).mappings()]
        return [ps.PortalProblem(
            id=r["id"], release_status="available", display=_display(r),
            clinical_status=(r["clinical_status"] if r["clinical_status"] in PROBLEM_STATUSES
                             else None),
            onset_date=partial_date(r["onset_date_time"], r["onset_period_start"],
                                    r["onset_period_end"]),
            abatement_date=partial_date(r["abatement_date_time"], r["abatement_period_start"],
                                        r["abatement_period_end"]),
            recorded_at=r["recorded_at"]) for r in rows]

    async def allergies(self, db: AsyncSession, patient_id: UUID, *, allergy_id: UUID | None,
                        limit: int, offset: int) -> list[ps.PortalAllergy]:
        rows: Sequence[Mapping[str, Any]] = [dict(x) for x in (await db.execute(_ALLERGIES, {
            "patient": patient_id, "id": allergy_id, "limit": limit, "offset": offset})
            ).mappings()]
        reactions: dict[UUID, dict[UUID, tuple[str | None, list[str]]]] = {}
        if rows:
            for x in (await db.execute(_REACTIONS, {"ids": [r["id"] for r in rows]})).mappings():
                severity, said = reactions.setdefault(x["allergy_intolerance_id"], {}).setdefault(
                    x["id"], (x["severity"], []))
                if x["manifestation"]:
                    said.append(x["manifestation"])
        out = []
        for r in rows:
            mine = [ps.PortalReaction(manifestations=said[:10],
                                      severity=sev if sev in SEVERITIES else None)
                    for sev, said in reactions.get(r["id"], {}).values() if said][:10]
            out.append(ps.PortalAllergy(
                id=r["id"], display=_display(r) or "Allergy",
                clinical_status=(r["clinical_status"] if r["clinical_status"] in ALLERGY_STATUSES
                                 else "active"),
                criticality=r["criticality"] if r["criticality"] in CRITICALITIES else None,
                reactions=mine, recorded_at=r["recorded_at"]))
        return out

    async def vitals(self, db: AsyncSession, patient_id: UUID, *, vital_type: str | None,
                     date_from: date | None, date_to: date | None, limit: int,
                     offset: int) -> list[ps.PortalVital]:
        codes = [VITAL_LOINC[vital_type]] if vital_type else list(VITAL_LOINC.values())
        rows = (await db.execute(_VITALS, {
            "patient": patient_id, "loinc": systems.LOINC, "codes": codes,
            "systolic": SYSTOLIC, "diastolic": DIASTOLIC, "day_from": date_from,
            "day_to": date_to, "limit": limit, "offset": offset})).mappings()
        out = []
        for r in rows:
            kind = LOINC_VITAL[r["code_code"]]
            bp = kind == "blood-pressure"
            out.append(ps.PortalVital(
                id=r["id"], type=kind,
                effective_at=r["effective_date_time"],
                value=None if bp else _qty(r["value_quantity_value"], r["value_quantity_unit"]),
                systolic=_qty(r["sys_value"], r["sys_unit"]) if bp else None,
                diastolic=_qty(r["dia_value"], r["dia_unit"]) if bp else None))
        return out
