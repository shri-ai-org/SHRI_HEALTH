"""Reads for the practice-setup lists, in plain SQL under the request's session.

Row-level security does the clinic filtering: the session from ``tenant_db`` sees only the
caller's clinic, so no query here names a tenant. The payer directory (``admin.payer``,
``admin.payer_clearinghouse_id``) is platform-wide on purpose: no RLS, ``SELECT`` only for
``shri_app`` (sql/90_rls_grants.sql), the same rows for every clinic.

Every list is keyset-paginated (API_STANDARDS §8.1, §8.3): ordered by a sort key plus ``id``,
continuing strictly after the previous page's last ``(key, id)``, so a row inserted between two
pages never shifts the rest. Each list fetches ``limit + 1`` rows to know whether another page
exists and returns the last row's position as ``Page.next`` (``None`` on the last page). Child
rows for a page come in one query per child table with ``= ANY(:ids)``, never one per item.

Contract to column, where the name alone does not say it:

- Facility: the admin ``facility`` row plus its site ``clinical.location``: ``timeZone`` is
  ``facility.timezone``, ``address`` the site's ``address`` row, ``phone`` its first ``phone``
  contact point (by rank), ``billingLocation`` ``is_billing_location``, ``active``
  ``is_active``; ``updatedAt`` the later of the facility's ``updated_at`` and the site's
  ``meta_last_updated``.
- Provider: a ``clinical.practitioner`` with at least one active ``practitioner_role`` at a
  facility, so ``facilityIds`` is never empty (the contract's ``minItems: 1``; whether it
  should allow ``[]`` is asked on the PR). ``name`` is its
  official (else usual, else first) ``human_name`` (``prefix``/``suffix`` arrays joined with a
  space); ``npi`` its ``identifier`` with the US NPI system; ``qualifications`` its
  ``practitioner_qualification`` rows (``identifier_value`` as the license number, ``ext_state``,
  ``issuer_display``, the period); ``specialties`` and ``facilityIds`` come from its active roles
  (``practitioner_role_specialty``; ``practitioner_role_location`` matched to
  ``facility.location_id``); ``phone`` and ``email`` its own ``contact_point`` rows, work use
  first.
- ProviderSchedule: a ``clinical.schedule`` with a facility (``ext_facility_id``) and a
  practitioner actor (``schedule_actor.practitioner_id``, or the practitioner of its
  ``practitioner_role_id``). Rules are ``admin.schedule_availability_rule`` (``effective_from``
  and ``effective_to`` as ``startDate`` and ``endDate``) with their
  ``availability_rule_appointment_type`` links; exceptions ``admin.schedule_exception``
  (``is_available``). ``updatedAt`` also counts its rules' and exceptions' ``updated_at``.
- PracticePayer: ``admin.practice_payer`` with its directory payer; ``enrollments`` are the
  clinic's ``payer_enrollment`` rows for that payer (``practitioner_id`` as ``providerId``).

Sort keys: facilities, appointment types and payers by ``name``; practice payers by the payer's
name; providers and provider schedules by ``created_at`` (their names live in child rows). All
then by ``id``. Collation is C.UTF-8 (D33), so name order is byte order.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import time
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import Row, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import systems

from . import schemas
from .cursor import Kind, Position


@dataclass(frozen=True)
class Page[T]:
    items: list[T]
    next: Position | None  # the last item's position, or None on the last page


class SetupRepository(Protocol):
    async def list_facilities(self, db: AsyncSession, *, active: bool | None,
                              after: Position | None, limit: int
                              ) -> Page[schemas.Facility]: ...

    async def list_providers(self, db: AsyncSession, *, facility_id: UUID | None,
                             active: bool | None, after: Position | None, limit: int
                             ) -> Page[schemas.Provider]: ...

    async def list_appointment_types(self, db: AsyncSession, *, active: bool | None,
                                     after: Position | None, limit: int
                                     ) -> Page[schemas.AppointmentType]: ...

    async def list_provider_schedules(self, db: AsyncSession, *, provider_id: UUID | None,
                                      facility_id: UUID | None, active: bool | None,
                                      after: Position | None, limit: int
                                      ) -> Page[schemas.ProviderSchedule]: ...

    async def list_payers(self, db: AsyncSession, *, payer_name: str | None,
                          external_payer_id: str | None, payer_type: str | None,
                          active: bool | None, after: Position | None, limit: int
                          ) -> Page[schemas.Payer]: ...

    async def list_practice_payers(self, db: AsyncSession, *, active: bool | None,
                                   after: Position | None, limit: int
                                   ) -> Page[schemas.PracticePayer]: ...


# ----------------------------------------------------------------------------------- SQL
# A filter left as NULL matches everything; the keyset clause is off on the first page.
_FACILITIES = text("""
SELECT f.id, f.code, f.name, f.timezone, f.npi, f.clia_number, f.place_of_service_code,
       f.is_billing_location, f.is_active, f.created_at, f.location_id,
       GREATEST(f.updated_at, l.meta_last_updated) AS updated_at
