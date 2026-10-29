"""Practice setup as scheduling reads it: facilities, locations, providers, appointment types and
the providers' schedules (availability rules and exceptions).

These belong to Anand's practice-setup module (DATA_OWNERSHIP; IMPL_BATCH1_PLAN §1, "through
Anand's practice-setup service"), which isn't on main yet. ``PracticeSetupReads`` is the seam:
``SqlPracticeSetupReads`` reads his tables directly, columns as
``backend/app/db/docs/contract_mapping.yaml`` maps them ("Facilities, locations", "Providers"),
under the request's session, so forced row-level security keeps each clinic to its own rows.
**When his read service lands, ``reference()`` returns it instead and nothing else changes.**
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class FacilityRow:
    id: UUID
    code: str
    name: str
    time_zone: str
    location_id: UUID  # the site Location; rooms are its children


@dataclass(frozen=True)
class LocationRow:
    id: UUID
    facility_id: UUID
    name: str
    physical_type: str | None


@dataclass(frozen=True)
class ProviderRow:
    id: UUID  # the Practitioner
    display_name: str
    facility_ids: tuple[UUID, ...]
    specialties: tuple[str, ...]


@dataclass(frozen=True)
class AppointmentTypeRow:
    id: UUID
    code: str
    name: str
    default_duration_minutes: int
    color: str | None
    allow_overlap: bool
    max_overbook: int
    requires_eligibility_check: bool
    telehealth: bool
    new_patient: bool


@dataclass(frozen=True)
class AvailabilityRule:
    schedule_id: UUID
    provider_id: UUID
    day_of_week: str  # mon … sun
    start_time: time  # facility local time
    end_time: time
    slot_minutes: int
    location_id: UUID | None
    effective_from: date
    effective_to: date | None
    appointment_type_ids: frozenset[UUID]  # empty: every type

    def applies(self, day: date, appointment_type_id: UUID | None) -> bool:
        return (self.effective_from <= day and (self.effective_to is None
                                                or day <= self.effective_to)
                and (appointment_type_id is None or not self.appointment_type_ids
                     or appointment_type_id in self.appointment_type_ids))


@dataclass(frozen=True)
class ScheduleException:
    schedule_id: UUID
    provider_id: UUID
    start_at: datetime
    end_at: datetime
    is_available: bool  # True: extra availability; False: a block (leave, meeting)


class PracticeSetupReads(Protocol):
    async def facilities(self, db: AsyncSession, ids: Iterable[UUID] | None = None
                         ) -> list[FacilityRow]:
        """Active facilities, by name; only ``ids`` when given."""
        ...

    async def locations(self, db: AsyncSession, facility_ids: Iterable[UUID]
                        ) -> list[LocationRow]: ...

    async def providers(self, db: AsyncSession, facility_ids: Iterable[UUID]
                        ) -> list[ProviderRow]: ...

    async def appointment_types(self, db: AsyncSession, ids: Iterable[UUID] | None = None
                                ) -> list[AppointmentTypeRow]: ...

    async def availability(self, db: AsyncSession, facility_id: UUID,
                           provider_ids: Iterable[UUID] | None, start: datetime, end: datetime
                           ) -> tuple[list[AvailabilityRule], list[ScheduleException]]:
        """The rules of the facility's active schedules, and their exceptions overlapping
        [start, end)."""
        ...


# ----------------------------------------------------------------------------------- SQL reads
_FACILITIES = text("""
SELECT f.id, f.code, f.name, f.timezone, f.location_id
FROM admin.facility f
WHERE f.is_active AND (CAST(:ids AS uuid[]) IS NULL OR f.id = ANY(:ids))
ORDER BY f.name, f.id
""")
# A facility's bookable locations are the active child Locations of its site (rooms, wings…).
_LOCATIONS = text("""
SELECT l.id, f.id AS facility_id, l.name, l.physical_type_code
FROM clinical.location l JOIN admin.facility f ON l.part_of_location_id = f.location_id
WHERE f.id = ANY(:facilities) AND f.is_active AND coalesce(l.status, 'active') = 'active'
ORDER BY l.name, l.id
""")
# A provider works at the facilities whose site is one of the provider's active role locations.
_PROVIDERS = text("""
SELECT pr.id, f.id AS facility_id,
       (SELECT concat_ws(' ', array_to_string(n.prefix, ' '), array_to_string(n.given, ' '),
                         n.family, array_to_string(n.suffix, ' '))
          FROM clinical.human_name n
         WHERE n.practitioner_id = pr.id
         ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) AS display_name,
       (SELECT array_agg(DISTINCT coalesce(s.specialty_display, s.specialty_text))
          FROM clinical.practitioner_role_specialty s
         WHERE s.practitioner_role_id = r.id
           AND coalesce(s.specialty_display, s.specialty_text) IS NOT NULL) AS specialties
FROM clinical.practitioner pr
JOIN clinical.practitioner_role r ON r.practitioner_id = pr.id AND r.active
JOIN clinical.practitioner_role_location rl ON rl.practitioner_role_id = r.id
JOIN admin.facility f ON f.location_id = rl.location_id AND f.is_active
WHERE pr.active AND f.id = ANY(:facilities)
""")
_TYPES = text("""
SELECT t.id, t.code, t.name, t.default_duration_minutes, t.color, t.allow_overlap,
       t.max_overbook, t.requires_eligibility_check, t.is_telehealth, t.is_new_patient
