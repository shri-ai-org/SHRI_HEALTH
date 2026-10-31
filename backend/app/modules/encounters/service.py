"""Encounter rules: check-in opens the visit's encounter and its undo marks it entered-in-error
(D16, D55); rooming moves it to ``triaged`` and puts it in a room, ``with-provider`` starts it
(DATA_OWNERSHIP §5.2); the workspace read and edit (inventory #63-64) and vitals (#68-69, D69);
the follow-up request (D98) and the after-visit summary's hand-off (#86, D98).

Resources are written through Anand's FHIR write helpers (``app.db.fhir_store``), in the caller's
transaction; the encounter's reasons, room and participants through this module's repository (no
helper exists for them yet). The helpers' exceptions come back as core's errors. The API's
operations commit once, then read back (core refuses a second commit with changes, audit.py).
"""

from __future__ import annotations

import base64
import binascii
import calendar
import html
import re
from collections.abc import Awaitable, Callable, Sequence
from datetime import date, datetime, timedelta
from decimal import Decimal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.access import require_facility
from app.core.deps import CurrentUser
from app.core.errors import (
    Conflict,
    Forbidden,
    InvalidCursor,
    NotFound,
    PreconditionFailed,
    PreconditionRequired,
    ValidationFailed,
    field_error,
)
from app.core.long_running import Operation
from app.db.fhir_store import (
    Coded,
    EncounterIn,
    FhirStore,
    InvalidInput,
    InvalidTransition,
    Measured,
    ParticipantIn,
    Reason,
    ResourceNotFound,
    SqlFhirStore,
    VitalIn,
)

from . import repository, schemas
from .after_visit_summary import (
    FileStoreSource,
    StoredSummary,
    SummaryDetails,
    SummaryLink,
    SummaryLinks,
    SummaryOperations,
    SummaryStore,
)
from .repository import (
    EncounterHead,
    EncounterRepository,
    FollowUpIn,
    FollowUpRow,
    ReasonIn,
    SignedNote,
    SummaryContext,
    Versioned,
    follow_up_out,
)

_STORE = SqlFhirStore()

ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[object]]
#: Whether the user may open the chart (not restricted, on the care team, or a current grant):
#: reads only, refuses nothing, writes no audit row (core's ``chart_access``; D107).
ChartOpen = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[bool]]
Rooms = Callable[[AsyncSession, UUID], Awaitable[set[UUID]]]

#: Where vitals may be recorded (recordVitals): the visit is open.
RECORDING = ("arrived", "triaged", "in-progress")
#: Edits are refused once the visit is over (updateEncounter).
FROZEN = ("finished", "entered-in-error")
#: Who may change more than the reasons (updateEncounter: MA and RN change `reasons` only).
FULL_EDIT_ROLES = frozenset({"MD", "APP"})
#: UCUM units accepted per vital sign, stored as entered (D69; the contract's Vital).
VITAL_UNITS: dict[str, frozenset[str]] = {
    "body-weight": frozenset({"kg", "g", "[lb_av]"}),
    "body-height": frozenset({"cm", "[in_i]"}),
    "head-circumference": frozenset({"cm", "[in_i]"}),
    "body-temperature": frozenset({"Cel", "[degF]"}),
    "blood-pressure": frozenset({"mm[Hg]"}),
    "heart-rate": frozenset({"/min"}),
    "respiratory-rate": frozenset({"/min"}),
    "oxygen-saturation": frozenset({"%"}),
    "bmi": frozenset({"kg/m2"}),
}


# ------------------------------------------------------------------------------------ helpers
def etag(version: int) -> str:
    """A strong ETag from the row version (API_STANDARDS §11)."""
    return f'"{version}"'


def if_match_version(header: str | None) -> int:
    if header is None:
        raise PreconditionRequired()
    value = header.strip()
    if value.startswith('"') and value.endswith('"') and value[1:-1].isdigit():
        return int(value[1:-1])
    raise PreconditionFailed()  # a weak or malformed tag never matches a strong one


def business_rule(errors: list[dict[str, str]]) -> ValidationFailed:
    return ValidationFailed(code="business-rule-violation", errors=errors)


def _state(current: str) -> Conflict:
    return Conflict(code="invalid-state-transition", currentState=current)


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


