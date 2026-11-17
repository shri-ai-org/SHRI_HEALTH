"""Patient portal: the patient's own lab results (listPortalLabResults; portal.yaml, x-owner
anand; D83, D84, D86, D90, D93, Q32).

Portal routes never use a staff session: ``require_patient`` checks role PAT's permission on the
portal session, and ``portal_db`` reads as ``shri_portal`` with the session's patient set, so
another patient's results simply don't exist here. Core writes the ``phi-read`` audit row with
the patient from the session (x-audit ``patient: session``, ``actor: patient``).
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient, portal_db, require_patient

from ..history.service import decode_cursor, encode_cursor
from . import schemas
from .repository import LabResultReads, SqlLabResultReads

router = APIRouter(tags=["portal"])


def lab_results_reads() -> LabResultReads:
    return SqlLabResultReads()


DB = Annotated[AsyncSession, Depends(portal_db)]
Reads = Annotated[LabResultReads, Depends(lab_results_reads)]
Patient = Annotated[PortalPatient, Depends(require_patient("portal-records:read"))]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


@router.get("/portal/me/lab-results", operation_id="listPortalLabResults",
            response_model=schemas.LabResultList, response_model_exclude_none=True)
async def list_portal_lab_results(patient: Patient, db: DB, reads: Reads, limit: Limit = 25,
                                  cursor: Cursor = None) -> schemas.LabResultList:
    offset = decode_cursor(cursor)
    found = await reads.lab_results(db, patient.patient_id, limit=limit + 1, offset=offset)
    if len(found) > limit:
        return schemas.LabResultList(items=found[:limit], next_cursor=encode_cursor(offset + limit))
    return schemas.LabResultList(items=found)
