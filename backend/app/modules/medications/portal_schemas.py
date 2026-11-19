"""The patient portal's view of the patient's own medications (listPortalMedications; portal.yaml,
x-owner thulasi) and of their refill requests (listPortalRefillRequests,
createPortalRefillRequest; #400). Field names are the contract's camelCase."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StringConstraints

from .schemas import Closed, Out


class PortalMedication(Out):
    id: UUID
    display: str = Field(max_length=500)
    dosage_text: str | None = Field(default=None, max_length=500)
    status: Literal["active", "completed", "stopped"]
    source: Literal["prescription", "reported"]
    prescribed_at: datetime | None = None
    prescriber_display_name: str | None = Field(default=None, max_length=200)
    pharmacy_name: str | None = Field(default=None, max_length=200)
    transmission_status: Literal["queued", "sent", "accepted", "rejected", "error"] | None = None


class PortalMedicationList(Out):
    items: list[PortalMedication] = Field(max_length=100)
    next_cursor: str | None = None


class PortalRefillRequest(Out):
    """A refill request, as the patient sees it."""
    id: UUID
    prescription_id: UUID
    display: str = Field(max_length=500)
    dosage_text: str | None = Field(default=None, max_length=500)
    status: Literal["requested", "approved", "declined"]
    requested_at: datetime
    responded_at: datetime | None = None
    decline_reason: str | None = Field(default=None, max_length=500)
    new_prescription_id: UUID | None = None


class PortalRefillRequestList(Out):
    items: list[PortalRefillRequest] = Field(max_length=100)
    next_cursor: str | None = None


class PortalRefillRequestCreate(Closed):
    prescription_id: UUID
    note: Annotated[str, StringConstraints(max_length=500)] | None = None