def page[T](items: list[T], limit: int, offset: int) -> tuple[list[T], str | None]:
    """The repository fetched limit + 1 rows; the extra one says whether there is a next page."""
    if len(items) > limit:
        return items[:limit], encode_cursor(offset + limit)
    return items, None


# --------------------------------------------------------------- check-in, undo (scheduling)
async def open_for_check_in(db: AsyncSession, *, patient_id: UUID, facility_id: UUID,
                            appointment_id: UUID, provider_id: UUID | None,
                            reason_for_visit: str | None, self_pay: bool, at: datetime) -> UUID:
    """The visit's encounter, status ``arrived`` (D16): the appointment's provider as primary
    performer, its reason for visit, and ``selfPay`` (#74)."""
    written = await _STORE.create_encounter(db, EncounterIn(
        patient_id=patient_id, facility_id=facility_id, appointment_id=appointment_id,
        status="arrived", started_at=at, self_pay=self_pay,
        participants=(ParticipantIn(practitioner_id=provider_id),) if provider_id else (),
        reasons=(Coded(text=reason_for_visit),) if reason_for_visit else ()))
    return written.id


async def live_for_appointment(db: AsyncSession, appointment_id: UUID) -> UUID | None:
    return await repository.live_encounter(db, appointment_id)


async def visit_of(db: AsyncSession, encounter_id: UUID) -> tuple[UUID, str] | None:
    """The encounter's patient and status, for another module's record made at a visit
    (an allergy recorded at rooming); None for an encounter the clinic can't see."""
    try:
        head = await repository.SqlEncounterRepository().head(db, encounter_id)
    except NotFound:
        return None
    return head.patient_id, head.status


async def has_clinical_data(db: AsyncSession, encounter_id: UUID) -> bool:
    """Vitals, notes or diagnoses on the encounter (D55): any of them blocks the undo."""
    return await repository.has_clinical_data(db, encounter_id)


async def mark_entered_in_error(db: AsyncSession, encounter_id: UUID, reason: str) -> None:
    """The encounter becomes entered-in-error with its Provenance (D14, D24); never deleted."""
    try:
        await _STORE.set_encounter_status(db, encounter_id, "entered-in-error",
                                          reason=Reason(text=reason))
    except ResourceNotFound as gone:
        raise NotFound() from gone
    except InvalidTransition as done:
        raise _state(done.current_state) from done


# ------------------------------------------------------------ visit steps (recordVisitStatus)
async def room(db: AsyncSession, encounter_id: UUID, location_id: UUID) -> str:
    """Rooming (DATA_OWNERSHIP §5.2): ``arrived`` → ``triaged`` and the room becomes the
    encounter's active location. A second ``roomed`` (a move to another room, A42) only moves
    it. Returns the encounter's status. The caller has checked the room is in the facility."""
    repo = repository.SqlEncounterRepository()
    head = await repo.head(db, encounter_id, lock=True)
    if head.status not in ("arrived", "triaged"):
        raise _state(head.status)
    if head.status == "arrived":
        await _STORE.set_encounter_status(db, encounter_id, "triaged")
    await repo.set_location(db, encounter_id, location_id)
    return "triaged"


async def start_with_provider(db: AsyncSession, encounter_id: UUID) -> str:
    """``arrived`` or ``triaged`` → ``in-progress`` (DATA_OWNERSHIP §5.2)."""
    head = await repository.SqlEncounterRepository().head(db, encounter_id, lock=True)
    if head.status not in ("arrived", "triaged"):
        raise _state(head.status)
    await _STORE.set_encounter_status(db, encounter_id, "in-progress")
    return "in-progress"


# ----------------------------------------------------------------------------- the workspace
async def readable(db: AsyncSession, repo: EncounterRepository, check: ChartCheck,
                   user: CurrentUser, encounter_id: UUID) -> EncounterHead:
    """404 for an encounter the clinic can't see or at a facility not the user's, then the
    restricted-chart check (D37: 403 break-glass-required), before anything is locked."""
    head = await repo.head(db, encounter_id)
    require_facility(user, head.facility_id)
    await check(db, user, head.patient_id)
    return head


def signed_notes_only(user: CurrentUser) -> bool:
    """BIL reads signed notes only (SECURITY_MODEL §4.3); every other reader sees drafts."""
    return "BIL" in user.roles and not (user.roles & {"MD", "APP", "RN", "MA", "CO"})


