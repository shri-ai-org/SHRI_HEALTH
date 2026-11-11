"""Patient portal: the patient's own appointments (B8a, D83, D84, D89; inventory #269, #271).
x-owner Vimal.

Portal routes never use a staff session: ``require_patient`` checks role PAT's permission on the
portal session (in development and test, the ``X-Dev-Patient`` stand-in, D108), and
``portal_db`` reads as ``shri_portal`` with the session's patient set (D93). Core writes the
``phi-read`` audit rows with the patient from the session (x-audit ``patient: session``,
``actor: patient``). Booking, cancel and reschedule (the demo slice, D108) follow the rules in
``portal_service``; Idempotency-Key on book and reschedule is core's (x-idempotency: supported).
"""

from datetime import UTC, date, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient, portal_db, require_patient

from . import portal_schemas as ps
from . import portal_service
from .portal_repository import PortalAppointmentReads, SqlPortalAppointmentReads
from .reference import PracticeSetupReads, SqlPracticeSetupReads

router = APIRouter(tags=["portal"])


def portal_appointments() -> PortalAppointmentReads:
    return SqlPortalAppointmentReads()


DB = Annotated[AsyncSession, Depends(portal_db)]
Reads = Annotated[PortalAppointmentReads, Depends(portal_appointments)]


def practice_reads() -> PracticeSetupReads:
    return SqlPracticeSetupReads()


Ref = Annotated[PracticeSetupReads, Depends(practice_reads)]
AppointmentId = Annotated[UUID, Path(alias="appointmentId")]
FacilityId = Annotated[UUID, Query(alias="facilityId")]
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



# ------------------------------------------------------------------- booking (demo slice)
@router.get("/portal/booking/facilities", operation_id="listPortalBookingFacilities",
            response_model=ps.PortalBookingFacilityList, response_model_exclude_none=True)
async def list_portal_booking_facilities(
    patient: Annotated[PortalPatient, Depends(require_patient("portal-booking:read"))],
    db: DB, reads: Reads, ref: Ref,
) -> ps.PortalBookingFacilityList:
    return await portal_service.facilities(db, reads, ref)


@router.get("/portal/booking/appointment-types", operation_id="listPortalBookingAppointmentTypes",
            response_model=ps.PortalBookingAppointmentTypeList, response_model_exclude_none=True)
async def list_portal_booking_appointment_types(
    patient: Annotated[PortalPatient, Depends(require_patient("portal-booking:read"))],
    facility_id: FacilityId, db: DB, reads: Reads,
) -> ps.PortalBookingAppointmentTypeList:
    return await portal_service.types(db, reads, facility_id)


@router.get("/portal/booking/providers", operation_id="listPortalBookingProviders",
            response_model=ps.PortalBookingProviderList, response_model_exclude_none=True)
async def list_portal_booking_providers(
    patient: Annotated[PortalPatient, Depends(require_patient("portal-booking:read"))],
    facility_id: FacilityId, db: DB, reads: Reads, ref: Ref,
    appointment_type_id: Annotated[UUID | None, Query(alias="appointmentTypeId")] = None,
) -> ps.PortalBookingProviderList:
    return await portal_service.providers(db, reads, ref, facility_id)


@router.get("/portal/me/slots", operation_id="listPortalBookingSlots",
            response_model=ps.PortalSlotList, response_model_exclude_none=True)
async def list_portal_booking_slots(
    patient: Annotated[PortalPatient, Depends(require_patient("portal-booking:read"))],
    facility_id: FacilityId,
    appointment_type_id: Annotated[UUID, Query(alias="appointmentTypeId")],
    day: Annotated[date, Query(alias="date")], db: DB, reads: Reads, ref: Ref,
    provider_id: Annotated[UUID | None, Query(alias="providerId")] = None,
) -> ps.PortalSlotList:
    return await portal_service.free_times(
        db, reads, ref, facility_id=facility_id, appointment_type_id=appointment_type_id,
        day=day, provider_id=provider_id, now=_now())


@router.post("/portal/me/appointments", operation_id="bookPortalAppointment",
             status_code=status.HTTP_201_CREATED, response_model=ps.PortalAppointment,
             response_model_exclude_none=True)
async def book_portal_appointment(
    patient: Annotated[PortalPatient, Depends(require_patient("portal-appointments:create"))],
    body: ps.PortalAppointmentCreate, response: Response, db: DB, reads: Reads, ref: Ref,
) -> ps.PortalAppointment:
    booked = await portal_service.book(db, reads, ref, patient, body, _now())
    response.headers["Location"] = f"/api/v1/portal/me/appointments/{booked.id}"
    return booked


@router.post("/portal/me/appointments/{appointmentId}/cancel",
             operation_id="cancelPortalAppointment", response_model=ps.PortalAppointment,
             response_model_exclude_none=True)
async def cancel_portal_appointment(
    patient: Annotated[PortalPatient, Depends(require_patient("portal-appointments:cancel"))],
    appointment_id: AppointmentId, body: ps.PortalCancelRequest, db: DB, reads: Reads,
) -> ps.PortalAppointment:
    return await portal_service.cancel(db, reads, patient, appointment_id, body, _now())


@router.post("/portal/me/appointments/{appointmentId}/reschedule",
             operation_id="reschedulePortalAppointment", status_code=status.HTTP_201_CREATED,
             response_model=ps.PortalAppointment, response_model_exclude_none=True)
async def reschedule_portal_appointment(
    patient: Annotated[PortalPatient,
                       Depends(require_patient("portal-appointments:reschedule"))],
    appointment_id: AppointmentId, body: ps.PortalRescheduleRequest, response: Response,
    db: DB, reads: Reads, ref: Ref,
) -> ps.PortalAppointment:
    moved = await portal_service.reschedule(db, reads, ref, patient, appointment_id, body,
                                            _now())
    response.headers["Location"] = f"/api/v1/portal/me/appointments/{moved.id}"
    return moved