FROM admin.facility f
JOIN clinical.location l ON l.id = f.location_id
WHERE (CAST(:active AS boolean) IS NULL OR f.is_active = :active)
  AND (CAST(:after_key AS text) IS NULL
       OR (f.name, f.id) > (CAST(:after_key AS text), CAST(:after_id AS uuid)))
ORDER BY f.name, f.id
LIMIT :limit
""")
_LOCATION_ADDRESSES = text("""
SELECT location_id, line, city, state, postal_code, country
FROM clinical.address WHERE location_id = ANY(CAST(:ids AS uuid[]))
""")
_LOCATION_PHONES = text("""
SELECT DISTINCT ON (location_id) location_id, value
FROM clinical.contact_point
WHERE location_id = ANY(CAST(:ids AS uuid[])) AND system = 'phone'
  AND use IS DISTINCT FROM 'old'
ORDER BY location_id, rank NULLS LAST, created_at, id
""")

_PROVIDERS = text("""
SELECT p.id, p.gender, p.active, p.created_at,
       GREATEST(p.meta_last_updated,
                (SELECT max(r.meta_last_updated) FROM clinical.practitioner_role r
                  WHERE r.practitioner_id = p.id)) AS updated_at
FROM clinical.practitioner p
WHERE EXISTS (
        SELECT 1 FROM clinical.practitioner_role r
        JOIN clinical.practitioner_role_location rl ON rl.practitioner_role_id = r.id
        JOIN admin.facility f ON f.location_id = rl.location_id
        WHERE r.practitioner_id = p.id AND r.active)
  AND (CAST(:active AS boolean) IS NULL OR p.active = :active)
  AND (CAST(:facility_id AS uuid) IS NULL OR EXISTS (
        SELECT 1 FROM clinical.practitioner_role r
        JOIN clinical.practitioner_role_location rl ON rl.practitioner_role_id = r.id
        JOIN admin.facility f ON f.location_id = rl.location_id
        WHERE r.practitioner_id = p.id AND r.active AND f.id = :facility_id))
  AND (CAST(:after_key AS timestamptz) IS NULL
       OR (p.created_at, p.id) > (CAST(:after_key AS timestamptz), CAST(:after_id AS uuid)))
ORDER BY p.created_at, p.id
LIMIT :limit
""")
_PROVIDER_NAMES = text("""
SELECT DISTINCT ON (practitioner_id) practitioner_id, family, given, prefix, suffix, text
FROM clinical.human_name
WHERE practitioner_id = ANY(CAST(:ids AS uuid[])) AND use IS DISTINCT FROM 'old'
ORDER BY practitioner_id,
         CASE use WHEN 'official' THEN 0 WHEN 'usual' THEN 1 ELSE 2 END, created_at, id
""")
_PROVIDER_NPIS = text("""
SELECT DISTINCT ON (practitioner_id) practitioner_id, value
FROM clinical.identifier
WHERE practitioner_id = ANY(CAST(:ids AS uuid[])) AND system = :npi_system
  AND use IS DISTINCT FROM 'old'
ORDER BY practitioner_id, created_at, id
""")
_PROVIDER_QUALIFICATIONS = text("""
SELECT practitioner_id, code_system, code_code, code_display, identifier_value, ext_state,
       issuer_display, period_start, period_end
FROM clinical.practitioner_qualification
WHERE practitioner_id = ANY(CAST(:ids AS uuid[]))
ORDER BY practitioner_id, period_start NULLS LAST, created_at, id
""")
_PROVIDER_SPECIALTIES = text("""
SELECT DISTINCT ON (r.practitioner_id, s.specialty_system, s.specialty_code)
       r.practitioner_id, s.specialty_system, s.specialty_code, s.specialty_display
