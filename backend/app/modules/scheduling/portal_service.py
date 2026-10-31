"""Rules for the patient portal's appointment reads (B8a, D84, D89; inventory #269, #271).

- **Own record only (D84):** the patient is the portal session's, never the request's. An
  appointment ID that isn't the session patient's is 404, exactly as one that doesn't exist
  (``deps.require_own_record``), on top of the shri_portal policies (D93).
- **Upcoming** (the default, soonest first): not yet over, i.e. it ends after now and isn't
  fulfilled or a no-show; a cancelled upcoming visit stays listed so the patient sees it was
  cancelled. **Past** (newest first) is everything else.
- **Status:** ``arrived`` is shown as ``checked-in`` (``PortalAppointmentStatus``).
- **canCancel / canReschedule:** a booked visit, while its start is at least the practice's
  cut-off away (``admin.online_booking_setting``); false when the practice has no online
  booking rules.
- **Times** are UTC with the facility's time zone (D40).
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any, Protocol
from uuid import UUID

from app.core.deps import PortalPatient, require_own_record

from . import portal_schemas as ps
from .portal_repository import OnlinePolicy, PortalAddressRow, PortalAppointmentRow
from .portal_repository import PortalAppointmentReads as Reads
from .service import decode_cursor, encode_cursor

log = logging.getLogger(__name__)
_STATE = re.compile(r"^[A-Z]{2}$")
_ZIP = re.compile(r"^\d{5}(-\d{4})?$")


class _Owned(Protocol):
    @property
    def patient_id(self) -> UUID: ...


def own_rows[R: _Owned](patient: PortalPatient, rows: list[R]) -> list[R]:
    """The session patient's rows only. shri_portal's policies and the query's own patient
    filter already guarantee it; this third check keeps a bug in either from showing another
    patient's record (D84, D93). A dropped row is logged, without any ID."""
    mine = [r for r in rows if r.patient_id == patient.patient_id]
    if len(mine) != len(rows):
        log.error("A portal read returned rows of another patient; they were dropped")
    return mine


def _status(status: str) -> ps.PortalAppointmentStatus:
    return "checked-in" if status == "arrived" else status  # type: ignore[return-value]


def _address(row: PortalAddressRow | None) -> ps.PortalAddress | None:
    """The facility's address, when it is a whole U.S. address (``Address``); else none (the
    contract's facility address is optional)."""
    if (row is None or not row.lines or not row.city or not row.postal_code
            or not row.state or not _STATE.match(row.state)
            or not _ZIP.match(row.postal_code)
            or (row.country or "US") != "US"):
        return None
    return ps.PortalAddress(lines=list(row.lines[:3]), city=row.city, state=row.state,
                            postal_code=row.postal_code)


def _allowed(row: PortalAppointmentRow, cutoff_hours: int | None, now: datetime) -> bool:
    return (cutoff_hours is not None and row.status == "booked"
            and row.start - now >= timedelta(hours=cutoff_hours))


def to_contract(row: PortalAppointmentRow, policy: OnlinePolicy | None, now: datetime
                ) -> ps.PortalAppointment:
    return ps.PortalAppointment(
        id=row.id, start_at=row.start, end_at=row.end, time_zone=row.time_zone,
        status=_status(row.status),
        facility=ps.PortalFacilityRef(id=row.facility_id, name=row.facility_name,
                                      address=_address(row.facility_address)),
        provider=ps.PortalProviderRef(id=row.provider_id, display_name=row.provider_name),
        appointment_type=ps.PortalAppointmentTypeRef(id=row.type_id, name=row.type_name),
        telehealth=row.telehealth, reason_for_visit=row.reason,
        patient_instruction=row.patient_instruction,
        can_cancel=_allowed(row, policy.cancel_cutoff_hours if policy else None, now),
        can_reschedule=_allowed(row, policy.reschedule_cutoff_hours if policy else None, now),
        visit_summary_id=row.visit_summary_id)


async def list_mine(db: Any, reads: Reads, patient: PortalPatient, *, when: ps.When,
                    limit: int, cursor: str | None, now: datetime) -> ps.PortalAppointmentList:
    offset = decode_cursor(cursor)
    rows = await reads.list(db, patient.patient_id, upcoming=when == "upcoming", now=now,
                            limit=limit + 1, offset=offset)
    rows = own_rows(patient, rows)
    policy = await reads.policy(db) if rows else None
    return ps.PortalAppointmentList(
        items=[to_contract(r, policy, now) for r in rows[:limit]],
        next_cursor=encode_cursor(offset + limit) if len(rows) > limit else None)


async def one(db: Any, reads: Reads, patient: PortalPatient, appointment_id: UUID,
              now: datetime) -> ps.PortalAppointment:
    row = await reads.get(db, patient.patient_id, appointment_id)
    if row is None:
        require_own_record(patient, None)  # 404, as for another patient's record (D84)
        raise AssertionError("unreachable")
    require_own_record(patient, row.patient_id)
    return to_contract(row, await reads.policy(db), now)
