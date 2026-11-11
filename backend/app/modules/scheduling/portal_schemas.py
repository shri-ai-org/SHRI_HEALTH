"""Response shapes for the patient portal's appointment reads
(contracts/openapi/modules/portal.yaml, ``PortalAppointment``, ``PortalAppointmentList``; B8a,
D89). Field names are the contract's camelCase (aliases)."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from .schemas import Closed, Out, _text

#: The appointment status as the patient sees it (``PortalAppointmentStatus``): ``arrived`` is
#: shown as ``checked-in``.
PortalAppointmentStatus = Literal["booked", "checked-in", "fulfilled", "cancelled", "noshow"]
When = Literal["upcoming", "past"]
#: Why a visit booked online is needed: the portal's fixed list (PortalAppointmentCreate).
ReasonCode = Literal["follow-up", "blood-pressure-check", "medication-review", "results-review",
                     "ongoing-condition", "other"]


class PortalAddress(Out):
    lines: list[str]
    city: str
    state: str
    postal_code: str
    country: Literal["US"] = "US"


class PortalFacilityRef(Out):
    id: UUID
    name: str
    address: PortalAddress | None = None


class PortalProviderRef(Out):
    id: UUID
    display_name: str


class PortalAppointmentTypeRef(Out):
    id: UUID
    name: str


class PortalAppointment(Out):
    id: UUID
    start_at: datetime
    end_at: datetime
    time_zone: str
    status: PortalAppointmentStatus
    facility: PortalFacilityRef
    provider: PortalProviderRef
    appointment_type: PortalAppointmentTypeRef
    telehealth: bool | None = None
    reason_code: ReasonCode | None = None
    reason_for_visit: str | None = None
    patient_instruction: str | None = None
    can_cancel: bool
    can_reschedule: bool
    visit_summary_id: UUID | None = None


class PortalAppointmentList(Out):
    items: list[PortalAppointment]
    next_cursor: str | None = None


# ------------------------------------------------------------------- booking (B8a, demo slice)
class PortalBookingFacility(Out):
    id: UUID
    name: str
    time_zone: str
    address: PortalAddress | None = None


class PortalBookingFacilityList(Out):
    items: list[PortalBookingFacility]
    next_cursor: str | None = None


class PortalBookingAppointmentType(Out):
    id: UUID
    name: str
    duration_minutes: int
    telehealth: bool


class PortalBookingAppointmentTypeList(Out):
    items: list[PortalBookingAppointmentType]
    next_cursor: str | None = None


class PortalBookingProvider(Out):
    id: UUID
    display_name: str
    specialty: str | None = None


class PortalBookingProviderList(Out):
    items: list[PortalBookingProvider]
    next_cursor: str | None = None


class PortalSlot(Out):
    start_at: datetime
    end_at: datetime
    provider_id: UUID


class PortalSlotList(Out):
    items: list[PortalSlot]
    next_cursor: str | None = None


class PortalAppointmentCreate(Closed):
    facility_id: UUID
    appointment_type_id: UUID
    provider_id: UUID
    start_at: datetime
    reason_code: ReasonCode | None = None  # required to book: a business rule (contract)
    reason_for_visit: Annotated[str, _text(1000)] | None = None


class PortalCancelRequest(Closed):
    reason_text: Annotated[str, _text(500, min_length=1)]


class PortalRescheduleRequest(Closed):
    start_at: datetime
    provider_id: UUID | None = None
    reason_text: Annotated[str, _text(500)] | None = None