FROM clinical.practitioner_role r
JOIN clinical.practitioner_role_specialty s ON s.practitioner_role_id = r.id
WHERE r.practitioner_id = ANY(CAST(:ids AS uuid[])) AND r.active
ORDER BY r.practitioner_id, s.specialty_system, s.specialty_code, s.created_at, s.id
""")
_PROVIDER_FACILITIES = text("""
SELECT DISTINCT r.practitioner_id, f.id AS facility_id
FROM clinical.practitioner_role r
JOIN clinical.practitioner_role_location rl ON rl.practitioner_role_id = r.id
JOIN admin.facility f ON f.location_id = rl.location_id
WHERE r.practitioner_id = ANY(CAST(:ids AS uuid[])) AND r.active
ORDER BY r.practitioner_id, f.id
""")
_PROVIDER_TELECOMS = text("""
SELECT DISTINCT ON (practitioner_id, system) practitioner_id, system, value
FROM clinical.contact_point
WHERE practitioner_id = ANY(CAST(:ids AS uuid[])) AND system IN ('phone', 'email')
  AND use IS DISTINCT FROM 'old'
ORDER BY practitioner_id, system, (use IS NOT DISTINCT FROM 'work') DESC, rank NULLS LAST,
         created_at, id
""")

_APPOINTMENT_TYPES = text("""
SELECT id, code, name, default_duration_minutes, color, allow_overlap, max_overbook,
       requires_eligibility_check, is_telehealth, is_new_patient, default_note_template_id,
       is_active, created_at, updated_at
FROM admin.appointment_type
WHERE (CAST(:active AS boolean) IS NULL OR is_active = :active)
  AND (CAST(:after_key AS text) IS NULL
       OR (name, id) > (CAST(:after_key AS text), CAST(:after_id AS uuid)))
ORDER BY name, id
LIMIT :limit
""")

_SCHEDULES = text("""
SELECT s.id, s.ext_facility_id AS facility_id, actor.provider_id, s.comment, s.active,
       s.created_at,
       GREATEST(s.meta_last_updated,
                (SELECT max(r.updated_at) FROM admin.schedule_availability_rule r
                  WHERE r.schedule_id = s.id),
                (SELECT max(e.updated_at) FROM admin.schedule_exception e
                  WHERE e.schedule_id = s.id)) AS updated_at
FROM clinical.schedule s
JOIN LATERAL (
  SELECT COALESCE(a.practitioner_id, pr.practitioner_id) AS provider_id
  FROM clinical.schedule_actor a
  LEFT JOIN clinical.practitioner_role pr ON pr.id = a.practitioner_role_id
  WHERE a.schedule_id = s.id AND COALESCE(a.practitioner_id, pr.practitioner_id) IS NOT NULL
  ORDER BY (a.practitioner_id IS NULL), a.created_at, a.id
  LIMIT 1
) actor ON true
WHERE s.ext_facility_id IS NOT NULL
  AND (CAST(:provider_id AS uuid) IS NULL OR actor.provider_id = :provider_id)
  AND (CAST(:facility_id AS uuid) IS NULL OR s.ext_facility_id = :facility_id)
  AND (CAST(:active AS boolean) IS NULL OR s.active = :active)
  AND (CAST(:after_key AS timestamptz) IS NULL
       OR (s.created_at, s.id) > (CAST(:after_key AS timestamptz), CAST(:after_id AS uuid)))
ORDER BY s.created_at, s.id
LIMIT :limit
""")
_SCHEDULE_RULES = text("""
SELECT r.id, r.schedule_id, r.day_of_week, r.start_time, r.end_time, r.slot_minutes,
       r.location_id, r.effective_from, r.effective_to,
       COALESCE(array_agg(t.appointment_type_id ORDER BY t.appointment_type_id)
                  FILTER (WHERE t.appointment_type_id IS NOT NULL),
                CAST('{}' AS uuid[])) AS appointment_type_ids
FROM admin.schedule_availability_rule r
LEFT JOIN admin.availability_rule_appointment_type t ON t.rule_id = r.id
WHERE r.schedule_id = ANY(CAST(:ids AS uuid[]))
GROUP BY r.id
ORDER BY r.schedule_id,
         array_position(CAST(ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] AS text[]),
                        CAST(r.day_of_week AS text)),
         r.start_time, r.id
""")
_SCHEDULE_EXCEPTIONS = text("""
SELECT id, schedule_id, start_at, end_at, is_available, reason
FROM admin.schedule_exception
WHERE schedule_id = ANY(CAST(:ids AS uuid[]))
ORDER BY schedule_id, start_at, id
""")

_PAYERS = text("""
SELECT p.id, p.name, p.payer_type, p.phone, p.address_line, p.city, p.state, p.postal_code,
       p.supports_eligibility, p.supports_claim_status, p.supports_era, p.is_active
