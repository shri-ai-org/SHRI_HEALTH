"""Scheduling rules: booking, reschedule, cancel, the appointment views and the status board.

Restricted charts (SECURITY_MODEL §5.2 rule 2, agreed T16): booking, check-in and the schedule
views work without a break-glass grant, showing the name and the appointment only. The clinical
text (reason for visit, comment, instructions) is left out for a restricted patient the user may
not open (D60), using core's ``chart_access``, which reads and writes nothing else.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Iterable, Sequence
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.access import chart_access, facility_scope, require_facility
from app.core.deps import CurrentUser
from app.core.errors import (
    Conflict,
    Forbidden,
    InvalidCursor,
    NotFound,
    ValidationFailed,
    field_error,
)
from app.core.events import publish

from ..eligibility import service as eligibility
from ..encounters import service as encounters
from . import repository as repo
from . import schemas, slots
from .reference import AppointmentTypeRow, FacilityRow, PracticeSetupReads

MAX_RANGE_DAYS = 31  # D62
CANCELLABLE = ("booked", "arrived")  # before check-in; a checked-in visit is undone first (D55)
SHARED_ROLE = "DSP"


# ------------------------------------------------------------------------------------ helpers
def etag(version: int) -> str:
    return f'"{version}"'


def business_rule(where: str, code: str, location: str = "body") -> ValidationFailed:
    return ValidationFailed(code="business-rule-violation",
                            errors=[field_error(location, where, code)])


def invalid_query(name: str, code: str = "invalid-format") -> ValidationFailed:
    return ValidationFailed(errors=[field_error("query", name, code)])


def encode_cursor(offset: int) -> str:
    """Opaque page cursor. Core's encrypted cursors (T22) replace this when they land."""
    return base64.urlsafe_b64encode(f"o:{offset}".encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
    except (binascii.Error, UnicodeDecodeError) as bad:
        raise InvalidCursor() from bad
    kind, _, number = raw.partition(":")
    if kind != "o" or not number.isdigit():
        raise InvalidCursor()
    return int(number)


def page[T](items: Sequence[T], limit: int, offset: int) -> tuple[list[T], str | None]:
    """A slice of an in-memory list (lists the service builds itself)."""
    chunk = list(items[offset:offset + limit])
    more = offset + limit < len(items)
    return chunk, encode_cursor(offset + limit) if more else None


def fetched[T](items: list[T], limit: int, offset: int) -> tuple[list[T], str | None]:
    """The repository fetched limit + 1 rows; the extra one says whether there is a next page."""
    if len(items) > limit:
        return items[:limit], encode_cursor(offset + limit)
    return items, None


def initials(given: str, family: str) -> str:
    """Two letters for shared screens (D47); digits in Synthea-style names are skipped."""
    letters = [next((c for c in part if c.isalpha()), "") for part in (given, family)]
    return ("".join(letters).upper() or "?")[:4]


# ------------------------------------------------------------------------- reference reads
async def bookable_facilities(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser
                              ) -> list[schemas.BookableFacility]:
    rows = await ref.facilities(db, facility_scope(user))
    return [schemas.BookableFacility(id=f.id, code=f.code, name=f.name, time_zone=f.time_zone)
            for f in rows]


async def facility(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser,
                   facility_id: UUID) -> FacilityRow:
    require_facility(user, facility_id)
    found = await ref.facilities(db, [facility_id])
    if not found:
        raise NotFound()
    return found[0]


async def bookable_locations(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser,
                             facility_id: UUID | None) -> list[schemas.BookableLocation]:
    rows = await ref.locations(db, facility_scope(user, facility_id))
    return [schemas.BookableLocation(
        id=loc.id, facility_id=loc.facility_id, name=loc.name,
        physical_type=loc.physical_type if loc.physical_type in ("bu", "wi", "lvl", "ro")
        else None) for loc in rows]


async def bookable_providers(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser,
                             facility_id: UUID | None) -> list[schemas.BookableProvider]:
    scope = facility_scope(user, facility_id)
    rows = await ref.providers(db, scope)
    return [schemas.BookableProvider(
        id=p.id, display_name=p.display_name,
        facility_ids=[f for f in p.facility_ids if f in scope],
        specialties=list(p.specialties) or None) for p in rows]


async def bookable_types(db: AsyncSession, ref: PracticeSetupReads
                         ) -> list[schemas.BookableAppointmentType]:
    return [_type_out(t) for t in await ref.appointment_types(db)]


def _type_out(t: AppointmentTypeRow) -> schemas.BookableAppointmentType:
    return schemas.BookableAppointmentType(
        id=t.id, code=t.code, name=t.name, default_duration_minutes=t.default_duration_minutes,
        color=t.color, allow_overlap=t.allow_overlap, max_overbook=t.max_overbook,
        requires_eligibility_check=t.requires_eligibility_check, telehealth=t.telehealth,
        new_patient=t.new_patient)


# ------------------------------------------------------------------------------- free times
async def free_times(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser,
                     facility_id: UUID, day: date, provider_id: UUID | None,
                     appointment_type_id: UUID | None, now: datetime
                     ) -> tuple[FacilityRow, list[schemas.Slot]]:
    fac = await facility(db, ref, user, facility_id)
    duration = None
    if appointment_type_id is not None:
        types = await ref.appointment_types(db, [appointment_type_id])
        if not types:
            raise invalid_query("appointmentTypeId", "invalid-reference")
        duration = types[0].default_duration_minutes
    start, end = slots.day_bounds(day, fac.time_zone)
    providers = None if provider_id is None else [provider_id]
    rules, exceptions = await ref.availability(db, fac.id, providers, start, end)
    taken = await repo.busy(db, {r.provider_id for r in rules}, start, end)
    free = slots.free_slots(rules, exceptions, taken, day, fac.time_zone, duration,
                            appointment_type_id, not_before=now)
    return fac, [schemas.Slot(start_at=s.start, end_at=s.end, provider_id=s.provider_id,
                              facility_id=fac.id, location_id=s.location_id, overbook=False)
                 for s in free]


# ---------------------------------------------------------------------------------- booking
async def _validated(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser, *,
                     patient_id: UUID, provider_id: UUID, facility_id: UUID,
                     location_id: UUID | None, type_id: UUID, start: datetime,
                     minutes: int | None, overbook: bool, same_day_add_on: bool,
                     now: datetime, prefix: str = "", rescheduling: UUID | None = None
                     ) -> tuple[FacilityRow, AppointmentTypeRow, repo.NewAppointment]:
    """The booking rules (plan §2.2), shared by book and reschedule. ``rescheduling`` is the
    appointment being replaced: it doesn't count against the type's overbook limit."""
    fac = await facility(db, ref, user, facility_id)
    await repo.lock_patient(db, patient_id)  # no merge between this check and the insert
    person = (await repo.people(db, [patient_id])).get(patient_id)
    if person is None:
        raise NotFound()
    if person.merged:
        raise Conflict(code="patient-merged")
    if not person.active:
        raise business_rule(f"{prefix}/patientId", "invalid-reference")
    types = await ref.appointment_types(db, [type_id])
    if not types:
        raise business_rule(f"{prefix}/appointmentTypeId", "invalid-reference")
    kind = types[0]
    providers = {p.id: p for p in await ref.providers(db, [fac.id])}
    if provider_id not in providers:
        raise business_rule(f"{prefix}/providerId", "invalid-reference")
    # A room of the facility, or its site itself: a slot names the site when its schedule rule
    # does ("Room or site", the contract's locationId).
    if location_id is not None and location_id != fac.location_id and location_id not in {
            loc.id for loc in await ref.locations(db, [fac.id])}:
        raise business_rule(f"{prefix}/locationId", "invalid-reference")
    start = start.astimezone(UTC)
    length = minutes or kind.default_duration_minutes
    end = start + timedelta(minutes=length)
    if end <= now:
        raise business_rule(f"{prefix}/startAt", "out-of-range")
    day = slots.local_day(start, fac.time_zone)
    if same_day_add_on and day != slots.local_day(now, fac.time_zone):
        raise business_rule(f"{prefix}/sameDayAddOn", "conflicting-fields")
    day_start, day_end = slots.day_bounds(day, fac.time_zone)
    rules, exceptions = await ref.availability(db, fac.id, [provider_id], day_start, day_end)
    if not slots.within_hours(rules, exceptions, provider_id, start, end, fac.time_zone,
                              kind.id):
        raise business_rule(f"{prefix}/startAt", "out-of-range")  # outside the provider's hours
    await repo.lock_provider_day(db, provider_id, day.isoformat())
    if overbook:
        if kind.max_overbook < 1:
            raise business_rule(f"{prefix}/overbook", "not-allowed-value")
        if await repo.overbooked(db, provider_id, start, end,
                                 exclude_id=rescheduling) >= kind.max_overbook:
            raise business_rule(f"{prefix}/overbook", "out-of-range")  # the type's limit
    new = repo.NewAppointment(
        patient_id=patient_id, provider_id=provider_id, facility_id=fac.id,
        location_id=location_id, appointment_type_id=kind.id,
        schedule_id=await repo.schedule_for(db, fac.id, provider_id), start=start, end=end,
        minutes=length, reason=None, comment=None, patient_instruction=None,
        same_day_add_on=same_day_add_on, overbook=overbook)
    return fac, kind, new


async def _insert(db: AsyncSession, new: repo.NewAppointment) -> UUID:
    try:
        return await repo.insert(db, new)
    except IntegrityError as error:
        if getattr(error.orig, "sqlstate", None) == "23P01" or "no_double_booking" in str(error):
            raise Conflict("The slot is taken or overlaps another appointment",
                           code="booking-conflict") from None
        raise


async def book(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser,
               body: schemas.AppointmentCreate, now: datetime) -> UUID:
    _, _, new = await _validated(
        db, ref, user, patient_id=body.patient_id, provider_id=body.provider_id,
        facility_id=body.facility_id, location_id=body.location_id,
        type_id=body.appointment_type_id, start=body.start_at, minutes=body.duration_minutes,
        overbook=body.overbook, same_day_add_on=body.same_day_add_on, now=now)
    follow_up = None
    if body.follow_up_of_encounter_id is not None:
        follow_up = await repo.open_follow_up(db, body.follow_up_of_encounter_id, body.patient_id)
        if follow_up is None:
            raise business_rule("/followUpOfEncounterId", "invalid-reference")
    new = _with_text(new, body.reason_for_visit, body.comment, body.patient_instruction)
    appointment_id = await _insert(db, new)
    if follow_up is not None:
        await repo.book_follow_up(db, follow_up, appointment_id)  # D98, same transaction
    return appointment_id


def _with_text(new: repo.NewAppointment, reason: str | None, comment: str | None,
               instruction: str | None) -> repo.NewAppointment:
    return replace(new, reason=reason, comment=comment, patient_instruction=instruction)


async def reschedule(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser,
                     appointment_id: UUID, body: schemas.RescheduleRequest, now: datetime
                     ) -> UUID:
    """D61: the old appointment is cancelled with the reason and the new one booked under the
    booking rules, with rescheduledFromId, in one transaction."""
    require_facility(user, (await repo.get(db, appointment_id)).facility_id)
    row = await repo.locked(db, appointment_id)
    old = await repo.get(db, appointment_id)  # read under the lock, so no edit is lost
    if row.status not in CANCELLABLE:
        raise Conflict(code="invalid-state-transition", currentState=row.status)
    type_id = body.appointment_type_id or old.type_id
    if type_id is None:
        raise business_rule("/appointmentTypeId", "required")
    # A new type takes its own default length unless one is given (#68).
    minutes = body.duration_minutes or (None if type_id != old.type_id else old.minutes)
    provider_id = body.provider_id or old.provider_id
    if provider_id is None:
        raise business_rule("/providerId", "required")
    _, _, new = await _validated(
        db, ref, user, patient_id=old.patient_id, provider_id=provider_id,
        facility_id=body.facility_id or old.facility_id,
        location_id=body.location_id if body.location_id is not None else (
            old.location_id if body.facility_id in (None, old.facility_id) else None),
        type_id=type_id, start=body.start_at, minutes=minutes, overbook=old.overbook,
        same_day_add_on=False, now=now, rescheduling=old.id)
    await repo.cancel(db, row, body.reason_code, body.reason_text)
    new = replace(_with_text(new, old.reason, old.comment, old.patient_instruction),
                  rescheduled_from_id=old.id)
    new_id = await _insert(db, new)
    await repo.move_follow_up(db, old.id, new_id)
    return new_id


async def cancel(db: AsyncSession, user: CurrentUser, appointment_id: UUID,
                 body: schemas.CancelRequest) -> None:
    current = await repo.get(db, appointment_id)
    require_facility(user, current.facility_id)
    row = await repo.locked(db, appointment_id)
    if row.status not in CANCELLABLE:
        raise Conflict(code="invalid-state-transition", currentState=row.status)
    await repo.cancel(db, row, body.reason_code, body.reason_text)
    await repo.reopen_follow_up(db, appointment_id)  # D98: the revisit is open again


# ------------------------------------------------------------------------------------ views
async def _openable(db: AsyncSession, user: CurrentUser, people: Iterable[repo.PersonRef]
                    ) -> set[UUID]:
    """Restricted patients this user may open (a grant or the care team); the rest are open."""
    out = set()
    for person in people:
        if not person.restricted or (await chart_access(db, user, person.id)).allowed:
            out.add(person.id)
    return out


async def appointments_out(db: AsyncSession, user: CurrentUser,
                           rows: Sequence[repo.AppointmentRow]) -> list[schemas.Appointment]:
    people = await repo.people(db, [r.patient_id for r in rows])
    providers = await repo.provider_names(db, [r.provider_id for r in rows
                                               if r.provider_id is not None])
    openable = await _openable(db, user, people.values())
    return [_appointment(r, people, providers, openable) for r in rows]


def _patient_ref(person: repo.PersonRef | None, patient_id: UUID) -> schemas.SchedulingPatientRef:
    if person is None:
        return schemas.SchedulingPatientRef(id=patient_id, display_name="Unnamed")
    return schemas.SchedulingPatientRef(id=person.id, display_name=person.display_name,
                                        restricted=person.restricted)


def _provider_ref(row: repo.AppointmentRow, providers: dict[UUID, str]
                  ) -> schemas.SchedulingProviderRef:
    pid = row.provider_id or UUID(int=0)
    return schemas.SchedulingProviderRef(id=pid, display_name=providers.get(pid, "Unassigned"))


def _type_ref(row: repo.AppointmentRow) -> schemas.AppointmentTypeRef:
    return schemas.AppointmentTypeRef(id=row.type_id or UUID(int=0), code=row.type_code,
                                      name=row.type_name or "Appointment")


def _appointment(row: repo.AppointmentRow, people: dict[UUID, repo.PersonRef],
                 providers: dict[UUID, str], openable: set[UUID]) -> schemas.Appointment:
    clinical = row.patient_id in openable
    cancellation = None
    if row.status == "cancelled" and row.cancel_code and row.cancelled_at:
        cancellation = schemas.Cancellation(
            reason_code=row.cancel_code, cancelled_at=row.cancelled_at,
            reason_text=row.cancel_text if clinical else None)
    return schemas.Appointment(
        id=row.id, patient=_patient_ref(people.get(row.patient_id), row.patient_id),
        provider=_provider_ref(row, providers), facility_id=row.facility_id,
        location_id=row.location_id, appointment_type=_type_ref(row),
        status=row.status,  # LISTED_STATUSES only
        visit_status=row.visit_status,
        start_at=row.start, end_at=row.end, duration_minutes=row.minutes,
        time_zone=row.time_zone, reason_for_visit=row.reason if clinical else None,
        same_day_add_on=row.same_day_add_on, overbook=row.overbook,
        comment=row.comment if clinical else None,
        patient_instruction=row.patient_instruction if clinical else None,
        cancellation=cancellation, rescheduled_from_id=row.rescheduled_from_id,
        encounter_id=row.encounter_id, created_at=row.created_at, updated_at=row.updated_at)


def summary(a: schemas.Appointment) -> schemas.AppointmentSummary:
    return schemas.AppointmentSummary(
        id=a.id, patient=a.patient, provider=a.provider, facility_id=a.facility_id,
        appointment_type=a.appointment_type, status=a.status, visit_status=a.visit_status,
        start_at=a.start_at, end_at=a.end_at, reason_for_visit=a.reason_for_visit,
        same_day_add_on=a.same_day_add_on, overbook=a.overbook)


async def one(db: AsyncSession, user: CurrentUser, appointment_id: UUID
              ) -> tuple[schemas.Appointment, int]:
    row = await repo.get(db, appointment_id)
    require_facility(user, row.facility_id)  # another facility's appointment: 404
    return (await appointments_out(db, user, [row]))[0], row.version


def date_range(day: date | None, date_from: date | None, date_to: date | None,
               patient_id: UUID | None) -> tuple[date, date] | None:
    """The list's local days (inclusive), or None for a patient's whole list (D62)."""
    if day is not None and (date_from is not None or date_to is not None):
        raise invalid_query("date", "conflicting-fields")
    if day is not None:
        return day, day
    if (date_from is None) != (date_to is None):
        raise invalid_query("dateTo" if date_to is None else "dateFrom", "required")
    if date_from is not None and date_to is not None:
        if date_to < date_from:
            raise invalid_query("dateTo", "out-of-range")
        if (date_to - date_from).days + 1 > MAX_RANGE_DAYS:
            raise invalid_query("dateTo", "out-of-range")  # at most 31 days (D62)
        return date_from, date_to
    if patient_id is None:
        raise invalid_query("date", "required")
    return None


async def list_view(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser, *,
                    days: tuple[date, date] | None, facility_id: UUID | None,
                    provider_id: UUID | None, patient_id: UUID | None,
                    statuses: Sequence[str] | None, limit: int, offset: int
                    ) -> tuple[list[schemas.AppointmentSummary], str | None, str | None]:
    """Appointments in local days of each facility's own time zone (D40, D62)."""
    scope = facility_scope(user, facility_id)
    facilities = await ref.facilities(db, scope)
    zones = {f.time_zone for f in facilities}
    start = end = None
    if days is not None and facilities:
        # Widest UTC window over the facilities' zones (for the index); the query then keeps
        # each row whose start is on those days in its own facility's zone.
        bounds = [slots.day_bounds(days[0], z)[0] for z in zones] + [
            slots.day_bounds(days[1], z)[1] for z in zones]
        start, end = min(bounds), max(bounds)
    rows = await repo.list_appointments(
        db, facilities=[f.id for f in facilities], start=start, end=end,
        provider_id=provider_id, patient_id=patient_id, statuses=statuses,
        limit=limit + 1, offset=offset, days=days)
    chunk, next_cursor = fetched(rows, limit, offset)
    out = [summary(a) for a in await appointments_out(db, user, chunk)]
    return out, next_cursor, zones.pop() if len(zones) == 1 else None


async def board(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser,
                facility_id: UUID, day: date | None, provider_id: UUID | None, view: str,
                limit: int, offset: int, now: datetime
                ) -> tuple[schemas.StatusBoardList, list[UUID]]:
    """Today's flow (inventory #58). DSP always gets the shared view: initials, time, status
    (D47). The staff view adds names, type, visit step, room and encounter, and the reason for
    visit except for a restricted patient the user may not open (D60). Returns the patients
    shown by name, for the audit."""
    fac = await facility(db, ref, user, facility_id)
    shared = view != "staff" or SHARED_ROLE in user.roles
    when = day or slots.local_day(now, fac.time_zone)
    start, end = slots.day_bounds(when, fac.time_zone)
    rows = await repo.list_appointments(
        db, facilities=[fac.id], start=start, end=end, provider_id=provider_id, patient_id=None,
        statuses=[s for s in repo.LISTED_STATUSES if s != "cancelled"], limit=limit + 1,
        offset=offset)
    rows, next_cursor = fetched(rows, limit, offset)
    people = await repo.people(db, [r.patient_id for r in rows])
    items = []
    named: list[UUID] = []
    if shared:
        for r in rows:
            p = people.get(r.patient_id)
            items.append(schemas.StatusBoardItem(
                appointment_id=r.id, initials=initials(p.given, p.family) if p else "?",
                start_at=r.start, status=r.status))
    else:
        full = await appointments_out(db, user, rows)
        for r, a in zip(rows, full, strict=True):
            p = people.get(r.patient_id)
            named.append(r.patient_id)
            items.append(schemas.StatusBoardItem(
                appointment_id=r.id, patient=a.patient,
                initials=initials(p.given, p.family) if p else "?", provider=a.provider,
                start_at=r.start, status=a.status, visit_status=a.visit_status,
                visit_status_at=r.visit_status_at, room_name=r.room_name,
                appointment_type=a.appointment_type, reason_for_visit=a.reason_for_visit,
                encounter_id=r.encounter_id))
    return schemas.StatusBoardList(items=items, next_cursor=next_cursor, date=when,
                                   time_zone=fac.time_zone, facility_name=fac.name), named


# ----------------------------------------------------------------------- check-in and its undo
CHECK_IN_FROM = ("booked", "arrived")  # DATA_OWNERSHIP §5.1


async def check_in(db: AsyncSession, user: CurrentUser, appointment_id: UUID, self_pay: bool,
                   now: datetime) -> tuple[UUID, UUID | None]:
    """In one transaction (ADR-0011, D16): the appointment becomes checked-in, the visit step is
    recorded, the encounter is opened (status arrived) and, unless self-pay, an eligibility check
    is recorded for the primary coverage (D15). Returns the encounter and the check."""
    current = await repo.get(db, appointment_id)
    require_facility(user, current.facility_id)
    row = await repo.locked(db, appointment_id)
    if row.status not in CHECK_IN_FROM:
        raise Conflict(code="invalid-state-transition", currentState=row.status)
    person = (await repo.people(db, [current.patient_id])).get(current.patient_id)
    if person is not None and person.merged:
        raise Conflict(code="patient-merged")
    today = slots.local_day(now, current.time_zone)
    if slots.local_day(current.start, current.time_zone) != today:
        raise business_rule("appointmentId", "out-of-range", location="path")  # same day only
    coverage = None
    if not self_pay:
        coverage = await eligibility.primary_coverage(db, current.patient_id, today)
        if coverage is None:  # no active coverage and not self-pay (DATA_OWNERSHIP §5.1)
            raise business_rule("/selfPay", "required")
    at = await repo.db_now(db)
    await repo.set_status(db, row, "checked-in")
    await repo.add_visit_step(db, appointment_id, "checked-in", at)
    try:
        encounter_id = await encounters.open_for_check_in(
            db, patient_id=current.patient_id, facility_id=current.facility_id,
            appointment_id=appointment_id, provider_id=current.provider_id,
            reason_for_visit=current.reason, self_pay=self_pay, at=at)
    except IntegrityError as twice:  # one live encounter per appointment (A42)
        raise Conflict(code="invalid-state-transition", currentState="checked-in") from twice
    check_id = None
    if coverage is not None:
        check_id = await eligibility.record_check(
            db, coverage_id=coverage, patient_id=current.patient_id,
            appointment_id=appointment_id, encounter_id=encounter_id, trigger="check-in")
    return encounter_id, check_id


async def undo_check_in(db: AsyncSession, user: CurrentUser, appointment_id: UUID,
                        reason: str) -> None:
    """D55: only before rooming and before any clinical data. The appointment goes back to
    booked and the check-in encounter becomes entered-in-error with its Provenance; the visit
    steps and the eligibility check stay as history."""
    current = await repo.get(db, appointment_id)
    require_facility(user, current.facility_id)
    row = await repo.locked(db, appointment_id)
    if row.status != "checked-in":
        raise Conflict(code="invalid-state-transition", currentState=row.status)
    encounter_id = await encounters.live_for_appointment(db, appointment_id)
    if encounter_id is None:
        raise Conflict(code="invalid-state-transition", currentState=row.status)
    if await repo.roomed(db, appointment_id):
        raise Conflict("The patient has been roomed", code="invalid-state-transition",
                       currentState="roomed")
    if await encounters.has_clinical_data(db, encounter_id):
        raise Conflict("The encounter has vitals, notes or diagnoses",
                       code="invalid-state-transition", currentState=row.status)
    await encounters.mark_entered_in_error(db, encounter_id, reason)
    await repo.set_status(db, row, "booked")


# --------------------------------------------------------------------------------- visit steps
#: Who may record each visit step. appointments:status is held by FD, MA, RN, MD and APP, so the
#: split is the service's (DATA_OWNERSHIP §5.1: arrived and noshow by the front desk; §5.2:
#: roomed by MA and RN, with-provider by MD, APP and RN).
VISIT_STEP_ROLES: dict[str, frozenset[str]] = {
    "arrived": frozenset({"FD"}),
    "noshow": frozenset({"FD"}),
    "roomed": frozenset({"MA", "RN"}),
    "with-provider": frozenset({"MD", "APP", "RN"}),
}


async def record_status(db: AsyncSession, ref: PracticeSetupReads, user: CurrentUser,
                        appointment_id: UUID, body: schemas.StatusChangeRequest, now: datetime
                        ) -> None:
    """recordVisitStatus (inventory #57; DATA_OWNERSHIP §5.1, §5.2), in one transaction:
    - ``arrived``: booked → arrived, same day; the visit step is kept;
    - ``noshow``: booked → noshow, once the start time has passed (kept in the history);
    - ``roomed``: a checked-in visit's encounter becomes ``triaged`` and is put in the room,
      which must be in the appointment's facility; a second ``roomed`` moves it (A42);
    - ``with-provider``: the encounter becomes ``in-progress``;
    - ``checked-out`` is its own action (D98): 409 naming ``/status``.
    Each step is limited to the roles in VISIT_STEP_ROLES (403 otherwise), checked before any
    write.
    The status board reads the visit steps, so it shows each one with its room and time."""
    current = await repo.get(db, appointment_id)
    require_facility(user, current.facility_id)
    if body.status != "checked-out" and not user.roles & VISIT_STEP_ROLES[body.status]:
        raise Forbidden("Your role does not record this visit step", code="permission-denied")
    if body.status == "checked-out":
        raise Conflict("Check out with POST /appointments/{appointmentId}/check-out",
                       code="invalid-state-transition", currentState=current.status,
                       errors=[field_error("body", "/status", "not-allowed-value")])
    if body.room_location_id is not None and body.status != "roomed":
        raise business_rule("/roomLocationId", "conflicting-fields")
    if body.status == "roomed":
        if body.room_location_id is None:
            raise business_rule("/roomLocationId", "required")
        rooms = {loc.id for loc in await ref.locations(db, [current.facility_id])}
        if body.room_location_id not in rooms:
            raise business_rule("/roomLocationId", "invalid-reference")
    row = await repo.locked(db, appointment_id)
    at = await repo.db_now(db)
    subject = f"appointment/{appointment_id}"

    async def event(kind: str, about: str, data: dict[str, str]) -> None:
        await publish(db, kind, about, data, facility_id=current.facility_id,
                      patient_id=current.patient_id)

    if body.status in ("arrived", "noshow"):
        if row.status != "booked":
            raise Conflict(code="invalid-state-transition", currentState=row.status)
        if body.status == "arrived":
            if slots.local_day(current.start, current.time_zone) != slots.local_day(
                    now, current.time_zone):
                raise business_rule("appointmentId", "out-of-range", location="path")
            await repo.set_status(db, row, "arrived")
            await repo.add_visit_step(db, appointment_id, "arrived", at)
            await event("appointment.status-changed", subject, {"visitStatus": "arrived"})
            return
        if current.start > now:
            raise business_rule("/status", "out-of-range")  # before the start time
        await repo.set_status(db, row, "noshow")
        await event("appointment.status-changed", subject, {"status": "noshow"})
        return
    if row.status != "checked-in":
        raise Conflict(code="invalid-state-transition", currentState=row.status)
    encounter_id = await encounters.live_for_appointment(db, appointment_id)
    if encounter_id is None:
        raise Conflict(code="invalid-state-transition", currentState=row.status)
    room_id = body.room_location_id
    if room_id is not None:  # roomed: checked above
        encounter_status = await encounters.room(db, encounter_id, room_id)
        await repo.add_visit_step(db, appointment_id, "roomed", at, room_id)
    else:
        encounter_status = await encounters.start_with_provider(db, encounter_id)
        await repo.add_visit_step(db, appointment_id, "with-provider", at)
    await event("appointment.status-changed", subject, {"visitStatus": body.status})
    await event("encounter.status-changed", f"encounter/{encounter_id}",
                {"status": encounter_status})
