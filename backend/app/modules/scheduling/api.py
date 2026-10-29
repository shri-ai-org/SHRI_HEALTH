"""Scheduling and check-in API (batch 1, contracts/openapi/modules/scheduling.yaml). Routes are
added PR by PR, following contracts/docs/IMPL_BATCH1_PLAN.md; each route's operation_id is the
contract's operationId.

PR-3/PR-4 (demo step 2): the booking lists, free times, book, reschedule, cancel, the appointment
list and one appointment, and the status board. The permission (`require`) is the first
dependency. A `facilityId` the user isn't assigned to is 404 (core's facility filter): in the
query core checks it, in a body or a stored appointment the service does. Operations whose x-audit
takes the patient from the result or the body hand those patients to core's audit hook.
"""

from datetime import UTC, date, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import audit_patients
from app.core.deps import CurrentUser, require, tenant_db

from . import schemas, service
from .reference import PracticeSetupReads, reference

router = APIRouter(tags=["scheduling"])

APPOINTMENT = "/appointments/{appointmentId}"

DB = Annotated[AsyncSession, Depends(tenant_db)]
Ref = Annotated[PracticeSetupReads, Depends(reference)]
AppointmentId = Annotated[UUID, Path(alias="appointmentId")]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]
FacilityQuery = Annotated[UUID | None, Query(alias="facilityId")]
ProviderQuery = Annotated[UUID | None, Query(alias="providerId")]


def _now() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------- booking reference lists (D49)
@router.get("/booking/facilities", operation_id="listBookableFacilities",
            response_model=schemas.BookableFacilityList, response_model_exclude_none=True)
async def list_bookable_facilities(
    user: Annotated[CurrentUser, Depends(require("scheduling-reference:read"))],
    db: DB, ref: Ref, limit: Limit = 50, cursor: Cursor = None,
) -> schemas.BookableFacilityList:
    items, next_cursor = service.page(await service.bookable_facilities(db, ref, user), limit,
                                      service.decode_cursor(cursor))
    return schemas.BookableFacilityList(items=items, next_cursor=next_cursor)


@router.get("/booking/locations", operation_id="listBookableLocations",
            response_model=schemas.BookableLocationList, response_model_exclude_none=True)
async def list_bookable_locations(
    user: Annotated[CurrentUser, Depends(require("scheduling-reference:read"))],
    db: DB, ref: Ref, facility_id: FacilityQuery = None, limit: Limit = 50,
    cursor: Cursor = None,
) -> schemas.BookableLocationList:
    items, next_cursor = service.page(
        await service.bookable_locations(db, ref, user, facility_id), limit,
        service.decode_cursor(cursor))
    return schemas.BookableLocationList(items=items, next_cursor=next_cursor)


@router.get("/booking/providers", operation_id="listBookableProviders",
            response_model=schemas.BookableProviderList, response_model_exclude_none=True)
async def list_bookable_providers(
    user: Annotated[CurrentUser, Depends(require("scheduling-reference:read"))],
    db: DB, ref: Ref, facility_id: FacilityQuery = None, limit: Limit = 50,
    cursor: Cursor = None,
) -> schemas.BookableProviderList:
    items, next_cursor = service.page(
        await service.bookable_providers(db, ref, user, facility_id), limit,
        service.decode_cursor(cursor))
    return schemas.BookableProviderList(items=items, next_cursor=next_cursor)


@router.get("/booking/appointment-types", operation_id="listBookableAppointmentTypes",
            response_model=schemas.BookableAppointmentTypeList,
            response_model_exclude_none=True)
async def list_bookable_appointment_types(
    user: Annotated[CurrentUser, Depends(require("scheduling-reference:read"))],
    db: DB, ref: Ref, limit: Limit = 50, cursor: Cursor = None,
) -> schemas.BookableAppointmentTypeList:
    items, next_cursor = service.page(await service.bookable_types(db, ref), limit,
                                      service.decode_cursor(cursor))
    return schemas.BookableAppointmentTypeList(items=items, next_cursor=next_cursor)


# ----------------------------------------------------------------------------------- free times
@router.get("/slots", operation_id="listSlots", response_model=schemas.SlotList,
            response_model_exclude_none=True)
async def list_slots(
    user: Annotated[CurrentUser, Depends(require("slots:read"))],
    db: DB, ref: Ref, day: Annotated[date, Query(alias="date")],
    facility_id: Annotated[UUID, Query(alias="facilityId")],
    provider_id: ProviderQuery = None,
    appointment_type_id: Annotated[UUID | None, Query(alias="appointmentTypeId")] = None,
    limit: Limit = 50, cursor: Cursor = None,
) -> schemas.SlotList:
    fac, free = await service.free_times(db, ref, user, facility_id, day, provider_id,
                                         appointment_type_id, _now())
    items, next_cursor = service.page(free, limit, service.decode_cursor(cursor))
    return schemas.SlotList(items=items, next_cursor=next_cursor, time_zone=fac.time_zone)