FROM admin.appointment_type t
WHERE t.is_active AND (CAST(:ids AS uuid[]) IS NULL OR t.id = ANY(:ids))
ORDER BY t.name, t.id
""")
# A schedule's provider is its actor: a practitioner, or a practitioner role.
_RULES = text("""
SELECT s.id AS schedule_id, coalesce(a.practitioner_id, r.practitioner_id) AS provider_id,
       ru.id AS rule_id, ru.day_of_week, ru.start_time, ru.end_time, ru.slot_minutes,
       ru.location_id, ru.effective_from, ru.effective_to,
       (SELECT array_agg(t.appointment_type_id) FROM admin.availability_rule_appointment_type t
         WHERE t.rule_id = ru.id) AS type_ids
FROM clinical.schedule s
JOIN clinical.schedule_actor a ON a.schedule_id = s.id
LEFT JOIN clinical.practitioner_role r ON r.id = a.practitioner_role_id
JOIN admin.schedule_availability_rule ru ON ru.schedule_id = s.id
WHERE s.active AND s.ext_facility_id = :facility
  AND coalesce(a.practitioner_id, r.practitioner_id) IS NOT NULL
  AND (CAST(:providers AS uuid[]) IS NULL
       OR coalesce(a.practitioner_id, r.practitioner_id) = ANY(:providers))
""")
_EXCEPTIONS = text("""
SELECT e.schedule_id, coalesce(a.practitioner_id, r.practitioner_id) AS provider_id,
       e.start_at, e.end_at, e.is_available
FROM admin.schedule_exception e
JOIN clinical.schedule s ON s.id = e.schedule_id
JOIN clinical.schedule_actor a ON a.schedule_id = s.id
LEFT JOIN clinical.practitioner_role r ON r.id = a.practitioner_role_id
WHERE s.active AND s.ext_facility_id = :facility AND e.start_at < :end AND e.end_at > :start
  AND (CAST(:providers AS uuid[]) IS NULL
       OR coalesce(a.practitioner_id, r.practitioner_id) = ANY(:providers))
""")


def _ids(values: Iterable[UUID] | None) -> list[UUID] | None:
    return None if values is None else list(values)


class SqlPracticeSetupReads:
    async def facilities(self, db: AsyncSession, ids: Iterable[UUID] | None = None
                         ) -> list[FacilityRow]:
        rows = (await db.execute(_FACILITIES, {"ids": _ids(ids)})).mappings()
        return [FacilityRow(r["id"], r["code"], r["name"], r["timezone"], r["location_id"])
                for r in rows]

    async def locations(self, db: AsyncSession, facility_ids: Iterable[UUID]
                        ) -> list[LocationRow]:
        rows = (await db.execute(_LOCATIONS, {"facilities": list(facility_ids)})).mappings()
        return [LocationRow(r["id"], r["facility_id"], r["name"], r["physical_type_code"])
                for r in rows]

    async def providers(self, db: AsyncSession, facility_ids: Iterable[UUID]
                        ) -> list[ProviderRow]:
        rows = (await db.execute(_PROVIDERS, {"facilities": list(facility_ids)})).mappings()
        found: dict[UUID, ProviderRow] = {}
        for r in rows:
            name = " ".join((r["display_name"] or "").split()) or "Unnamed provider"
            before = found.get(r["id"])
            facilities = (before.facility_ids if before else ()) + (r["facility_id"],)
            specialties = tuple(sorted(set((before.specialties if before else ())
                                           + tuple(r["specialties"] or ()))))
            found[r["id"]] = ProviderRow(r["id"], name, tuple(dict.fromkeys(facilities)),
                                         specialties)
        return sorted(found.values(), key=lambda p: (p.display_name, str(p.id)))

    async def appointment_types(self, db: AsyncSession, ids: Iterable[UUID] | None = None
                                ) -> list[AppointmentTypeRow]:
        rows = (await db.execute(_TYPES, {"ids": _ids(ids)})).mappings()
        return [AppointmentTypeRow(
            r["id"], r["code"], r["name"], r["default_duration_minutes"], r["color"],
            r["allow_overlap"], r["max_overbook"], r["requires_eligibility_check"],
            r["is_telehealth"], r["is_new_patient"]) for r in rows]

    async def availability(self, db: AsyncSession, facility_id: UUID,
                           provider_ids: Iterable[UUID] | None, start: datetime, end: datetime
                           ) -> tuple[list[AvailabilityRule], list[ScheduleException]]:
        params = {"facility": facility_id, "providers": _ids(provider_ids)}
        rules = [AvailabilityRule(
            r["schedule_id"], r["provider_id"], str(r["day_of_week"]), r["start_time"],
            r["end_time"], r["slot_minutes"], r["location_id"], r["effective_from"],
            r["effective_to"], frozenset(r["type_ids"] or ()))
            for r in (await db.execute(_RULES, params)).mappings()]
        exceptions = [ScheduleException(r["schedule_id"], r["provider_id"], r["start_at"],
                                        r["end_at"], r["is_available"])
                      for r in (await db.execute(_EXCEPTIONS, {**params, "start": start,
                                                               "end": end})).mappings()]
        return rules, exceptions


def reference() -> PracticeSetupReads:
    """FastAPI dependency: practice setup's reads (see the module docstring)."""
    return SqlPracticeSetupReads()
