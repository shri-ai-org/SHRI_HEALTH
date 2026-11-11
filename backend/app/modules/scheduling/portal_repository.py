"""The patient portal's appointment reads (B8a, D84, D93), as the patient sees them.

Everything runs in core's ``portal_db`` session: role ``shri_portal``, with the clinic and the
session's patient set, so the own-chart policies show this patient's rows only (another
patient's appointment simply doesn't exist here). Each query also names the session's patient,
so the rule holds twice. The portal's grants are narrower than ``shri_app``'s: no provenance and
no visit-flow events, and only some facility columns (``gen_db_rules.PORTAL_ADMIN_READ``), so
these queries are the portal's own and never the staff ones.

An appointment the portal lists has a provider and a visit type (the contract requires both;
staff booking always sets them). ``visit_summary_id`` is the visit's latest released after-visit
summary (``encounters.portal_repository``); a held one is invisible to ``shri_portal`` and gives
none.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import systems
from app.modules.encounters.portal_repository import AVS_TYPE_CODE

from . import repository

#: What the portal lists: staff statuses only, never proposed, pending or waitlisted requests.
PORTAL_STATUSES = ("booked", "arrived", "checked-in", "fulfilled", "cancelled", "noshow")
#: Statuses that are over, whatever the clock says.
OVER = ("fulfilled", "noshow")


@dataclass(frozen=True)
class PortalAddressRow:
    lines: tuple[str, ...]
    city: str | None
    state: str | None
    postal_code: str | None
    country: str | None


@dataclass(frozen=True)
class PortalAppointmentRow:
    id: UUID
    patient_id: UUID
    status: str
    start: datetime
    end: datetime
    time_zone: str
    facility_id: UUID
    facility_name: str
    facility_address: PortalAddressRow | None
    provider_id: UUID
    provider_name: str
    type_id: UUID
    type_name: str
    telehealth: bool
    reason: str | None
    patient_instruction: str | None
    visit_summary_id: UUID | None
    reason_code: str | None = None


@dataclass(frozen=True)
class OnlinePolicy:
    """The practice's online booking rules (``admin.online_booking_setting``)."""
    cancel_cutoff_hours: int
    reschedule_cutoff_hours: int
    enabled: bool = True
    window_days: int = 60
    min_notice_minutes: int = 1440


@dataclass(frozen=True)
class BookableTypeRow:
    id: UUID
    name: str
    duration_minutes: int
    telehealth: bool
    facility_id: UUID


class PortalAppointmentReads(Protocol):
    async def list(self, db: Any, patient_id: UUID, *, upcoming: bool, now: datetime,
                   limit: int, offset: int) -> list[PortalAppointmentRow]: ...

    async def get(self, db: Any, patient_id: UUID, appointment_id: UUID
                  ) -> PortalAppointmentRow | None: ...

    async def policy(self, db: Any) -> OnlinePolicy | None: ...

    async def bookable_types(self, db: Any, facility_id: UUID | None
                             ) -> Sequence[BookableTypeRow]: ...

    async def upcoming_count(self, db: Any, patient_id: UUID, now: datetime,
                             exclude: UUID | None = None) -> int: ...

    async def addresses(self, db: Any, location_ids: Sequence[UUID | None]
                        ) -> dict[UUID, PortalAddressRow]: ...


_SELECT = f"""
SELECT a.id, a.subject_patient_id, a.status, a.start, a."end", a.patient_instruction,
       f.id AS facility_id, f.name AS facility_name, f.timezone, f.location_id,
       t.id AS type_id, t.name AS type_name, t.is_telehealth,
       pp.actor_practitioner_id AS provider_id,
       (SELECT r.reason_code_text FROM clinical.appointment_reason r
         WHERE r.appointment_id = a.id ORDER BY r.created_at, r.id LIMIT 1) AS reason,
       (SELECT r.reason_code_code FROM clinical.appointment_reason r
         WHERE r.appointment_id = a.id AND r.reason_code_system = :reason_system
         ORDER BY r.created_at, r.id LIMIT 1) AS reason_code,
       (SELECT d.id FROM clinical.encounter e
          JOIN clinical.document_reference d ON d.context_encounter_id = e.id
         WHERE e.appointment_id = a.id AND d.subject_patient_id = a.subject_patient_id
           AND d.status = 'current' AND d.ext_origin = 'generated'
           AND (d.doc_status IS NULL OR d.doc_status IN ('final', 'amended'))
           AND d.type_system = :loinc AND d.type_code = '{AVS_TYPE_CODE}'
         ORDER BY d.date DESC, d.id LIMIT 1) AS visit_summary_id
FROM clinical.appointment a
JOIN admin.facility f ON f.id = a.ext_facility_id
JOIN admin.appointment_type t ON t.id = a.ext_appointment_type_id
JOIN LATERAL (SELECT x.actor_practitioner_id FROM clinical.appointment_participant x
               WHERE x.appointment_id = a.id AND x.actor_practitioner_id IS NOT NULL
               ORDER BY x.created_at LIMIT 1) pp ON true
WHERE a.subject_patient_id = :patient AND a.status = ANY(:statuses)
"""  # noqa: S608 (a constant, not input)
_UPCOMING = text(_SELECT + """
  AND a."end" > :now AND NOT (a.status = ANY(:over))
ORDER BY a.start, a.id LIMIT :limit OFFSET :offset
""")
_PAST = text(_SELECT + """
  AND (a."end" <= :now OR a.status = ANY(:over))
ORDER BY a.start DESC, a.id DESC LIMIT :limit OFFSET :offset
""")
_ONE = text(_SELECT + "  AND a.id = :id")
_ADDRESSES = text("""
SELECT x.location_id, x.line, x.city, x.state, x.postal_code, x.country
FROM clinical.address x
WHERE x.location_id = ANY(:ids)
ORDER BY x.location_id, (x.use = 'work') DESC, x.created_at
""")
_POLICY = text("SELECT cancel_cutoff_hours, reschedule_cutoff_hours, is_enabled, "
               "booking_window_days, min_notice_minutes FROM admin.online_booking_setting LIMIT 1")
