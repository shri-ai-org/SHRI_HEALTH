"""Appointment reads and writes for the scheduling API.

Everything runs in the request's session, so forced row-level security limits it to the caller's
clinic: another clinic's appointment or patient is simply not found. Reads are plain SQL on the
FHIR-shaped tables; writes use Anand's models (``app.db.models``), as his write helpers do: there
is no Appointment helper yet (IMPL_BATCH1_PLAN §8.5). Columns as
``backend/app/db/docs/contract_mapping.yaml`` ("Appointment") maps them.

``visitStatus`` is the latest visit step recorded after the appointment's last undone check-in
(``db/CLAUDE.md``, D55): steps before an undo stay as history but no longer count.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.db.models import MAPPERS, systems

from .slots import Busy

M = MAPPERS
LISTED_STATUSES = ("booked", "arrived", "checked-in", "fulfilled", "cancelled", "noshow")
BLOCKING_STATUSES = ("booked", "arrived", "checked-in", "pending")  # as shri_participant_sync
RESTRICTED_LABELS = ("R", "V")


@dataclass(frozen=True)
class AppointmentRow:
    id: UUID
    version: int
    status: str
    start: datetime
    end: datetime
    minutes: int
    patient_id: UUID
    provider_id: UUID | None
    location_id: UUID | None
    facility_id: UUID
    time_zone: str
    type_id: UUID | None
    type_code: str | None
    type_name: str | None
    reason: str | None
    comment: str | None
    patient_instruction: str | None
    same_day_add_on: bool
    overbook: bool
    cancel_code: str | None
    cancel_text: str | None
    cancelled_at: datetime | None
    rescheduled_from_id: UUID | None
    encounter_id: UUID | None
    visit_status: str | None
    visit_status_at: datetime | None
    room_name: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class PersonRef:
    id: UUID
    display_name: str
    given: str
    family: str
    restricted: bool
    active: bool
    merged: bool


# The undo cut-off in both visit-step reads: the Provenance that set the appointment's check-in
# encounter entered-in-error (D55).
_SELECT = """
SELECT a.id, a.meta_version_id, a.status, a.start, a."end", a.minutes_duration,
       a.subject_patient_id, a.ext_facility_id, f.timezone, a.ext_appointment_type_id,
       t.code AS type_code, t.name AS type_name, a.comment, a.patient_instruction,
       a.ext_same_day_add_on, a.ext_overbook, a.cancelation_reason_code,
       a.cancelation_reason_text, a.ext_cancelled_at, a.ext_rescheduled_from_appointment_id,
       a.created_at, a.meta_last_updated,
       pp.actor_practitioner_id AS provider_id, pl.actor_location_id AS location_id,
       (SELECT r.reason_code_text FROM clinical.appointment_reason r
         WHERE r.appointment_id = a.id ORDER BY r.created_at, r.id LIMIT 1) AS reason,
       (SELECT e.id FROM clinical.encounter e
         WHERE e.appointment_id = a.id AND e.status <> 'entered-in-error'
         LIMIT 1) AS encounter_id,
       vs.step AS visit_status, vs.occurred_at AS visit_status_at, rm.name AS room_name
FROM clinical.appointment a
JOIN admin.facility f ON f.id = a.ext_facility_id
LEFT JOIN admin.appointment_type t ON t.id = a.ext_appointment_type_id
LEFT JOIN LATERAL (SELECT x.actor_practitioner_id FROM clinical.appointment_participant x
                    WHERE x.appointment_id = a.id AND x.actor_practitioner_id IS NOT NULL
                    ORDER BY x.created_at LIMIT 1) pp ON true
LEFT JOIN LATERAL (SELECT x.actor_location_id FROM clinical.appointment_participant x
                    WHERE x.appointment_id = a.id AND x.actor_location_id IS NOT NULL
                    ORDER BY x.created_at LIMIT 1) pl ON true
LEFT JOIN LATERAL (SELECT v.step, v.occurred_at FROM admin.visit_flow_event v
                    WHERE v.appointment_id = a.id AND v.created_at > coalesce(
                      (SELECT max(pv.recorded) FROM clinical.provenance pv
                      JOIN clinical.encounter e ON pv.target_resource_type = 'Encounter'
                                               AND pv.target_id = e.id
                     WHERE e.appointment_id = a.id AND e.status = 'entered-in-error'
                       AND pv.activity_code = 'NULLIFY'), '-infinity'::timestamptz)
                    ORDER BY v.occurred_at DESC, v.created_at DESC LIMIT 1) vs ON true
