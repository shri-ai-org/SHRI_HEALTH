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

Booking (the demo slice; the rules in portal.yaml's ``bookPortalAppointment``):
- only visit types the practice lets patients book online at that facility
  (``admin.online_bookable_type``), and only while online booking is on;
- at least the practice's minimum notice ahead, within its booking window;
- at most ``MAX_UPCOMING`` booked appointments still ahead per patient;
- a ``reasonCode`` from the fixed list (business-rule ``required`` when missing);
- booked at once, under the staff booking rules (``service.validated_at``: the provider's hours,
  the day lock, the exclusion constraint against double booking);
- cancel and reschedule only while the start is at least the practice's cut-off away.
The live board event runs in a savepoint and never refuses a booking: if it fails, the booking
stands and the failure is logged, without patient data. Eligibility (D15) is not queued from the
portal: its pre-visit batch and check-in run it, so a failed check warns the desk and never
blocks the patient. An appointment booked from a follow-up request (D98) is moved or cancelled by
the clinic, never online, so the portal never changes a follow-up request.
"""

from __future__ import annotations

import logging
import re
from dataclasses import replace
from datetime import date, datetime, timedelta
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient, require_own_record
from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed, field_error

from . import events, repository
from . import portal_schemas as ps
from . import service as staff
from .portal_repository import OnlinePolicy, PortalAddressRow, PortalAppointmentRow
from .portal_repository import PortalAppointmentReads as Reads
from .reference import FacilityRow, PracticeSetupReads
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
        telehealth=row.telehealth, reason_code=_reason_code(row.reason_code),
        reason_for_visit=row.reason,
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


# ------------------------------------------------------------------- booking (demo slice)
MAX_UPCOMING = 2
#: Labels the front desk sees for the portal's reason codes (never sent in a message, D81).
REASON_LABELS: dict[str, str] = {
    "follow-up": "Follow-up visit", "blood-pressure-check": "Blood pressure check",
    "medication-review": "Medication review", "results-review": "Review of test results",
    "ongoing-condition": "Ongoing condition", "other": "Other"}
PATIENT_CANCEL = "patient-portal"  # the cancellation's reason code (the practice's local system)


def _reason_code(code: str | None) -> ps.ReasonCode | None:
    return code if code in REASON_LABELS else None  # type: ignore[return-value]


def _rule(where: str, code: str) -> ValidationFailed:
    return ValidationFailed(code="business-rule-violation",
                            errors=[field_error("body", where, code)])


async def _open_policy(db: Any, reads: Reads) -> OnlinePolicy | None:
    policy = await reads.policy(db)
    return policy if policy is not None and policy.enabled else None


async def _bookable(db: Any, reads: Reads, ref: PracticeSetupReads, facility_id: UUID
                    ) -> tuple[FacilityRow, dict[UUID, Any]] | None:
    """The facility and its visit types bookable online, or None when it offers none."""
    types = {t.id: t for t in await reads.bookable_types(db, facility_id)}
    if not types:
        return None
    found = await ref.facilities(db, [facility_id])
    return (found[0], types) if found else None


async def facilities(db: Any, reads: Reads, ref: PracticeSetupReads
                     ) -> ps.PortalBookingFacilityList:
    if await _open_policy(db, reads) is None:
        return ps.PortalBookingFacilityList(items=[])
    ids = list(dict.fromkeys(t.facility_id for t in await reads.bookable_types(db, None)))
    rows = await ref.facilities(db, ids) if ids else []
    addresses = await reads.addresses(db, [f.location_id for f in rows])
    return ps.PortalBookingFacilityList(items=[ps.PortalBookingFacility(
        id=f.id, name=f.name, time_zone=f.time_zone,
        address=_address(addresses.get(f.location_id))) for f in rows])


async def types(db: Any, reads: Reads, facility_id: UUID) -> ps.PortalBookingAppointmentTypeList:
    if await _open_policy(db, reads) is None:
        return ps.PortalBookingAppointmentTypeList(items=[])
    return ps.PortalBookingAppointmentTypeList(items=[ps.PortalBookingAppointmentType(
        id=t.id, name=t.name, duration_minutes=t.duration_minutes, telehealth=t.telehealth)
        for t in await reads.bookable_types(db, facility_id)])


async def providers(db: Any, reads: Reads, ref: PracticeSetupReads, facility_id: UUID
                    ) -> ps.PortalBookingProviderList:
    if await _open_policy(db, reads) is None or await _bookable(db, reads, ref,
                                                                 facility_id) is None:
        return ps.PortalBookingProviderList(items=[])
    rows = await ref.providers(db, [facility_id])
    return ps.PortalBookingProviderList(items=[ps.PortalBookingProvider(
        id=p.id, display_name=p.display_name,
        specialty=next(iter(p.specialties), None)) for p in rows])


def _window(policy: OnlinePolicy, now: datetime) -> tuple[datetime, datetime]:
    return (now + timedelta(minutes=policy.min_notice_minutes),
            now + timedelta(days=policy.window_days))


async def free_times(db: Any, reads: Reads, ref: PracticeSetupReads, *, facility_id: UUID,
                     appointment_type_id: UUID, day: date, provider_id: UUID | None,
                     now: datetime) -> ps.PortalSlotList:
    policy = await _open_policy(db, reads)
    found = await _bookable(db, reads, ref, facility_id) if policy else None
    if policy is None or found is None or appointment_type_id not in found[1]:
        return ps.PortalSlotList(items=[])
    earliest, latest = _window(policy, now)
    _, free = await staff.free_times_at(db, ref, found[0], day, provider_id,
                                        appointment_type_id, earliest,
                                        busy=repository.portal_busy)
    return ps.PortalSlotList(items=[
        ps.PortalSlot(start_at=f.start_at, end_at=f.end_at, provider_id=f.provider_id)
        for f in free if f.start_at <= latest][:100])


async def _quietly(db: AsyncSession, what: str, action: Any) -> None:
    """A side effect that must never refuse the booking, in a savepoint (logged on failure)."""
    try:
        async with db.begin_nested():
            await action()
    except Exception:  # noqa: BLE001 (the booking stands; the desk sees the missing check)
        log.warning("Portal booking: %s did not run", what)


async def _checked_start(db: Any, reads: Reads, patient: PortalPatient, policy: OnlinePolicy,
                         start: datetime, now: datetime, exclude: UUID | None = None) -> None:
    earliest, latest = _window(policy, now)
    if not earliest <= start <= latest:
        raise _rule("/startAt", "out-of-range")
    await repository.lock_patient_bookings(db, patient.patient_id)  # held until commit
    if not await reads.chart_active(db, patient.patient_id):
        # An inactive chart (merged away, or set inactive by the clinic) never books online.
        raise Forbidden("This chart can't book online; please call the clinic",
                        code="permission-denied")
    if await reads.upcoming_count(db, patient.patient_id, now, exclude) >= MAX_UPCOMING:
        raise _rule("/startAt", "out-of-range")


async def book(db: AsyncSession, reads: Reads, ref: PracticeSetupReads, patient: PortalPatient,
               body: ps.PortalAppointmentCreate, now: datetime) -> ps.PortalAppointment:
    if body.reason_code is None:
        raise _rule("/reasonCode", "required")
    policy = await _open_policy(db, reads)
    found = await _bookable(db, reads, ref, body.facility_id) if policy else None
    if policy is None or found is None or body.appointment_type_id not in found[1]:
        raise _rule("/appointmentTypeId", "invalid-reference")
    start = body.start_at.astimezone(now.tzinfo)
    await _checked_start(db, reads, patient, policy, start, now)
    _, _, new = await staff.validated_at(
        db, ref, found[0], patient_id=patient.patient_id, provider_id=body.provider_id,
        location_id=None, type_id=body.appointment_type_id, start=start, minutes=None,
        overbook=False, same_day_add_on=False, now=now, hold_patient=False)
    note = (body.reason_for_visit or "").strip()
    new = replace(new, reason=note or REASON_LABELS[body.reason_code],
                  reason_code=body.reason_code)
    appointment_id = await staff.insert_new(db, new)
    await _side_effects(db, appointment_id, new, rescheduled=False)
    await db.commit()
    return await one(db, reads, patient, appointment_id, now)


async def _side_effects(db: AsyncSession, appointment_id: UUID, new: repository.NewAppointment,
                        *, rescheduled: bool) -> None:
    async def board() -> None:
        await events.booked(db, appointment_id, patient_id=new.patient_id,
                            provider_id=new.provider_id, facility_id=new.facility_id,
                            start=new.start, rescheduled=rescheduled)
    await _quietly(db, "the schedule event", board)


async def _own_booked(db: AsyncSession, reads: Reads, patient: PortalPatient,
                      appointment_id: UUID) -> PortalAppointmentRow:
    row = await reads.get(db, patient.patient_id, appointment_id)
    if row is None:
        raise NotFound()  # another patient's appointment too (D84)
    require_own_record(patient, row.patient_id)
    if row.status != "booked":
        raise Conflict(code="invalid-state-transition", currentState=row.status)
    return row


async def _not_from_follow_up(db: AsyncSession, reads: Reads, appointment_id: UUID) -> None:
    if await reads.from_follow_up(db, appointment_id):
        raise ValidationFailed(code="business-rule-violation", errors=[
            field_error("path", "appointmentId", "not-editable")])  # the clinic moves it (D98)


def _in_time(row: PortalAppointmentRow, hours: int, now: datetime) -> None:
    if row.start - now < timedelta(hours=hours):
        raise _rule("/startAt", "out-of-range")  # too late online: call the clinic


async def cancel(db: AsyncSession, reads: Reads, patient: PortalPatient, appointment_id: UUID,
                 body: ps.PortalCancelRequest, now: datetime) -> ps.PortalAppointment:
    row = await _own_booked(db, reads, patient, appointment_id)
    policy = await reads.policy(db)
    if policy is None:
        raise _rule("/startAt", "out-of-range")
    _in_time(row, policy.cancel_cutoff_hours, now)
    locked = await repository.locked(db, appointment_id)
    if locked.status != "booked":
        raise Conflict(code="invalid-state-transition", currentState=locked.status)
    # Under the row lock: the desk may link the visit to a follow-up request meanwhile (D98).
    await _not_from_follow_up(db, reads, appointment_id)
    await repository.cancel(db, locked, PATIENT_CANCEL, body.reason_text, staff=False)

    async def board() -> None:
        await events.cancelled(db, appointment_id, patient_id=row.patient_id,
                               facility_id=row.facility_id, reason_code=PATIENT_CANCEL)
    await _quietly(db, "the schedule event", board)
    await db.commit()
    return await one(db, reads, patient, appointment_id, now)


async def reschedule(db: AsyncSession, reads: Reads, ref: PracticeSetupReads,
                     patient: PortalPatient, appointment_id: UUID,
                     body: ps.PortalRescheduleRequest, now: datetime) -> ps.PortalAppointment:
    """D61, as staff: the old visit is cancelled and the new one booked in one transaction; the
    location and visit type stay, the time (and provider) move."""
    row = await _own_booked(db, reads, patient, appointment_id)
    policy = await _open_policy(db, reads)
    if policy is None:
        raise _rule("/startAt", "out-of-range")
    _in_time(row, policy.reschedule_cutoff_hours, now)
    found = await _bookable(db, reads, ref, row.facility_id)
    if found is None or row.type_id not in found[1]:
        raise _rule("/startAt", "out-of-range")  # no longer bookable online: call the clinic
    start = body.start_at.astimezone(now.tzinfo)
    await _checked_start(db, reads, patient, policy, start, now, exclude=appointment_id)
    locked = await repository.locked(db, appointment_id)
    if locked.status != "booked":
        raise Conflict(code="invalid-state-transition", currentState=locked.status)
    # Under the row lock: the desk may link the visit to a follow-up request meanwhile (D98).
    await _not_from_follow_up(db, reads, appointment_id)
    _, _, new = await staff.validated_at(
        db, ref, found[0], patient_id=patient.patient_id,
        provider_id=body.provider_id or row.provider_id, location_id=None, type_id=row.type_id,
        start=start, minutes=None, overbook=False, same_day_add_on=False, now=now,
        rescheduling=appointment_id, hold_patient=False)
    await repository.cancel(db, locked, PATIENT_CANCEL, body.reason_text or "Rescheduled online",
                            staff=False)
    new = replace(new, reason=row.reason, reason_code=row.reason_code,
                  patient_instruction=row.patient_instruction, rescheduled_from_id=appointment_id)
    new_id = await staff.insert_new(db, new)
    await _side_effects(db, new_id, new, rescheduled=True)
    await db.commit()
    return await one(db, reads, patient, new_id, now)