#: Visit types bookable online at a facility (``admin.online_bookable_type``), active ones only.
_BOOKABLE_TYPES = text("""
SELECT t.id, t.name, t.default_duration_minutes, t.is_telehealth, o.facility_id
FROM admin.online_bookable_type o
JOIN admin.appointment_type t ON t.id = o.appointment_type_id
WHERE t.is_active AND (CAST(:facility AS uuid) IS NULL OR o.facility_id = :facility)
ORDER BY t.name, t.id
""")
#: The patient's booked appointments still ahead (the limit of upcoming online bookings).
_UPCOMING_COUNT = text("""
SELECT count(*) FROM clinical.appointment a
WHERE a.subject_patient_id = :patient AND a.status = 'booked' AND a.start > :now
  AND (CAST(:exclude AS uuid) IS NULL OR a.id <> :exclude)
""")


class SqlPortalAppointmentReads:
    """The real reads, on ``portal_db``'s session."""

    async def _rows(self, db: AsyncSession, query: Any, params: dict[str, Any]
                    ) -> list[PortalAppointmentRow]:
        found = list((await db.execute(query, {
            "statuses": list(PORTAL_STATUSES), "loinc": systems.LOINC,
            "reason_system": repository.PORTAL_REASON_SYSTEM, **params})).mappings())
        names = await repository.provider_names(db, [r["provider_id"] for r in found])
        addresses = await self.addresses(db, [r["location_id"] for r in found])
        return [PortalAppointmentRow(
            id=r["id"], patient_id=r["subject_patient_id"], status=r["status"],
            start=r["start"], end=r["end"], time_zone=r["timezone"],
            facility_id=r["facility_id"], facility_name=r["facility_name"],
            facility_address=addresses.get(r["location_id"]),
            provider_id=r["provider_id"],
            provider_name=names.get(r["provider_id"], "Your provider"),
            type_id=r["type_id"], type_name=r["type_name"], telehealth=bool(r["is_telehealth"]),
            reason=r["reason"], reason_code=r["reason_code"],
            patient_instruction=r["patient_instruction"],
            visit_summary_id=r["visit_summary_id"]) for r in found]

    async def addresses(self, db: AsyncSession, location_ids: Sequence[UUID | None]
                         ) -> dict[UUID, PortalAddressRow]:
        ids = [i for i in dict.fromkeys(location_ids) if i is not None]
        if not ids:
            return {}
        out: dict[UUID, PortalAddressRow] = {}
        for r in (await db.execute(_ADDRESSES, {"ids": ids})).mappings():
            out.setdefault(r["location_id"], PortalAddressRow(
                tuple(r["line"] or ()), r["city"], r["state"], r["postal_code"], r["country"]))
        return out

    async def list(self, db: AsyncSession, patient_id: UUID, *, upcoming: bool, now: datetime,
                   limit: int, offset: int) -> list[PortalAppointmentRow]:
        return await self._rows(db, _UPCOMING if upcoming else _PAST, {
            "patient": patient_id, "now": now, "over": list(OVER), "limit": limit,
            "offset": offset})

    async def get(self, db: AsyncSession, patient_id: UUID, appointment_id: UUID
                  ) -> PortalAppointmentRow | None:
        found = await self._rows(db, _ONE, {"patient": patient_id, "id": appointment_id})
        return found[0] if found else None

    async def policy(self, db: AsyncSession) -> OnlinePolicy | None:
        r = (await db.execute(_POLICY)).mappings().first()
        return None if r is None else OnlinePolicy(
            r["cancel_cutoff_hours"], r["reschedule_cutoff_hours"], bool(r["is_enabled"]),
            r["booking_window_days"], r["min_notice_minutes"])

    async def bookable_types(self, db: AsyncSession, facility_id: UUID | None
                             ) -> Sequence[BookableTypeRow]:
        return [BookableTypeRow(r["id"], r["name"], r["default_duration_minutes"],
                                bool(r["is_telehealth"]), r["facility_id"])
                for r in (await db.execute(_BOOKABLE_TYPES, {"facility": facility_id})
                          ).mappings()]

    async def upcoming_count(self, db: AsyncSession, patient_id: UUID, now: datetime,
                             exclude: UUID | None = None) -> int:
        found: int = (await db.execute(_UPCOMING_COUNT, {
            "patient": patient_id, "now": now, "exclude": exclude})).scalar_one()
        return found
