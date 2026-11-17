"""Patient portal: the patient's own medication list (listPortalMedications; portal.yaml,
x-owner thulasi; D83, D84, D93).

Portal routes never use a staff session: ``require_patient`` checks role PAT's permission on the
portal session, and ``portal_db`` reads as ``shri_portal`` with the session's patient set, so
another patient's medications simply don't exist here. Core writes the ``phi-read`` audit row
with the patient from the session (x-audit ``patient: session``, ``actor: patient``).
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient, portal_db, require_patient

from ..history.service import decode_cursor, encode_cursor
from . import portal_schemas as ps
from .portal_repository import PortalMedicationReads, SqlPortalMedicationReads

router = APIRouter(tags=["portal"])


def portal_medications() -> PortalMedicationReads:
    return SqlPortalMedicationReads()


DB = Annotated[AsyncSession, Depends(portal_db)]
Reads = Annotated[PortalMedicationReads, Depends(portal_medications)]
Patient = Annotated[PortalPatient, Depends(require_patient("portal-records:read"))]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


@router.get("/portal/me/medications", operation_id="listPortalMedications",
            response_model=ps.PortalMedicationList, response_model_exclude_none=True)
async def list_portal_medications(patient: Patient, db: DB, reads: Reads, limit: Limit = 25,
                                  cursor: Cursor = None) -> ps.PortalMedicationList:
    offset = decode_cursor(cursor)
    found = await reads.medications(db, patient.patient_id, limit=limit + 1, offset=offset)
    if len(found) > limit:
        return ps.PortalMedicationList(items=found[:limit],
                                       next_cursor=encode_cursor(offset + limit))
    return ps.PortalMedicationList(items=found)
