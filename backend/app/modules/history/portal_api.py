"""Patient portal: the patient's own problems, allergies and vital signs (B8a, D83, D84, D89, D90;
listPortalProblems, getPortalProblem, listPortalAllergies, getPortalAllergy, listPortalVitals).
x-owner Vimal.

Portal routes never use a staff session: ``require_patient`` checks role PAT's permission on the
portal session, and ``portal_db`` reads as ``shri_portal`` with the session's patient set (D93), so
another patient's record simply doesn't exist here (404). Core writes the ``phi-read`` audit rows
with the patient from the session (x-audit ``patient: session``, ``actor: patient``).
"""
from __future__ import annotations

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient, portal_db, require_patient
from app.core.errors import NotFound

from . import portal_schemas as ps
from .portal_repository import PortalHistoryReads, SqlPortalHistoryReads
from .service import decode_cursor, encode_cursor

router = APIRouter(tags=["portal"])


def portal_history() -> PortalHistoryReads:
    return SqlPortalHistoryReads()


DB = Annotated[AsyncSession, Depends(portal_db)]
Reads = Annotated[PortalHistoryReads, Depends(portal_history)]
Patient = Annotated[PortalPatient, Depends(require_patient("portal-records:read"))]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


def _page[T](found: list[T], offset: int, limit: int) -> tuple[list[T], str | None]:
    if len(found) > limit:
        return found[:limit], encode_cursor(offset + limit)
    return found, None


@router.get("/portal/me/problems", operation_id="listPortalProblems",
            response_model=ps.PortalProblemList, response_model_exclude_none=True)
async def list_portal_problems(patient: Patient, db: DB, reads: Reads, limit: Limit = 25,
                               cursor: Cursor = None) -> ps.PortalProblemList:
    offset = decode_cursor(cursor)
    found = await reads.problems(db, patient.patient_id, problem_id=None, limit=limit + 1,
                                 offset=offset)
    items, next_cursor = _page(found, offset, limit)
    return ps.PortalProblemList(items=items, next_cursor=next_cursor)


@router.get("/portal/me/problems/{problemId}", operation_id="getPortalProblem",
            response_model=ps.PortalProblem, response_model_exclude_none=True)
async def get_portal_problem(patient: Patient, db: DB, reads: Reads,
                             problem_id: Annotated[UUID, Path(alias="problemId")]
                             ) -> ps.PortalProblem:
    found = await reads.problems(db, patient.patient_id, problem_id=problem_id, limit=1, offset=0)
    if not found:
        raise NotFound()
    return found[0]


@router.get("/portal/me/allergies", operation_id="listPortalAllergies",
            response_model=ps.PortalAllergyList, response_model_exclude_none=True)
async def list_portal_allergies(patient: Patient, db: DB, reads: Reads, limit: Limit = 25,
                                cursor: Cursor = None) -> ps.PortalAllergyList:
    offset = decode_cursor(cursor)
    found = await reads.allergies(db, patient.patient_id, allergy_id=None, limit=limit + 1,
                                  offset=offset)
    items, next_cursor = _page(found, offset, limit)
    return ps.PortalAllergyList(items=items, next_cursor=next_cursor)


@router.get("/portal/me/allergies/{allergyId}", operation_id="getPortalAllergy",
            response_model=ps.PortalAllergy, response_model_exclude_none=True)
async def get_portal_allergy(patient: Patient, db: DB, reads: Reads,
                             allergy_id: Annotated[UUID, Path(alias="allergyId")]
                             ) -> ps.PortalAllergy:
    found = await reads.allergies(db, patient.patient_id, allergy_id=allergy_id, limit=1,
                                  offset=0)
    if not found:
        raise NotFound()
    return found[0]


@router.get("/portal/me/vitals", operation_id="listPortalVitals",
            response_model=ps.PortalVitalList, response_model_exclude_none=True)
async def list_portal_vitals(
    patient: Patient, db: DB, reads: Reads, limit: Limit = 25, cursor: Cursor = None,
    vital_type: Annotated[ps.VitalType | None, Query(alias="type")] = None,
    date_from: Annotated[date | None, Query(alias="dateFrom")] = None,
    date_to: Annotated[date | None, Query(alias="dateTo")] = None,
) -> ps.PortalVitalList:
    offset = decode_cursor(cursor)
    found = await reads.vitals(db, patient.patient_id, vital_type=vital_type,
                               date_from=date_from, date_to=date_to, limit=limit + 1,
                               offset=offset)
    items, next_cursor = _page(found, offset, limit)
    return ps.PortalVitalList(items=items, next_cursor=next_cursor)
