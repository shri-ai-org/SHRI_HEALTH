"""Response shapes for the patient portal's appointment reads
(contracts/openapi/modules/portal.yaml, ``PortalAppointment``, ``PortalAppointmentList``; B8a,
D89). Field names are the contract's camelCase (aliases)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from .schemas import Out

#: The appointment status as the patient sees it (``PortalAppointmentStatus``): ``arrived`` is
#: shown as ``checked-in``.
PortalAppointmentStatus = Literal["booked", "checked-in", "fulfilled", "cancelled", "noshow"]
When = Literal["upcoming", "past"]


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
    reason_for_visit: str | None = None
    patient_instruction: str | None = None
    can_cancel: bool
    can_reschedule: bool
    visit_summary_id: UUID | None = None


class PortalAppointmentList(Out):
    items: list[PortalAppointment]
    next_cursor: str | None = None