async def get(db: AsyncSession, repo: EncounterRepository, check: ChartCheck,
              user: CurrentUser, encounter_id: UUID) -> Versioned[schemas.Encounter]:
    await readable(db, repo, check, user, encounter_id)
    return await repo.get(db, encounter_id, signed_notes_only=signed_notes_only(user))


def _reasons_in(reasons: Sequence[schemas.CodeableConcept]) -> tuple[list[ReasonIn],
                                                                      list[dict[str, str]]]:
    """Each reason holds one coding (``encounter_reason``); more is refused, never dropped."""
    out, errors = [], []
    for i, r in enumerate(reasons):
        if len(r.codings) > 1:
            errors.append(field_error("body", f"/reasons/{i}/codings/1", "out-of-range"))
            continue
        if not r.codings and not (r.text and r.text.strip()):
            errors.append(field_error("body", f"/reasons/{i}", "required"))
            continue
        c = r.codings[0] if r.codings else None
        out.append(ReasonIn(c.system if c else None, c.code if c else None,
                            c.display if c else None, r.text))
    return out, errors


NamePatient = Callable[[UUID], None]


async def update(db: AsyncSession, repo: EncounterRepository, check: ChartCheck, rooms: Rooms,
                 user: CurrentUser, encounter_id: UUID, patch: schemas.EncounterPatch,
                 if_match: str | None, name_patient: NamePatient
                 ) -> Versioned[schemas.Encounter]:
    """updateEncounter: reasons, room and participants, with If-Match (inventory #64). MA and
    RN may change `reasons` only (T52): anything else from them is 403. ``name_patient`` hands
    the patient to the audit before the commit."""
    version = if_match_version(if_match)
    head = await readable(db, repo, check, user, encounter_id)
    sent = patch.model_fields_set
    if sent - {"reasons"} and not user.roles & FULL_EDIT_ROLES:
        raise Forbidden("Only the reason for visit may be changed at rooming",
                        code="permission-denied")
    errors: list[dict[str, str]] = []
    reasons: list[ReasonIn] = []
    if "reasons" in sent:
        reasons, errors = _reasons_in(patch.reasons or [])
        systems = {r.system for r in reasons if r.system}
        known = await repo.known_code_systems(db, sorted(systems))
        errors += [field_error("body", f"/reasons/{i}/codings/0/system", "invalid-reference")
                   for i, r in enumerate(reasons) if r.system and r.system not in known]
    if "location_id" in sent and patch.location_id is not None and head.facility_id is not None:
        if patch.location_id not in await rooms(db, head.facility_id):
            errors.append(field_error("body", "/locationId", "invalid-reference"))
    participants: list[tuple[str, UUID]] = []
    if "participants" in sent:
        if patch.participants is None:
            raise ValidationFailed(errors=[field_error("body", "/participants",
                                                       "invalid-type")])
        seen: set[str] = set()
        for i, p in enumerate(patch.participants):
            if p.role in ("rendering", "supervising") and p.role in seen:
                errors.append(field_error("body", f"/participants/{i}/role",
                                          "conflicting-fields"))
            seen.add(p.role)
            participants.append((p.role, p.practitioner_id))
        found = await repo.practitioners_exist(db, [p for _, p in participants])
        errors += [field_error("body", f"/participants/{i}/practitionerId", "invalid-reference")
                   for i, (_, p) in enumerate(participants) if p not in found]
    if errors:
        raise business_rule(errors)
    locked = await repo.head(db, encounter_id, lock=True)
    if locked.version != version:
        raise PreconditionFailed(headers={"ETag": etag(locked.version)})
    if locked.status in FROZEN:
        raise _state(locked.status)
    if "reasons" in sent:
        await repo.replace_reasons(db, encounter_id, reasons)
    if "location_id" in sent:
        await repo.set_location(db, encounter_id, patch.location_id)
    if "participants" in sent:
        await repo.replace_participants(db, encounter_id, participants)
    name_patient(head.patient_id)
    await db.commit()
    return await repo.get(db, encounter_id, signed_notes_only=signed_notes_only(user))


# ------------------------------------------------------------------------------------- vitals
def _measured(q: schemas.Quantity) -> Measured:
    return Measured(value=Decimal(str(q.value)), unit=q.unit)