LEFT JOIN LATERAL (SELECT loc.name FROM admin.visit_flow_event v
                     JOIN clinical.location loc ON loc.id = v.location_id
                    WHERE v.appointment_id = a.id AND v.created_at > coalesce(
                      (SELECT max(pv.recorded) FROM clinical.provenance pv
                      JOIN clinical.encounter e ON pv.target_resource_type = 'Encounter'
                                               AND pv.target_id = e.id
                     WHERE e.appointment_id = a.id AND e.status = 'entered-in-error'
                       AND pv.activity_code = 'NULLIFY'), '-infinity'::timestamptz)
                    ORDER BY v.occurred_at DESC, v.created_at DESC LIMIT 1) rm ON true
"""
_ONE = text(_SELECT + "WHERE a.id = :id")
_LIST = text(_SELECT + """
WHERE a.status = ANY(:statuses)
  AND a.ext_facility_id = ANY(:facilities)
  AND (CAST(:start AS timestamptz) IS NULL OR a.start >= :start)
  AND (CAST(:end AS timestamptz) IS NULL OR a.start < :end)
  AND (CAST(:provider AS uuid) IS NULL OR pp.actor_practitioner_id = :provider)
  AND (CAST(:patient AS uuid) IS NULL OR a.subject_patient_id = :patient)
  AND (CAST(:day_from AS date) IS NULL
       OR CAST(a.start AT TIME ZONE f.timezone AS date) BETWEEN :day_from AND :day_to)
ORDER BY a.start, a.id
LIMIT :limit OFFSET :offset
""")
_PEOPLE = text("""
SELECT p.id, p.active, p.meta_security && CAST(:labels AS varchar[]) AS restricted,
       EXISTS (SELECT 1 FROM clinical.patient_link l
                WHERE l.patient_id = p.id AND l.type = 'replaced-by') AS merged,
       n.given, n.family
FROM clinical.patient p
LEFT JOIN LATERAL (SELECT x.given, x.family FROM clinical.human_name x
                    WHERE x.patient_id = p.id
                    ORDER BY (x.use = 'official') DESC, x.created_at LIMIT 1) n ON true
WHERE p.id = ANY(:ids)
""")
_PROVIDER_NAMES = text("""
SELECT pr.id,
       (SELECT concat_ws(' ', array_to_string(n.prefix, ' '), array_to_string(n.given, ' '),
                         n.family, array_to_string(n.suffix, ' '))
          FROM clinical.human_name n WHERE n.practitioner_id = pr.id
         ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) AS display_name
FROM clinical.practitioner pr WHERE pr.id = ANY(:ids)
""")
_BUSY = text("""
SELECT x.actor_practitioner_id, x.period_start, x.period_end
FROM clinical.appointment_participant x
WHERE x.ext_blocking AND x.actor_practitioner_id = ANY(:providers)
  AND x.period_start < :end AND x.period_end > :start
""")
_OVERBOOKED = text("""
SELECT count(*) FROM clinical.appointment a
JOIN clinical.appointment_participant x ON x.appointment_id = a.id
WHERE a.ext_overbook AND a.status = ANY(:active) AND x.actor_practitioner_id = :provider
  AND a.start < :end AND a."end" > :start
  AND (CAST(:exclude AS uuid) IS NULL OR a.id <> :exclude)
""")
_SCHEDULE = text("""
SELECT s.id FROM clinical.schedule s
JOIN clinical.schedule_actor sa ON sa.schedule_id = s.id
LEFT JOIN clinical.practitioner_role r ON r.id = sa.practitioner_role_id
WHERE s.active AND s.ext_facility_id = :facility
  AND coalesce(sa.practitioner_id, r.practitioner_id) = :provider
ORDER BY s.created_at LIMIT 1
""")
_LOCK = text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))")
_LOCK_PATIENT = text("SELECT 1 FROM clinical.patient WHERE id = :id FOR SHARE")


def _row(r: Any) -> AppointmentRow:
    return AppointmentRow(
        id=r["id"], version=r["meta_version_id"], status=r["status"], start=r["start"],
        end=r["end"], minutes=r["minutes_duration"] or int((r["end"] - r["start"])
                                                             .total_seconds() // 60),
        patient_id=r["subject_patient_id"], provider_id=r["provider_id"],
        location_id=r["location_id"], facility_id=r["ext_facility_id"], time_zone=r["timezone"],
        type_id=r["ext_appointment_type_id"], type_code=r["type_code"], type_name=r["type_name"],
        reason=r["reason"], comment=r["comment"], patient_instruction=r["patient_instruction"],
        same_day_add_on=r["ext_same_day_add_on"], overbook=r["ext_overbook"],
        cancel_code=r["cancelation_reason_code"], cancel_text=r["cancelation_reason_text"],
        cancelled_at=r["ext_cancelled_at"],
        rescheduled_from_id=r["ext_rescheduled_from_appointment_id"],
        encounter_id=r["encounter_id"], visit_status=r["visit_status"],
        visit_status_at=r["visit_status_at"], room_name=r["room_name"],
        created_at=r["created_at"], updated_at=r["meta_last_updated"])


async def get(db: AsyncSession, appointment_id: UUID) -> AppointmentRow:
    found = (await db.execute(_ONE, {"id": appointment_id})).mappings().first()
    if found is None or found["status"] not in LISTED_STATUSES:
        raise NotFound()
    return _row(found)


async def list_appointments(db: AsyncSession, *, facilities: Iterable[UUID],
                            start: datetime | None, end: datetime | None,
                            provider_id: UUID | None, patient_id: UUID | None,
                            statuses: Sequence[str] | None, limit: int, offset: int,
                            days: tuple[date, date] | None = None) -> list[AppointmentRow]:
    """Ordered by start and ID, paged in SQL. ``days`` keeps only appointments whose start falls
    on those local days in their own facility's time zone (D40, D62)."""
    rows = (await db.execute(_LIST, {
        "statuses": list(statuses or LISTED_STATUSES), "facilities": list(facilities),
        "start": start, "end": end, "provider": provider_id, "patient": patient_id,
        "day_from": days[0] if days else None, "day_to": days[1] if days else None,
        "limit": limit, "offset": offset})).mappings()
    return [_row(r) for r in rows]


