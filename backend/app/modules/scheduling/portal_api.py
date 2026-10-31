"""Patient portal: the patient's own appointments (B8a, D83, D84, D89; inventory #269, #271).
x-owner Vimal.

Portal routes never use a staff session: ``require_patient`` checks role PAT's permission on the
portal session (in development and test, the ``X-Dev-Patient`` stand-in, D108), and
``portal_db`` reads as ``shri_portal`` with the session's patient set (D93). Core writes the
``phi-read`` audit rows with the patient from the session (x-audit ``patient: session``,
``actor: patient``). Booking, cancel and reschedule from the portal are not built here.
"""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient, portal_db, require_patient

from . import portal_schemas as ps
from . import portal_service
from .portal_repository import PortalAppointmentReads, SqlPortalAppointmentReads

router = APIRouter(tags=["portal"])


def portal_appointments() -> PortalAppointmentReads:
    return SqlPortalAppointmentReads()


DB = Annotated[AsyncSession, Depends(portal_db)]
Reads = Annotated[PortalAppointmentReads, Depends(portal_appointments)]
Limit = Annotated[int, Query(ge=1, le=100)]
#: PortalAppointmentList holds at most 50 items, whatever the limit asks for.
MAX_PAGE = 50
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


def _now() -> datetime:
    return datetime.now(UTC)


@router.get("/portal/me/appointments", operation_id="listPortalAppointments",
            response_model=ps.PortalAppointmentList, response_model_exclude_none=True)
async def list_portal_appointments(
    patient: Annotated[PortalPatient, Depends(require_patient("portal-appointments:read"))],
    db: DB, reads: Reads, when: ps.When = "upcoming", limit: Limit = 25, cursor: Cursor = None,
) -> ps.PortalAppointmentList:
    return await portal_service.list_mine(db, reads, patient, when=when,
                                          limit=min(limit, MAX_PAGE), cursor=cursor, now=_now())


@router.get("/portal/me/appointments/{appointmentId}", operation_id="getPortalAppointment",
            response_model=ps.PortalAppointment, response_model_exclude_none=True)
async def get_portal_appointment(
    patient: Annotated[PortalPatient, Depends(require_patient("portal-appointments:read"))],
    appointment_id: Annotated[UUID, Path(alias="appointmentId")], db: DB, reads: Reads,
) -> ps.PortalAppointment:
    return await portal_service.one(db, reads, patient, appointment_id, _now())
