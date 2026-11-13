"""The orders module's reads of a patient's lab reports and imaging reports, over the FHIR-shaped
tables (clinical.diagnostic_report and its children, clinical.observation), through the
request's tenant_db session only, so forced row security shows the session's clinic only. Shown:
reports that are final, amended, corrected or appended, and analytes that are final, amended or
corrected; never registered, partial, preliminary, cancelled or entered-in-error (D24).

Lab results: DiagnosticReport category LAB (v2-0074) with its Observations through
diagnostic_report_result, in the lab's order. Imaging reports: DiagnosticReport category RAD, text
only: the impression is `conclusion`; the full text is the linked narrative Observations'
valueString (for example LOINC 18782-3 findings), in order, then the impression.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..encounters.schemas import CodeableConcept, Coding, Quantity
from . import schemas

V2_0074 = "http://terminology.hl7.org/CodeSystem/v2-0074"

_REPORTS = text("""
SELECT r.id, r.subject_patient_id, r.encounter_id, r.status, r.code_system, r.code_code,
       r.code_display, r.code_text, r.effective_date_time, r.issued, r.conclusion,
       (SELECT o.name FROM clinical.diagnostic_report_performer p
          JOIN clinical.organization o ON o.id = p.organization_id
         WHERE p.diagnostic_report_id = r.id ORDER BY p.id LIMIT 1) AS performer
FROM clinical.diagnostic_report r
WHERE r.subject_patient_id = :patient AND r.status IN ('final', 'amended', 'corrected', 'appended')
  AND EXISTS (SELECT 1 FROM clinical.diagnostic_report_category c
               WHERE c.diagnostic_report_id = r.id AND c.category_system = :system
                 AND c.category_code = :category)
ORDER BY r.effective_date_time DESC NULLS LAST, r.issued DESC NULLS LAST, r.id
LIMIT :limit OFFSET :offset
""")

_OBSERVATIONS = text("""
SELECT l.diagnostic_report_id, o.id, o.status, o.code_system, o.code_code, o.code_display,
       o.code_text, o.value_quantity_value, o.value_quantity_unit, o.value_string,
       rr.low_value, rr.low_unit, rr.high_value, rr.high_unit, rr.text AS range_text,
       (SELECT i.interpretation_code FROM clinical.observation_interpretation i
         WHERE i.observation_id = o.id ORDER BY i.id LIMIT 1) AS interpretation
FROM clinical.diagnostic_report_result l
JOIN clinical.observation o ON o.id = l.observation_id
LEFT JOIN LATERAL (SELECT * FROM clinical.observation_reference_range x
                    WHERE x.observation_id = o.id ORDER BY x.id LIMIT 1) rr ON true
WHERE l.diagnostic_report_id = ANY(:reports) AND o.status IN ('final', 'amended', 'corrected')
ORDER BY l.diagnostic_report_id, l.sequence, o.id
""")

INTERPRETATIONS = {"H", "L", "N", "A", "HH", "LL"}


def _code(row: Mapping[str, Any]) -> CodeableConcept:
    codings = ([Coding(system=row["code_system"], code=row["code_code"],
                       display=row["code_display"])] if row["code_code"] else [])
    return CodeableConcept(codings=codings, text=row["code_text"])


def _quantity(value: Any, unit: str | None) -> Quantity | None:
    return Quantity(value=float(value), unit=unit or "1") if value is not None else None


class ResultsRepository(Protocol):
    async def lab_results(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                          offset: int) -> list[schemas.LabResult]: ...

    async def imaging_reports(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                              offset: int) -> list[schemas.ImagingReport]: ...


class SqlResultsRepository:
    async def _reports(self, db: AsyncSession, patient_id: UUID, category: str, limit: int,
                       offset: int) -> tuple[Sequence[Mapping[str, Any]],
                                             dict[UUID, list[Mapping[str, Any]]]]:
        reports = [dict(row) for row in (await db.execute(_REPORTS, {
            "patient": patient_id, "system": V2_0074, "category": category,
            "limit": limit, "offset": offset})).mappings().all()]
        observations: dict[UUID, list[Mapping[str, Any]]] = {}
        if reports:
            rows = (await db.execute(_OBSERVATIONS, {
                "reports": [r["id"] for r in reports]})).mappings().all()
            for row in rows:
                observations.setdefault(row["diagnostic_report_id"], []).append(dict(row))
        return reports, observations

    async def lab_results(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                          offset: int) -> list[schemas.LabResult]:
        reports, observations = await self._reports(db, patient_id, "LAB", limit, offset)
        out = []
        for r in reports:
            items = []
            for o in observations.get(r["id"], []):
                low = _quantity(o["low_value"], o["low_unit"])
                high = _quantity(o["high_value"], o["high_unit"])
                rng = (schemas.ReferenceRange(low=low, high=high, text=o["range_text"])
                       if low or high or o["range_text"] else None)
                items.append(schemas.LabObservation(
                    id=o["id"], code=_code(o), status=o["status"],
                    value=_quantity(o["value_quantity_value"], o["value_quantity_unit"]),
                    value_text=o["value_string"], reference_range=rng,
                    interpretation=(o["interpretation"] if o["interpretation"] in INTERPRETATIONS
                                    else None)))
            out.append(schemas.LabResult(
                id=r["id"], patient_id=r["subject_patient_id"], encounter_id=r["encounter_id"],
                code=_code(r), status=r["status"], collected_at=r["effective_date_time"],
                issued_at=r["issued"], performer=r["performer"], conclusion=r["conclusion"],
                observations=items))
        return out

    async def imaging_reports(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                              offset: int) -> list[schemas.ImagingReport]:
        reports, observations = await self._reports(db, patient_id, "RAD", limit, offset)
        out = []
        for r in reports:
            parts = [o["value_string"] for o in observations.get(r["id"], []) if o["value_string"]]
            if r["conclusion"]:
                parts.append(f"Impression: {r['conclusion']}")
            out.append(schemas.ImagingReport(
                id=r["id"], patient_id=r["subject_patient_id"], encounter_id=r["encounter_id"],
                code=_code(r), status=r["status"], studied_at=r["effective_date_time"],
                issued_at=r["issued"], performer=r["performer"], impression=r["conclusion"],
                text="\n\n".join(parts) or None))
        return out