async def people(db: AsyncSession, patient_ids: Iterable[UUID]) -> dict[UUID, PersonRef]:
    """Name, restriction, and whether bookable, for the patients the clinic can see."""
    ids = list(dict.fromkeys(patient_ids))
    if not ids:
        return {}
    rows = (await db.execute(_PEOPLE, {"ids": ids, "labels": list(RESTRICTED_LABELS)}
                             )).mappings()
    out = {}
    for r in rows:
        given = " ".join(r["given"] or [])
        family = r["family"] or ""
        out[r["id"]] = PersonRef(r["id"], " ".join(f"{given} {family}".split()) or "Unnamed",
                                 given, family, bool(r["restricted"]), bool(r["active"]),
                                 bool(r["merged"]))
    return out


async def provider_names(db: AsyncSession, provider_ids: Iterable[UUID]) -> dict[UUID, str]:
    ids = [i for i in dict.fromkeys(provider_ids) if i is not None]
    if not ids:
        return {}
    rows = (await db.execute(_PROVIDER_NAMES, {"ids": ids})).mappings()
    return {r["id"]: " ".join((r["display_name"] or "").split()) or "Unnamed provider"
            for r in rows}


async def busy(db: AsyncSession, provider_ids: Iterable[UUID], start: datetime, end: datetime
               ) -> list[Busy]:
    rows = (await db.execute(_BUSY, {"providers": list(provider_ids), "start": start,
                                     "end": end})).all()
    return [Busy(r[0], r[1], r[2]) for r in rows]


async def overbooked(db: AsyncSession, provider_id: UUID, start: datetime, end: datetime,
                     exclude_id: UUID | None = None) -> int:
    """Overbooks of the provider overlapping the time, leaving out ``exclude_id`` (the
    appointment being rescheduled, which is cancelled in the same transaction)."""
    count: int = (await db.execute(_OVERBOOKED, {
        "provider": provider_id, "start": start, "end": end, "exclude": exclude_id,
        "active": list(BLOCKING_STATUSES)})).scalar_one()
    return count


async def schedule_for(db: AsyncSession, facility_id: UUID, provider_id: UUID) -> UUID | None:
    found: UUID | None = (await db.execute(_SCHEDULE, {"facility": facility_id,
                                                       "provider": provider_id})
                          ).scalar_one_or_none()
    return found


async def lock_provider_day(db: AsyncSession, provider_id: UUID, day: str) -> None:
    """Serializes bookings of one provider's local day (plan §2.2); the exclusion constraint
    is the last word."""
    await db.execute(_LOCK, {"key": f"appointment:{provider_id}:{day}"})


async def lock_patient(db: AsyncSession, patient_id: UUID) -> None:
    """Holds the patient row while booking, so a merge (D103), which updates it, can't commit
    between the merged check and the insert."""
    await db.execute(_LOCK_PATIENT, {"id": patient_id})


async def _user_id(db: AsyncSession) -> UUID | None:
    value = (await db.execute(text(
        "SELECT NULLIF(current_setting('app.current_user_id', true), '')"))).scalar_one()
    return UUID(value) if value else None


async def db_now(db: AsyncSession) -> datetime:
    now: datetime = (await db.execute(text("SELECT now()"))).scalar_one()
    return now


@dataclass(frozen=True)
class NewAppointment:
    patient_id: UUID
    provider_id: UUID
    facility_id: UUID
    location_id: UUID | None
    appointment_type_id: UUID
    schedule_id: UUID | None
    start: datetime
    end: datetime
    minutes: int
    reason: str | None
    comment: str | None
    patient_instruction: str | None
    same_day_add_on: bool
    overbook: bool
    rescheduled_from_id: UUID | None = None