FROM admin.payer p
WHERE (CAST(:name_like AS text) IS NULL OR p.name ILIKE :name_like ESCAPE '!')
  AND (CAST(:external_payer_id AS text) IS NULL OR EXISTS (
        SELECT 1 FROM admin.payer_clearinghouse_id c
        WHERE c.payer_id = p.id AND c.external_payer_id = :external_payer_id))
  AND (CAST(:payer_type AS text) IS NULL OR p.payer_type = :payer_type)
  AND (CAST(:active AS boolean) IS NULL OR p.is_active = :active)
  AND (CAST(:after_key AS text) IS NULL
       OR (p.name, p.id) > (CAST(:after_key AS text), CAST(:after_id AS uuid)))
ORDER BY p.name, p.id
LIMIT :limit
""")
_CLEARINGHOUSE_IDS = text("""
SELECT payer_id, clearinghouse, external_payer_id
FROM admin.payer_clearinghouse_id
WHERE payer_id = ANY(CAST(:ids AS uuid[]))
ORDER BY payer_id, clearinghouse, id
""")

_PRACTICE_PAYERS = text("""
SELECT pp.id, pp.payer_id, pp.is_active, pp.created_at, p.name AS payer_name, p.payer_type,
       GREATEST(pp.updated_at,
                (SELECT max(e.updated_at) FROM admin.payer_enrollment e
                  WHERE e.payer_id = pp.payer_id)) AS updated_at
FROM admin.practice_payer pp
JOIN admin.payer p ON p.id = pp.payer_id
WHERE (CAST(:active AS boolean) IS NULL OR pp.is_active = :active)
  AND (CAST(:after_key AS text) IS NULL
       OR (p.name, pp.id) > (CAST(:after_key AS text), CAST(:after_id AS uuid)))
