"""The portal's reads of the session patient's lab reports, in core's ``portal_db`` session: role
``shri_portal`` with the session's patient set, so the own-chart policies show this patient's
reports only, final, amended, corrected or appended (Q32), never held ones (D90). The queries
also name the session's patient, so the rule holds twice. Lab reports are DiagnosticReport
category LAB (v2-0074) with their analytes through diagnostic_report_result, final, amended or
corrected, in the lab's order.

Held lab reports are not listed yet: ``admin.portal_held_records()`` doesn't say whether a held
report is a lab report or an imaging report, and shri_portal can't read a held report to tell
(a category column on that function comes after the demo).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from . import schemas

V2_0074 = "http://terminology.hl7.org/CodeSystem/v2-0074"

_REPORTS = text("""
SELECT r.id, r.status, r.code_system, r.code_code, r.code_display, r.code_text,
       r.effective_date_time, r.issued, r.conclusion
FROM clinical.diagnostic_report r
WHERE r.subject_patient_id = :patient AND r.status IN ('final', 'amended', 'corrected', 'appended')
  AND EXISTS (SELECT 1 FROM clinical.diagnostic_report_category c
               WHERE c.diagnostic_report_id = r.id AND c.category_system = :system
                 AND c.category_code = 'LAB')
ORDER BY r.effective_date_time DESC NULLS LAST, r.issued DESC NULLS LAST, r.id
LIMIT :limit OFFSET :offset
""")

_OBSERVATIONS = text("""
SELECT l.diagnostic_report_id, o.code_system, o.code_code, o.code_display, o.code_text,
       o.value_quantity_value, o.value_quantity_unit, o.value_string,
       rr.low_value, rr.high_value, rr.text AS range_text,
       (SELECT i.interpretation_code FROM clinical.observation_interpretation i
         WHERE i.observation_id = o.id ORDER BY i.id LIMIT 1) AS interpretation
FROM clinical.diagnostic_report_result l
JOIN clinical.observation o ON o.id = l.observation_id
LEFT JOIN LATERAL (SELECT * FROM clinical.observation_reference_range x
                    WHERE x.observation_id = o.id ORDER BY x.id LIMIT 1) rr ON true
WHERE l.diagnostic_report_id = ANY(:reports) AND o.subject_patient_id = :patient
  AND o.status IN ('final', 'amended', 'corrected')
ORDER BY l.diagnostic_report_id, l.sequence, o.id
""")

#: The portal shows a critically high or low result as high or low (portal.yaml).
INTERPRETATION = {"H": "H", "HH": "H", "L": "L", "LL": "L", "N": "N", "A": "A"}


def _code(row: Mapping[str, Any]) -> schemas.CodedValue:
    return schemas.CodedValue(system=row["code_system"], code=row["code_code"],
                              display=row["code_display"])


def _number(value: Any) -> float | None:
    return float(value) if value is not None else None


def _observation(row: Mapping[str, Any]) -> schemas.LabObservation:
    low, high = _number(row["low_value"]), _number(row["high_value"])
    rng = (schemas.ReferenceRange(low=low, high=high, text=row["range_text"])
           if low is not None or high is not None or row["range_text"] else None)
    value = (schemas.Quantity(value=float(row["value_quantity_value"]),
                              unit=row["value_quantity_unit"] or "1")
             if row["value_quantity_value"] is not None else None)
    return schemas.LabObservation(
        code=_code(row), short_name=row["code_text"], value=value, text=row["value_string"],
        reference_range=rng, interpretation=INTERPRETATION.get(row["interpretation"] or ""))


class LabResultReads(Protocol):
    async def lab_results(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                          offset: int) -> list[schemas.LabResult]: ...


class SqlLabResultReads:
    async def lab_results(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                          offset: int) -> list[schemas.LabResult]:
        reports = [dict(r) for r in (await db.execute(_REPORTS, {
            "patient": patient_id, "system": V2_0074, "limit": limit, "offset": offset})
                                     ).mappings()]
        results: dict[UUID, list[schemas.LabObservation]] = {}
        if reports:
            for row in (await db.execute(_OBSERVATIONS, {
                    "reports": [r["id"] for r in reports], "patient": patient_id})).mappings():
                results.setdefault(row["diagnostic_report_id"], []).append(
                    _observation(dict(row)))
        return [schemas.LabResult(
            id=r["id"], release_status="available", code=_code(r), short_name=r["code_text"],
            status=r["status"], effective_at=r["effective_date_time"], issued_at=r["issued"],
            results=results.get(r["id"], []), conclusion=r["conclusion"]) for r in reports]
