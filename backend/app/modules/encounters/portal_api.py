"""Patient portal: the patient's own visit summaries (B8a, D83, D84, D86, D89, D90; inventory
#278, #279). x-owner Vimal.

Portal routes never use a staff session: ``require_patient`` checks role PAT's permission on the
portal session (in development and test, the ``X-Dev-Patient`` stand-in, D108), and
``portal_db`` reads as ``shri_portal`` with the session's patient set (D93). Core writes the
``phi-read`` audit rows with the patient from the session.

**Not built:** ``getPortalVisitSummaryDownloadUrl`` (#280). The summary's PDF is Anand's
(#157, not merged), and a download link for a patient needs a portal content route and
download tokens bound to a patient session (D105 binds them to a staff user), which core and
the file service don't have yet.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient, portal_db, require_patient

from . import portal_schemas as ps
from . import portal_service
from .portal_repository import PortalSummaryReads, SqlPortalSummaryReads

router = APIRouter(tags=["portal"])


def portal_summaries() -> PortalSummaryReads:
    return SqlPortalSummaryReads()


DB = Annotated[AsyncSession, Depends(portal_db)]
Reads = Annotated[PortalSummaryReads, Depends(portal_summaries)]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


@router.get("/portal/me/visit-summaries", operation_id="listPortalVisitSummaries",
            response_model=ps.PortalVisitSummaryList, response_model_exclude_none=True)
async def list_portal_visit_summaries(
    patient: Annotated[PortalPatient, Depends(require_patient("portal-records:read"))],
    db: DB, reads: Reads, limit: Limit = 25, cursor: Cursor = None,
) -> ps.PortalVisitSummaryList:
    return await portal_service.list_mine(db, reads, patient, limit=limit, cursor=cursor)


@router.get("/portal/me/visit-summaries/{visitSummaryId}", operation_id="getPortalVisitSummary",
            response_model=ps.PortalVisitSummary, response_model_exclude_none=True)
async def get_portal_visit_summary(
    patient: Annotated[PortalPatient, Depends(require_patient("portal-records:read"))],
    summary_id: Annotated[UUID, Path(alias="visitSummaryId")], db: DB, reads: Reads,
) -> ps.PortalVisitSummary:
    return await portal_service.one(db, reads, patient, summary_id)