def vitals_in(body: schemas.VitalsCreate, now: datetime) -> tuple[VitalIn, ...]:
    """The entries as the helper takes them, or 422 business-rule-violation naming each problem
    (the contract's codes: a unit not allowed for the type, value with blood pressure or the
    reverse, the same type twice, a time in the future)."""
    errors: list[dict[str, str]] = []
    if not body.entries:
        errors.append(field_error("body", "/entries", "required"))
    if body.effective_at is not None and body.effective_at > now:
        errors.append(field_error("body", "/effectiveAt", "out-of-range"))
    seen: set[str] = set()
    out = []
    for i, e in enumerate(body.entries):
        at = f"/entries/{i}"
        if e.type in seen:
            errors.append(field_error("body", f"{at}/type", "conflicting-fields"))
        seen.add(e.type)
        allowed = VITAL_UNITS[e.type]
        if e.type == "blood-pressure":
            if e.value is not None:
                errors.append(field_error("body", f"{at}/value", "conflicting-fields"))
            if e.blood_pressure is None:
                errors.append(field_error("body", f"{at}/bloodPressure", "required"))
                continue
            for part in ("systolic", "diastolic"):
                if getattr(e.blood_pressure, part).unit not in allowed:
                    errors.append(field_error("body", f"{at}/bloodPressure/{part}/unit",
                                              "not-allowed-value"))
            out.append(VitalIn(type=e.type, systolic=_measured(e.blood_pressure.systolic),
                               diastolic=_measured(e.blood_pressure.diastolic)))
            continue
        if e.blood_pressure is not None:
            errors.append(field_error("body", f"{at}/bloodPressure", "conflicting-fields"))
        if e.value is None:
            errors.append(field_error("body", f"{at}/value", "required"))
            continue
        if e.value.unit not in allowed:
            errors.append(field_error("body", f"{at}/value/unit", "not-allowed-value"))
        out.append(VitalIn(type=e.type, value=_measured(e.value)))
    if errors:
        raise business_rule(errors)
    return tuple(out)


async def record_vitals(db: AsyncSession, repo: EncounterRepository, store: FhirStore,
                        check: ChartCheck, user: CurrentUser, encounter_id: UUID,
                        body: schemas.VitalsCreate, now: datetime, name_patient: NamePatient
                        ) -> list[schemas.Vital]:
    """All entries in one transaction (VitalsCreate), while the visit is open, in the order
    sent. ``name_patient`` hands the patient to the audit before the commit."""
    head = await readable(db, repo, check, user, encounter_id)
    entries = vitals_in(body, now)
    locked = await repo.head(db, encounter_id, lock=True)  # no status change meanwhile
    if locked.status not in RECORDING:
        raise _state(locked.status)
    try:
        written = await store.record_vitals(db, head.patient_id, encounter_id, entries,
                                            effective_at=body.effective_at)
    except InvalidInput as refused:  # the helper's own checks (the database's clock)
        raise business_rule([field_error("body", "/effectiveAt", "out-of-range")]) from refused
    name_patient(head.patient_id)
    await db.commit()
    ids = [w.id for w in written]
    found = {v.id: v for v in await repo.vitals(db, head.patient_id, ids=ids,
                                               include_entered_in_error=True, limit=len(ids))}
    return [found[i] for i in ids if i in found]


def check_range(date_from: date | None, date_to: date | None) -> None:
    if date_from is not None and date_to is not None and date_to < date_from:
        raise ValidationFailed(errors=[field_error("query", "dateTo", "out-of-range")])


async def list_vitals(db: AsyncSession, repo: EncounterRepository, check: ChartCheck,
                      user: CurrentUser, patient_id: UUID, *, vital_type: str | None,
                      date_from: date | None, date_to: date | None,
                      include_entered_in_error: bool, limit: int, cursor: str | None
                      ) -> tuple[list[schemas.Vital], str | None]:
    """Newest first (the trend view). ``dateFrom``/``dateTo`` are whole UTC days: a patient's
    vitals span facilities, so there is no one facility time zone to use."""
    check_range(date_from, date_to)
    offset = decode_cursor(cursor)
    await check(db, user, patient_id)  # 404 for an unknown patient, 403 for a restricted one
    found = await repo.vitals(db, patient_id, vital_type=vital_type, date_from=date_from,
                              date_to=date_to, include_entered_in_error=include_entered_in_error,
                              limit=limit + 1, offset=offset)
    return page(found, limit, offset)