ORDER BY p.name, pp.id
LIMIT :limit
""")
_ENROLLMENTS = text("""
SELECT payer_id, transaction, clearinghouse, practitioner_id, status, submitted_at, approved_at
FROM admin.payer_enrollment
WHERE payer_id = ANY(CAST(:ids AS uuid[]))
ORDER BY payer_id, practitioner_id NULLS FIRST, transaction, clearinghouse, id
""")


# ----------------------------------------------------------------------------------- helpers
def _keyset(after: Position | None, limit: int) -> dict[str, Any]:
    return {"after_key": after.key if after else None, "after_id": after.id if after else None,
            "limit": limit + 1}


def _cut(rows: Sequence[Row[Any]], limit: int, kind: Kind, key: str
         ) -> tuple[Sequence[Row[Any]], Position | None]:
    """The page's rows, and the last one's position when there is another page."""
    if len(rows) <= limit:
        return rows, None
    page = rows[:limit]
    last = page[-1]
    return page, Position(kind=kind, key=getattr(last, key), id=last.id)


def _by(rows: Sequence[Row[Any]], column: str) -> dict[UUID, list[Row[Any]]]:
    grouped: dict[UUID, list[Row[Any]]] = defaultdict(list)
    for row in rows:
        grouped[getattr(row, column)].append(row)
    return grouped


async def _children(db: AsyncSession, query: Any, ids: list[UUID], column: str,
                    **params: Any) -> dict[UUID, list[Row[Any]]]:
    if not ids:
        return {}
    rows = (await db.execute(query, {"ids": ids, **params})).all()
    return _by(rows, column)


def _hh_mm(value: time) -> str:
    return value.strftime("%H:%M")


def _joined(parts: Sequence[str] | None) -> str | None:
    return " ".join(parts) if parts else None


def _address(row: Row[Any] | None) -> schemas.Address | None:
    """The contract's Address needs lines, city, state and ZIP; the address table allows less
    (and other countries), so an incomplete or non-US address is left out."""
    if row is None or not row.line or not row.city or not row.state or not row.postal_code:
        return None
    if row.country not in (None, "US"):
        return None
    return schemas.Address(lines=list(row.line), city=row.city, state=row.state,
                           postal_code=row.postal_code)


def _name(row: Row[Any] | None) -> schemas.HumanName | None:
    if row is None:
        return None
    family = row.family or row.text
    if not family:
        return None
    return schemas.HumanName(family=family, given=list(row.given or []),
                             prefix=_joined(row.prefix), suffix=_joined(row.suffix))


def _like(fragment: str) -> str:
    """`payerName` as a contains-pattern, its own % and _ taken literally (ESCAPE '!')."""
    escaped = fragment.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    return f"%{escaped}%"


# ----------------------------------------------------------------------------------- repository
class SqlSetupRepository:
    async def list_facilities(self, db: AsyncSession, *, active: bool | None,
                              after: Position | None, limit: int) -> Page[schemas.Facility]:
        found = (await db.execute(_FACILITIES, {"active": active, **_keyset(after, limit)})).all()
        rows, next_position = _cut(found, limit, "facilities", "name")
        locations = [r.location_id for r in rows]
        addresses = await _children(db, _LOCATION_ADDRESSES, locations, "location_id")
        phones = await _children(db, _LOCATION_PHONES, locations, "location_id")
        items = [
            schemas.Facility(
                id=r.id, code=r.code, name=r.name, time_zone=r.timezone,
                address=_address(next(iter(addresses.get(r.location_id, [])), None)),
                phone=next((p.value for p in phones.get(r.location_id, [])), None),
                npi=r.npi, clia_number=r.clia_number,
                place_of_service_code=r.place_of_service_code,
                billing_location=r.is_billing_location, active=r.is_active,
                created_at=r.created_at, updated_at=r.updated_at)
            for r in rows
        ]
        return Page(items, next_position)

    async def list_providers(self, db: AsyncSession, *, facility_id: UUID | None,
                             active: bool | None, after: Position | None, limit: int
                             ) -> Page[schemas.Provider]:
        found = (await db.execute(_PROVIDERS, {"active": active, "facility_id": facility_id,
                                               **_keyset(after, limit)})).all()
        rows, next_position = _cut(found, limit, "providers", "created_at")
        ids = [r.id for r in rows]
        names = await _children(db, _PROVIDER_NAMES, ids, "practitioner_id")
        npis = await _children(db, _PROVIDER_NPIS, ids, "practitioner_id",
                               npi_system=systems.NPI)
        qualifications = await _children(db, _PROVIDER_QUALIFICATIONS, ids, "practitioner_id")
        specialties = await _children(db, _PROVIDER_SPECIALTIES, ids, "practitioner_id")
        facilities = await _children(db, _PROVIDER_FACILITIES, ids, "practitioner_id")
        telecoms = await _children(db, _PROVIDER_TELECOMS, ids, "practitioner_id")
        items = []
        for r in rows:
            contact = {t.system: t.value for t in telecoms.get(r.id, [])}
            items.append(schemas.Provider(
                id=r.id, name=_name(next(iter(names.get(r.id, [])), None)),
                npi=next((n.value for n in npis.get(r.id, [])), None), gender=r.gender,
                qualifications=[
                    schemas.ProviderQualification(
                        code=schemas.SetupCoding(system=q.code_system, code=q.code_code,
                                                 display=q.code_display),
                        license_number=q.identifier_value, state=q.ext_state,
                        issuer=q.issuer_display, start_date=q.period_start,
                        end_date=q.period_end)
                    for q in qualifications.get(r.id, [])
                    if q.code_system and q.code_code  # the contract's code needs both
                ],
                specialties=[
                    schemas.SetupCoding(system=s.specialty_system, code=s.specialty_code,
                                        display=s.specialty_display)
                    for s in specialties.get(r.id, [])
                    if s.specialty_system and s.specialty_code
                ],
                facility_ids=[f.facility_id for f in facilities.get(r.id, [])],
                phone=contact.get("phone"), email=contact.get("email"), active=r.active,
                created_at=r.created_at, updated_at=r.updated_at))
        return Page(items, next_position)

    async def list_appointment_types(self, db: AsyncSession, *, active: bool | None,
                                     after: Position | None, limit: int
                                     ) -> Page[schemas.AppointmentType]:
        found = (await db.execute(_APPOINTMENT_TYPES,
                                  {"active": active, **_keyset(after, limit)})).all()
        rows, next_position = _cut(found, limit, "appointment-types", "name")
        items = [
            schemas.AppointmentType(
                id=r.id, code=r.code, name=r.name,
                default_duration_minutes=r.default_duration_minutes, color=r.color,
                allow_overlap=r.allow_overlap, max_overbook=r.max_overbook,
                requires_eligibility_check=r.requires_eligibility_check,
                telehealth=r.is_telehealth, new_patient=r.is_new_patient,
                default_note_template_id=r.default_note_template_id, active=r.is_active,
                created_at=r.created_at, updated_at=r.updated_at)
            for r in rows
        ]
        return Page(items, next_position)

    async def list_provider_schedules(self, db: AsyncSession, *, provider_id: UUID | None,
                                      facility_id: UUID | None, active: bool | None,
                                      after: Position | None, limit: int
                                      ) -> Page[schemas.ProviderSchedule]:
        found = (await db.execute(_SCHEDULES, {
            "provider_id": provider_id, "facility_id": facility_id, "active": active,
            **_keyset(after, limit)})).all()
        rows, next_position = _cut(found, limit, "provider-schedules", "created_at")
        ids = [r.id for r in rows]
        rules = await _children(db, _SCHEDULE_RULES, ids, "schedule_id")
        exceptions = await _children(db, _SCHEDULE_EXCEPTIONS, ids, "schedule_id")
        items = [
            schemas.ProviderSchedule(
                id=r.id, provider_id=r.provider_id, facility_id=r.facility_id,
                availability_rules=[
                    schemas.AvailabilityRule(
                        id=x.id, day_of_week=x.day_of_week, start_time=_hh_mm(x.start_time),
                        end_time=_hh_mm(x.end_time), slot_minutes=x.slot_minutes,
                        location_id=x.location_id,
                        appointment_type_ids=list(x.appointment_type_ids),
                        start_date=x.effective_from, end_date=x.effective_to)
                    for x in rules.get(r.id, [])
                ],
                exceptions=[
                    schemas.ScheduleException(id=e.id, start_at=e.start_at, end_at=e.end_at,
                                              available=e.is_available, reason=e.reason)
                    for e in exceptions.get(r.id, [])
                ],
                comment=r.comment, active=r.active, created_at=r.created_at,
                updated_at=r.updated_at)
            for r in rows
        ]
        return Page(items, next_position)

    async def list_payers(self, db: AsyncSession, *, payer_name: str | None,
                          external_payer_id: str | None, payer_type: str | None,
                          active: bool | None, after: Position | None, limit: int
                          ) -> Page[schemas.Payer]:
        found = (await db.execute(_PAYERS, {
            "name_like": _like(payer_name) if payer_name is not None else None,
            "external_payer_id": external_payer_id, "payer_type": payer_type,
            "active": active, **_keyset(after, limit)})).all()
        rows, next_position = _cut(found, limit, "payers", "name")
        ids = [r.id for r in rows]
        clearinghouse_ids = await _children(db, _CLEARINGHOUSE_IDS, ids, "payer_id")
        items = [
            schemas.Payer(
                id=r.id, name=r.name, payer_type=r.payer_type, phone=r.phone,
                address_line=r.address_line, city=r.city, state=r.state,
                postal_code=r.postal_code,
                clearinghouse_ids=[
                    schemas.ClearinghouseId(clearinghouse=c.clearinghouse,
                                            external_payer_id=c.external_payer_id)
                    for c in clearinghouse_ids.get(r.id, [])
                ],
                supports_eligibility=r.supports_eligibility,
                supports_claim_status=r.supports_claim_status, supports_era=r.supports_era,
                active=r.is_active)
            for r in rows
        ]
        return Page(items, next_position)

    async def list_practice_payers(self, db: AsyncSession, *, active: bool | None,
                                   after: Position | None, limit: int
                                   ) -> Page[schemas.PracticePayer]:
        found = (await db.execute(_PRACTICE_PAYERS,
                                  {"active": active, **_keyset(after, limit)})).all()
        rows, next_position = _cut(found, limit, "practice-payers", "payer_name")
        enrollments = await _children(db, _ENROLLMENTS, [r.payer_id for r in rows], "payer_id")
        items = [
            schemas.PracticePayer(
                id=r.id, payer_id=r.payer_id,
                enrollments=[
                    schemas.PayerEnrollment(
                        transaction=e.transaction, clearinghouse=e.clearinghouse,
                        provider_id=e.practitioner_id, status=e.status,
                        submitted_at=e.submitted_at, approved_at=e.approved_at)
                    for e in enrollments.get(r.payer_id, [])
                ],
                payer=schemas.PayerSummary(id=r.payer_id, name=r.payer_name,
                                           payer_type=r.payer_type),
                active=r.is_active, created_at=r.created_at, updated_at=r.updated_at)
            for r in rows
        ]
        return Page(items, next_position)

