"""Request and response shapes for the scheduling API (contracts/openapi/modules/scheduling.yaml).

Field names are the contract's camelCase (aliases); request bodies the contract closes
(`additionalProperties: false`) forbid unknown fields. Only the operations built so far are here.
"""

from __future__ import annotations

import datetime as dt
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel


def _text(max_length: int, *, min_length: int = 0) -> object:
    return StringConstraints(min_length=min_length, max_length=max_length)


AppointmentStatus = Literal["booked", "arrived", "checked-in", "fulfilled", "cancelled", "noshow"]
VisitStatus = Literal["arrived", "checked-in", "roomed", "with-provider", "checked-out"]
PhysicalType = Literal["bu", "wi", "lvl", "ro"]
Minutes = Annotated[int, Field(ge=5, le=480)]


class Closed(BaseModel):
    """A request body the contract closes: unknown fields are refused."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Out(BaseModel):
    """A response body."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ------------------------------------------------------------------ booking reference lists (D49)
class BookableFacility(Out):
    id: UUID
    code: str
    name: str
    time_zone: str


class BookableFacilityList(Out):
    items: list[BookableFacility]
    next_cursor: str | None = None


class BookableLocation(Out):
    id: UUID
    facility_id: UUID
    name: str
    physical_type: PhysicalType | None = None


class BookableLocationList(Out):
    items: list[BookableLocation]
    next_cursor: str | None = None


class BookableProvider(Out):
    id: UUID
    display_name: str
    facility_ids: list[UUID]
    specialties: list[str] | None = None


class BookableProviderList(Out):
    items: list[BookableProvider]
    next_cursor: str | None = None


class BookableAppointmentType(Out):
    id: UUID
    code: str
    name: str
    default_duration_minutes: int
    color: str | None = None
    allow_overlap: bool
    max_overbook: int
    requires_eligibility_check: bool
    telehealth: bool
    new_patient: bool


class BookableAppointmentTypeList(Out):
    items: list[BookableAppointmentType]
    next_cursor: str | None = None


# ----------------------------------------------------------------------------------- free times
class Slot(Out):
    start_at: datetime
    end_at: datetime
    provider_id: UUID
    facility_id: UUID
    location_id: UUID | None = None
    overbook: bool


class SlotList(Out):
    items: list[Slot]
    next_cursor: str | None = None
    time_zone: str | None = None


# --------------------------------------------------------------------------------- appointments
class SchedulingPatientRef(Out):
    id: UUID
    display_name: str
    restricted: bool | None = None


class SchedulingProviderRef(Out):
    id: UUID
    display_name: str


class AppointmentTypeRef(Out):
    id: UUID
    code: str | None = None
    name: str


class Cancellation(Out):
    reason_code: str
    reason_text: str | None = None
    cancelled_at: datetime


class FollowUpInterval(Out):
    """encounters.yaml's FollowUpInterval, as the front desk reads it."""
    value: int
    unit: Literal["day", "week", "month"]


class FollowUpSummary(Out):
    """The visit's follow-up request as the front desk needs it at check-out (D98)."""
    encounter_id: UUID
    interval: FollowUpInterval
    appointment_type_id: UUID | None = None
    provider_id: UUID | None = None
    note: str | None = None
    status: Literal["open", "booked", "declined", "withdrawn"]
    booked_appointment_id: UUID | None = None


class Appointment(Out):
    id: UUID
    patient: SchedulingPatientRef
    provider: SchedulingProviderRef
    facility_id: UUID
    location_id: UUID | None = None
    appointment_type: AppointmentTypeRef
    status: AppointmentStatus
    visit_status: VisitStatus | None = None
    start_at: datetime
    end_at: datetime
    duration_minutes: int
    time_zone: str
    reason_for_visit: str | None = None
    same_day_add_on: bool | None = None
    overbook: bool | None = None
    comment: str | None = None
    patient_instruction: str | None = None
    cancellation: Cancellation | None = None
    rescheduled_from_id: UUID | None = None
    encounter_id: UUID | None = None
    created_at: datetime
    updated_at: datetime
    follow_up: FollowUpSummary | None = None


class AppointmentSummary(Out):
    id: UUID
    patient: SchedulingPatientRef
    provider: SchedulingProviderRef
    facility_id: UUID
    appointment_type: AppointmentTypeRef
    status: AppointmentStatus
    visit_status: VisitStatus | None = None
    start_at: datetime
    end_at: datetime
    reason_for_visit: str | None = None
    same_day_add_on: bool | None = None
    overbook: bool | None = None


class AppointmentList(Out):
    items: list[AppointmentSummary]
    next_cursor: str | None = None
    time_zone: str | None = None


class AppointmentCreate(Closed):
    patient_id: UUID
    provider_id: UUID
    facility_id: UUID
    location_id: UUID | None = None
    appointment_type_id: UUID
    start_at: AwareDatetime
    duration_minutes: Minutes | None = None
    reason_for_visit: Annotated[str, _text(1000)] | None = None
    same_day_add_on: bool = False
    overbook: bool = False
    comment: Annotated[str, _text(2000)] | None = None
    patient_instruction: Annotated[str, _text(2000)] | None = None
    follow_up_of_encounter_id: UUID | None = None


class CancelRequest(Closed):
    reason_code: Annotated[str, _text(64, min_length=1)]
    reason_text: Annotated[str, _text(500)] | None = None


class RescheduleRequest(Closed):
    start_at: AwareDatetime
    provider_id: UUID | None = None
    facility_id: UUID | None = None
    location_id: UUID | None = None
    appointment_type_id: UUID | None = None
    duration_minutes: Minutes | None = None
    reason_code: Annotated[str, _text(64, min_length=1)]
    reason_text: Annotated[str, _text(500)] | None = None


# --------------------------------------------------------------------------------- status board
class StatusBoardItem(Out):
    appointment_id: UUID
    patient: SchedulingPatientRef | None = None
    initials: str
    provider: SchedulingProviderRef | None = None
    start_at: datetime
    status: AppointmentStatus
    visit_status: VisitStatus | None = None
    visit_status_at: datetime | None = None
    room_name: str | None = None
    appointment_type: AppointmentTypeRef | None = None
    reason_for_visit: str | None = None
    encounter_id: UUID | None = None
    follow_up: FollowUpSummary | None = None


class StatusBoardList(Out):
    items: list[StatusBoardItem]
    next_cursor: str | None = None
    date: dt.date | None = None
    time_zone: str | None = None
    facility_name: str | None = None


# ----------------------------------------------------------------------- check-in and its undo
class CheckInRequest(Closed):
    self_pay: bool = False


class CheckInResult(Out):
    appointment: Appointment
    encounter_id: UUID
    eligibility_check_id: UUID | None = None


class UndoCheckInRequest(Closed):
    reason: Annotated[str, _text(500, min_length=1)]


# --------------------------------------------------------------------------------- visit steps
class StatusChangeRequest(Closed):
    status: Literal["arrived", "roomed", "with-provider", "checked-out", "noshow"]
    room_location_id: UUID | None = None