# ------------------------------------------------------------------ follow-up request (D98)
#: Who asks for a follow-up (IMPL_BATCH1_PLAN §8.2 C: MD, APP). MA and RN hold encounters:update
#: for the reasons at rooming only (T52), so the request is refused to them (403).
FOLLOW_UP_ROLES = FULL_EDIT_ROLES
#: A visit in these states takes no follow-up request (the contract's 409).
NO_FOLLOW_UP = ("entered-in-error", "cancelled")


def _reason(text: str, pointer: str = "/reason") -> str:
    """A decline's or withdrawal's reason: blank is refused, as the database refuses it."""
    cleaned = " ".join(text.split())
    if not cleaned:
        raise ValidationFailed(errors=[field_error("body", pointer, "required")])
    return text.strip()


async def set_follow_up(db: AsyncSession, repo: EncounterRepository, check: ChartCheck,
                        user: CurrentUser, encounter_id: UUID, body: schemas.FollowUpRequestPut,
                        if_match: str | None, name_patient: NamePatient
                        ) -> Versioned[schemas.FollowUpRequest]:
    """setFollowUpRequest: adds the visit's request or replaces an open one, with If-Match on
    the encounter (its ETag moves with the request). A booked, declined or withdrawn one no
    longer changes (409)."""
    version = if_match_version(if_match)
    head = await readable(db, repo, check, user, encounter_id)
    if not user.roles & FOLLOW_UP_ROLES:
        raise Forbidden("Only the clinician asks for a follow-up", code="permission-denied")
    errors: list[dict[str, str]] = []
    if body.appointment_type_id is not None and body.appointment_type_id not in (
            await repo.appointment_types_exist(db, [body.appointment_type_id])):
        errors.append(field_error("body", "/appointmentTypeId", "invalid-reference"))
    if body.provider_id is not None and body.provider_id not in (
            await repo.practitioners_exist(db, [body.provider_id])):
        errors.append(field_error("body", "/providerId", "invalid-reference"))
    if errors:
        raise business_rule(errors)
    locked = await repo.head(db, encounter_id, lock=True)
    if locked.version != version:
        raise PreconditionFailed(headers={"ETag": etag(locked.version)})
    if locked.status in NO_FOLLOW_UP:
        raise _state(locked.status)
    current = await repo.follow_up(db, encounter_id, lock=True)
    if current is not None and current.status != "open":
        raise _state(current.status)
    note = body.note.strip() if body.note and body.note.strip() else None
    await repo.put_follow_up(db, encounter_id, head.patient_id, FollowUpIn(
        interval_value=body.interval.value, interval_unit=body.interval.unit,
        appointment_type_id=body.appointment_type_id, practitioner_id=body.provider_id,
        note=note), user.id)
    name_patient(head.patient_id)
    await db.commit()
    return await _follow_up_now(db, repo, encounter_id)


async def _follow_up_now(db: AsyncSession, repo: EncounterRepository, encounter_id: UUID
                         ) -> Versioned[schemas.FollowUpRequest]:
    after = await repo.head(db, encounter_id)
    found = await repo.follow_up(db, encounter_id)
    if found is None:  # never: it was just written
        raise NotFound()
    return Versioned(follow_up_out(found), after.version)


async def _locked_follow_up(db: AsyncSession, repo: EncounterRepository, encounter_id: UUID
                            ) -> tuple[EncounterHead, FollowUpRow | None]:
    """The encounter and its request, locked in that order (as setFollowUpRequest and the
    booking of the revisit lock them)."""
    locked = await repo.head(db, encounter_id, lock=True)
    return locked, await repo.follow_up(db, encounter_id, lock=True)


async def withdraw_follow_up(db: AsyncSession, repo: EncounterRepository, check: ChartCheck,
                             user: CurrentUser, encounter_id: UUID,
                             body: schemas.FollowUpWithdraw, if_match: str | None,
                             name_patient: NamePatient) -> Versioned[schemas.FollowUpRequest]:
    """withdrawFollowUpRequest: only the clinician who asked, only while it is open (D98,
    D67: clinicians take a request back; they never change the calendar)."""
    version = if_match_version(if_match)
    head = await readable(db, repo, check, user, encounter_id)
    reason = _reason(body.reason)
    locked, current = await _locked_follow_up(db, repo, encounter_id)
    if current is None:
        raise NotFound()
    if current.requested_by != user.id:
        raise Forbidden("Only the clinician who asked for the follow-up withdraws it",
                        code="permission-denied")
    if locked.version != version:
        raise PreconditionFailed(headers={"ETag": etag(locked.version)})
    if current.status != "open":
        raise _state(current.status)
    await repo.close_follow_up(db, encounter_id, "withdrawn", reason)
    name_patient(head.patient_id)
    await db.commit()
    return await _follow_up_now(db, repo, encounter_id)