# --------------------------------------------------------------------------------- appointments
@router.get("/appointments", operation_id="listAppointments",
            response_model=schemas.AppointmentList, response_model_exclude_none=True)
async def list_appointments(
    user: Annotated[CurrentUser, Depends(require("appointments:read"))],
    request: Request, db: DB, ref: Ref,
    day: Annotated[date | None, Query(alias="date")] = None,
    date_from: Annotated[date | None, Query(alias="dateFrom")] = None,
    date_to: Annotated[date | None, Query(alias="dateTo")] = None,
    facility_id: FacilityQuery = None, provider_id: ProviderQuery = None,
    patient_id: Annotated[UUID | None, Query(alias="patientId")] = None,
    statuses: Annotated[list[schemas.AppointmentStatus] | None,
                        Query(alias="status", max_length=6)] = None,
    limit: Limit = 50, cursor: Cursor = None,
) -> schemas.AppointmentList:
    days = service.date_range(day, date_from, date_to, patient_id)
    items, next_cursor, zone = await service.list_view(
        db, ref, user, days=days, facility_id=facility_id, provider_id=provider_id,
        patient_id=patient_id, statuses=statuses, limit=limit,
        offset=service.decode_cursor(cursor))
    audit_patients(request, [a.patient.id for a in items])  # x-audit patient "result"
    return schemas.AppointmentList(items=items, next_cursor=next_cursor, time_zone=zone)


@router.post("/appointments", operation_id="bookAppointment",
             status_code=status.HTTP_201_CREATED, response_model=schemas.Appointment,
             response_model_exclude_none=True)
async def book_appointment(
    user: Annotated[CurrentUser, Depends(require("appointments:create"))],
    body: schemas.AppointmentCreate, request: Request, response: Response, db: DB, ref: Ref,
) -> schemas.Appointment:
    appointment_id = await service.book(db, ref, user, body, _now())
    audit_patients(request, [body.patient_id])  # x-audit patient "body:/patientId"
    await db.commit()
    created, version = await service.one(db, user, appointment_id)
    response.headers["ETag"] = service.etag(version)
    response.headers["Location"] = f"/api/v1/appointments/{appointment_id}"
    return created


@router.get(APPOINTMENT, operation_id="getAppointment", response_model=schemas.Appointment,
            response_model_exclude_none=True)
async def get_appointment(
    user: Annotated[CurrentUser, Depends(require("appointments:read"))],
    appointment_id: AppointmentId, request: Request, response: Response, db: DB,
) -> schemas.Appointment:
    found, version = await service.one(db, user, appointment_id)
    audit_patients(request, [found.patient.id])  # x-audit patient "result"
    response.headers["ETag"] = service.etag(version)
    return found


@router.post(APPOINTMENT + "/reschedule", operation_id="rescheduleAppointment",
             status_code=status.HTTP_201_CREATED, response_model=schemas.Appointment,
             response_model_exclude_none=True)
async def reschedule_appointment(
    user: Annotated[CurrentUser, Depends(require("appointments:reschedule"))],
    appointment_id: AppointmentId, body: schemas.RescheduleRequest, request: Request,
    response: Response, db: DB, ref: Ref,
) -> schemas.Appointment:
    new_id = await service.reschedule(db, ref, user, appointment_id, body, _now())
    created, version = await service.one(db, user, new_id)
    audit_patients(request, [created.patient.id])  # x-audit patient "result"
    await db.commit()
    response.headers["ETag"] = service.etag(version)
    response.headers["Location"] = f"/api/v1/appointments/{new_id}"
    return created


@router.post(APPOINTMENT + "/cancel", operation_id="cancelAppointment",
             response_model=schemas.Appointment, response_model_exclude_none=True)
async def cancel_appointment(
    user: Annotated[CurrentUser, Depends(require("appointments:cancel"))],
    appointment_id: AppointmentId, body: schemas.CancelRequest, request: Request,
    response: Response, db: DB,
) -> schemas.Appointment:
    await service.cancel(db, user, appointment_id, body)
    cancelled, version = await service.one(db, user, appointment_id)
    audit_patients(request, [cancelled.patient.id])  # x-audit patient "result"
    await db.commit()
    response.headers["ETag"] = service.etag(version)
    return cancelled


# --------------------------------------------------------------------------------- status board
@router.get("/status-board", operation_id="getStatusBoard",
            response_model=schemas.StatusBoardList, response_model_exclude_none=True)
async def get_status_board(
    user: Annotated[CurrentUser, Depends(require("status-board:read"))],
    request: Request, db: DB, ref: Ref,
    facility_id: Annotated[UUID, Query(alias="facilityId")],
    day: Annotated[date | None, Query(alias="date")] = None,
    provider_id: ProviderQuery = None,
    view: Literal["shared", "staff"] = "shared",
    limit: Limit = 100, cursor: Cursor = None,
) -> schemas.StatusBoardList:
    found, named = await service.board(db, ref, user, facility_id, day, provider_id, view,
                                       limit, service.decode_cursor(cursor), _now())
    audit_patients(request, named)  # x-audit patient "result": the patients shown by name
    return found