async def insert(db: AsyncSession, new: NewAppointment) -> UUID:
    """The appointment, its participants (patient, provider, location) and its reason. The
    participant trigger copies the period and sets blocking, so the exclusion constraint refuses
    a double booking at flush (SQLSTATE 23P01)."""
    user_id = await _user_id(db)
    appt = M["appointment"](
        status="booked", start=new.start, end=new.end, minutes_duration=new.minutes,
        created=await db_now(db), comment=new.comment,
        patient_instruction=new.patient_instruction, subject_patient_id=new.patient_id,
        ext_appointment_type_id=new.appointment_type_id,
        ext_schedule_id=new.schedule_id, ext_facility_id=new.facility_id,
        ext_same_day_add_on=new.same_day_add_on, ext_overbook=new.overbook,
        ext_rescheduled_from_appointment_id=new.rescheduled_from_id,
        created_by_user_id=user_id, updated_by_user_id=user_id)
    db.add(appt)
    await db.flush()
    participants = [
        M["appointment_participant"](appointment_id=appt.id, actor_patient_id=new.patient_id,
                                     required="required", status="accepted"),
        M["appointment_participant"](appointment_id=appt.id,
                                     actor_practitioner_id=new.provider_id,
                                     required="required", status="accepted")]
    if new.location_id is not None:
        participants.append(M["appointment_participant"](
            appointment_id=appt.id, actor_location_id=new.location_id, required="required",
            status="accepted"))
    db.add_all(participants)
    if new.reason:
        db.add(M["appointment_reason"](appointment_id=appt.id, reason_code_text=new.reason))
    await db.flush()
    appointment_id: UUID = appt.id
    return appointment_id


async def locked(db: AsyncSession, appointment_id: UUID) -> Any:
    row = (await db.execute(select(M["appointment"]).where(M["appointment"].id == appointment_id)
                            .with_for_update().execution_options(populate_existing=True))
           ).scalar_one_or_none()
    if row is None or row.status not in LISTED_STATUSES:
        raise NotFound()
    return row


async def cancel(db: AsyncSession, row: Any, reason_code: str, reason_text: str | None) -> None:
    user_id = await _user_id(db)
    now = await db_now(db)  # before any change: a query would autoflush a half-cancelled row
    row.status = "cancelled"
    # The contract's reasonCode is the practice's own code (a picklist), not HL7's
    # appointment-cancellation-reason codes, so it is coded in the practice's local system.
    row.cancelation_reason_system = systems.SHRI_LOCAL
    row.cancelation_reason_code = reason_code
    row.cancelation_reason_text = reason_text
    row.ext_cancelled_at = now
    row.ext_cancelled_by_user_id = user_id
    row.updated_by_user_id = user_id
    await db.flush()


# Follow-up requests (D98, db/CLAUDE.md): booking a revisit sets booked; cancelling it reopens;
# rescheduling moves the link.
_FOLLOW_UP_OPEN = text("""
SELECT f.id FROM clinical.encounter_follow_up f
WHERE f.encounter_id = :encounter AND f.patient_id = :patient AND f.status = 'open'
FOR UPDATE
""")
_FOLLOW_UP_BOOK = text("""
UPDATE clinical.encounter_follow_up SET status = 'booked', booked_appointment_id = :appointment,
       updated_at = now()
WHERE id = :id
""")
_FOLLOW_UP_REOPEN = text("""
UPDATE clinical.encounter_follow_up SET status = 'open', booked_appointment_id = NULL,
       updated_at = now()
WHERE booked_appointment_id = :appointment AND status = 'booked'
""")
_FOLLOW_UP_MOVE = text("""
UPDATE clinical.encounter_follow_up SET booked_appointment_id = :new, updated_at = now()
WHERE booked_appointment_id = :old AND status = 'booked'
""")


async def open_follow_up(db: AsyncSession, encounter_id: UUID, patient_id: UUID) -> UUID | None:
    found: UUID | None = (await db.execute(_FOLLOW_UP_OPEN, {
        "encounter": encounter_id, "patient": patient_id})).scalar_one_or_none()
    return found


async def book_follow_up(db: AsyncSession, follow_up_id: UUID, appointment_id: UUID) -> None:
    await db.execute(_FOLLOW_UP_BOOK, {"id": follow_up_id, "appointment": appointment_id})


async def reopen_follow_up(db: AsyncSession, appointment_id: UUID) -> None:
    await db.execute(_FOLLOW_UP_REOPEN, {"appointment": appointment_id})


async def move_follow_up(db: AsyncSession, old: UUID, new: UUID) -> None:
    await db.execute(_FOLLOW_UP_MOVE, {"old": old, "new": new})