async def decline_follow_up(db: AsyncSession, repo: EncounterRepository, openable: ChartOpen,
                            user: CurrentUser, encounter_id: UUID, body: schemas.FollowUpDecline,
                            if_match: str | None, name_patient: NamePatient
                            ) -> Versioned[schemas.FollowUpRequest]:
    """declineFollowUpRequest: at check-out the patient doesn't book the revisit (D98). The
    front desk and ADM (``follow-ups:decline``), with If-Match on the encounter (the follow-up
    summary's ``version``), so a decline never overwrites a request the clinician just changed.
    A restricted chart needs no break-glass here (D107): the clinic's and the user's facility's
    checks still apply (404), the decline is audited naming the patient, and for a restricted
    patient the user may not open (no grant, not on the care team) the answer leaves out the
    clinician's note."""
    version = if_match_version(if_match)
    head = await repo.head(db, encounter_id)  # 404: another clinic's
    require_facility(user, head.facility_id)  # 404: not the user's facility
    clinical = await openable(db, user, head.patient_id)
    reason = _reason(body.reason)
    locked, current = await _locked_follow_up(db, repo, encounter_id)
    if current is None:
        raise Conflict("No open follow-up request on this encounter",
                       code="invalid-state-transition")
    if locked.version != version:
        raise PreconditionFailed(headers={"ETag": etag(locked.version)})
    if current.status != "open":
        raise _state(current.status)
    await repo.close_follow_up(db, encounter_id, "declined", reason)
    name_patient(head.patient_id)
    await db.commit()
    done = await _follow_up_now(db, repo, encounter_id)
    if clinical:
        return done
    return Versioned(done.value.model_copy(update={"note": None}), done.version)


def due_date(visit_day: date, value: int, unit: str) -> date:
    """The day the follow-up falls due: ``value`` days, weeks or months after the visit's day
    in the facility's time zone (D40). A month later than a short month's last day is that
    month's last day (31 January + 1 month = 28 or 29 February)."""
    if unit == "day":
        return visit_day + timedelta(days=value)
    if unit == "week":
        return visit_day + timedelta(weeks=value)
    months = visit_day.month - 1 + value
    year, month = visit_day.year + months // 12, months % 12 + 1
    return date(year, month, min(visit_day.day, calendar.monthrange(year, month)[1]))


def local_moment(moment: datetime, time_zone: str) -> datetime:
    """The moment in the facility's zone (UTC if the zone is unknown)."""
    try:
        return moment.astimezone(ZoneInfo(time_zone))
    except (ZoneInfoNotFoundError, ValueError):
        return moment


def _long_date(day: date) -> str:
    return f"{day:%B} {day.day}, {day.year}"


def follow_up_text(follow_up: schemas.FollowUpRequest | None, visit_start: datetime,
                   time_zone: str, booked_start: datetime | None) -> str | None:
    """The summary's follow-up line: the booked revisit, or when to come back. A declined or
    withdrawn request, or none, prints nothing. The front desk's note is not for the patient."""
    if follow_up is None:
        return None
    if follow_up.status == "booked" and booked_start is not None:
        at = local_moment(booked_start, time_zone)
        hour = at.hour % 12 or 12
        return (f"Your next visit is booked for {_long_date(at.date())} at "
                f"{hour}:{at.minute:02d} {'AM' if at.hour < 12 else 'PM'}.")
    if follow_up.status != "open":
        return None
    value, unit = follow_up.interval.value, follow_up.interval.unit
    due = due_date(local_moment(visit_start, time_zone).date(), value, unit)
    return (f"Please come back in {value} {unit}{'' if value == 1 else 's'}, "
            f"around {_long_date(due)}. The front desk will help you book it.")


_TAG = re.compile(r"<[^>]+>")
_BREAK = re.compile(r"<\s*(br|/p|/div|/li)\b[^>]*>", re.IGNORECASE)


