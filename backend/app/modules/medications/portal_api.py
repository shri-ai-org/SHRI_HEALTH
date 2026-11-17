"""Patient portal: the patient's own medication list (listPortalMedications) and refill requests
(listPortalRefillRequests, createPortalRefillRequest; #400); portal.yaml, x-owner thulasi; D83,
D84, D93.

Portal routes never use a staff session: ``require_patient`` checks role PAT's permission on the
portal session, and ``portal_db`` reads as ``shri_portal`` with the session's patient set, so
another patient's medications simply don't exist here. Core writes the audit row with the
patient from the session (x-audit ``patient: session``, ``actor: patient``), and claims a refill
request's Idempotency-Key for that patient before the route runs (x-idempotency: required).
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.deps import PortalPatient, portal_db, require_patient

from ..history.service import decode_cursor, encode_cursor
from . import portal_schemas as ps
from . import refill_service
from .portal_repository import PortalMedicationReads, SqlPortalMedicationReads
from .refill_repository import RefillReads, RefillStore, SqlRefillReads, SqlRefillStore

router = APIRouter(tags=["portal"])


def portal_medications() -> PortalMedicationReads:
    return SqlPortalMedicationReads()


def portal_refill_reads() -> RefillReads:
    return SqlRefillReads()


def portal_refill_store() -> RefillStore:
    return SqlRefillStore()


def refill_events() -> refill_service.Publish:
    """FastAPI dependency: core's event log (refill-request.received)."""
    return events.publish


DB = Annotated[AsyncSession, Depends(portal_db)]
Reads = Annotated[PortalMedicationReads, Depends(portal_medications)]
RefillReadsDep = Annotated[RefillReads, Depends(portal_refill_reads)]
RefillStoreDep = Annotated[RefillStore, Depends(portal_refill_store)]
Publish = Annotated[refill_service.Publish, Depends(refill_events)]
Patient = Annotated[PortalPatient, Depends(require_patient("portal-records:read"))]
Asking = Annotated[PortalPatient, Depends(require_patient("portal-refill-requests:create"))]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]
REFILLS = "/portal/me/refill-requests"


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


@router.get(REFILLS, operation_id="listPortalRefillRequests",
            response_model=ps.PortalRefillRequestList, response_model_exclude_none=True)
async def list_portal_refill_requests(patient: Patient, db: DB, reads: RefillReadsDep,
                                      limit: Limit = 25, cursor: Cursor = None
                                      ) -> ps.PortalRefillRequestList:
    return await refill_service.list_mine(db, reads, patient, limit=limit, cursor=cursor)


@router.post(REFILLS, operation_id="createPortalRefillRequest",
             status_code=status.HTTP_201_CREATED, response_model=ps.PortalRefillRequest,
             response_model_exclude_none=True)
async def create_portal_refill_request(patient: Asking, body: ps.PortalRefillRequestCreate,
                                       response: Response, db: DB, reads: RefillReadsDep,
                                       store: RefillStoreDep, publish: Publish
                                       ) -> ps.PortalRefillRequest:
    created = await refill_service.request_refill(db, reads, store, publish, patient, body)
    await db.commit()  # the request and refill-request.received: together or not at all
    # The contract has no URL for one request; Location names the list it was added to.
    response.headers["Location"] = f"/api/v1{REFILLS}"
    return created