def plain_text(xhtml: str) -> str:
    """A note section's narrative (XHTML) as plain lines for the PDF."""
    lines = _BREAK.sub("\n", xhtml)
    lines = html.unescape(_TAG.sub("", lines))
    return "\n".join(" ".join(line.split()) for line in lines.splitlines() if line.strip())


def summary_details(encounter: schemas.Encounter, context: SummaryContext, note: SignedNote
                    ) -> SummaryDetails:
    """The visit, as #157 prints it: the practice, the patient, the visit's date and the
    clinician, the reasons, the diagnoses, the note's patient instructions and the follow-up.
    Medications and orders are Thulasi's modules, not built yet, so they are empty."""
    rendering = next((p.display_name for p in encounter.participants
                      if p.role == "rendering" and p.display_name), None)
    reasons = "; ".join(r.text or (r.codings[0].display or r.codings[0].code)
                        for r in encounter.reasons or [] if r.text or r.codings)
    diagnoses = tuple(f"{d.code.display} ({d.code.code})" if d.code.display else d.code.code
                      for d in encounter.diagnoses)
    instructions = "\n".join(t for t in (plain_text(x) for x in note.instructions_xhtml) if t)
    start = encounter.started_at or encounter.created_at
    return SummaryDetails(
        practice_name=context.practice_name or context.facility_name or "Your care team",
        patient_name=context.patient_name, visit_start=start, time_zone=encounter.time_zone,
        clinician_name=rendering or note.signer_name or "Your care team",
        facility_name=context.facility_name, reason_for_visit=reasons or None,
        diagnoses=diagnoses, instructions=instructions or None,
        follow_up=follow_up_text(encounter.follow_up, start, encounter.time_zone,
                                 context.booked_start))


async def create_summary(db: AsyncSession, repo: EncounterRepository, check: ChartCheck,
                         operations: SummaryOperations, summaries: SummaryStore,
                         files: FileStoreSource, user: CurrentUser, encounter_id: UUID,
                         body: schemas.AfterVisitSummaryRequest, name_patient: NamePatient
                         ) -> Operation:
    """createAfterVisitSummary (#86): from a signed note, the latest one unless ``noteId``
    names one. The PDF is small, so it is made in the request: the operation, the stored PDF,
    its document and the finished operation commit together, and the 202 carries the operation
    already ``succeeded`` (its result is the document). Generating again makes a new version.
    No signed note, or ``noteId`` not a signed note on this encounter: 422."""
    head = await readable(db, repo, check, user, encounter_id)
    if head.status == "entered-in-error":
        raise _state(head.status)
    note = await repo.signed_note(db, encounter_id, body.note_id)
    if note is None:
        pointer = "/noteId"
        raise business_rule([field_error("body", pointer, "invalid-reference" if body.note_id
                                         else "required")])
    found = await repo.get(db, encounter_id, signed_notes_only=True)
    context = await repo.summary_context(db, encounter_id, user.id)
    author = context.user_practitioner_id or note.signer_practitioner_id
    if author is None:  # never for a signed note: its signer is a practitioner
        raise business_rule([field_error("body", "/noteId", "invalid-reference")])
    details = summary_details(found.value, context, note)
    operation = await operations.start(db)
    stored = await summaries.store(db, files(), patient_id=head.patient_id,
                                   encounter_id=encounter_id, note_id=note.id,
                                   author_practitioner_id=author, details=details)
    finished = await operations.succeed(db, operation, stored.document_id)
    name_patient(head.patient_id)
    await db.commit()
    return finished


async def summary_link(db: AsyncSession, repo: EncounterRepository, check: ChartCheck,
                       summaries: SummaryStore, links: SummaryLinks, user: CurrentUser,
                       encounter_id: UUID, name_patient: NamePatient
                       ) -> tuple[StoredSummary, SummaryLink]:
    """getAfterVisitSummaryDownloadUrl (D98): the latest summary's short-lived link, so the
    front desk prints it at check-out; 404 until one exists. A chart read: the restricted-chart
    check runs first (D37) and the patient is named for the audit."""
    head = await readable(db, repo, check, user, encounter_id)
    stored = await summaries.latest(db, encounter_id)
    if stored is None:
        raise NotFound("No after-visit summary has been generated for this encounter yet")
    link = await links.link(db, user, stored.file_id)
    name_patient(head.patient_id)
    return stored, link
