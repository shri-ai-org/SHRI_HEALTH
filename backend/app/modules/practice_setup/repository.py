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
- NoteTemplate: ``admin.note_template`` (``specialty_code``, ``note_type_loinc``,
  ``owner_user_id``, ``is_active``; ``version`` is the A41 counter the single GET's ETag comes
  from) with its ``note_template_section`` rows by ``sequence`` (``is_required`` as
  ``required``). ``personal`` is ``owner_user_id IS NOT NULL``. Every template is a clinic's
  (``tenant_id`` is NOT NULL): there are no platform-wide ones. RLS gives the clinic's rows;
  of those, the reads return the shared templates (``owner_user_id`` NULL) and the signed-in
  user's own personal ones (``app.current_user_id``, set by tenant_db), never another user's:
  the contract's ``personal`` is "the signed-in user's personal template" (the conservative
  reading, decided for this change). Another user's personal template is absent from the list
  and 404 on the single GET, and ``ownerUserId`` naming someone else gives an empty page.
  ``updatedAt`` also counts its sections' ``updated_at``.

Sort keys: facilities, appointment types, payers and note templates by ``name``; practice
payers by the payer's name; providers and provider schedules by ``created_at`` (their names live
in child rows). All then by ``id``. Collation is C.UTF-8 (D33), so name order is byte order.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Any, Literal, Protocol
from uuid import UUID

from sqlalchemy import Row, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MAPPERS, systems

from . import schemas
from .cursor import Kind, Position

M = MAPPERS


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

    async def list_note_templates(self, db: AsyncSession, *, owner_user_id: UUID | None,
                                  active: bool | None, after: Position | None, limit: int
                                  ) -> Page[schemas.NoteTemplate]: ...

    async def get_note_template(self, db: AsyncSession, note_template_id: UUID
                                ) -> schemas.NoteTemplate | None: ...


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
WHERE (CAST(:active AS boolean) IS NULL OR p.active = :active)
  AND (CAST(:provider_id AS uuid) IS NULL OR p.id = :provider_id)
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
  AND (CAST(:schedule_id AS uuid) IS NULL OR s.id = :schedule_id)
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

# One SELECT list for the list and the single GET; :one_id NULL lists, a UUID reads one row.
# Shared templates plus the signed-in user's own personal ones (see the module docstring).
_NOTE_TEMPLATES = text("""
SELECT t.id, t.code, t.version, t.name, t.specialty_code, t.note_type_loinc, t.owner_user_id,
       t.is_active, t.created_at,
       GREATEST(t.updated_at,
                (SELECT max(s.updated_at) FROM admin.note_template_section s
                  WHERE s.template_id = t.id)) AS updated_at
FROM admin.note_template t
WHERE (t.owner_user_id IS NULL
       OR t.owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  AND (CAST(:one_id AS uuid) IS NULL OR t.id = :one_id)
  AND (CAST(:owner_user_id AS uuid) IS NULL OR t.owner_user_id = :owner_user_id)
  AND (CAST(:active AS boolean) IS NULL OR t.is_active = :active)
  AND (CAST(:after_key AS text) IS NULL
       OR (t.name, t.id) > (CAST(:after_key AS text), CAST(:after_id AS uuid)))
ORDER BY t.name, t.id
LIMIT :limit
""")
_NOTE_TEMPLATE_SECTIONS = text("""
SELECT template_id, sequence, section_code, title, default_text, is_required
FROM admin.note_template_section
WHERE template_id = ANY(CAST(:ids AS uuid[]))
ORDER BY template_id, sequence, id
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


async def _provider_items(db: AsyncSession, rows: Sequence[Row[Any]]) -> list[schemas.Provider]:
    """The page's providers with their child rows, one query per child table."""
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
    return items


async def _schedule_items(db: AsyncSession, rows: Sequence[Row[Any]]
                         ) -> list[schemas.ProviderSchedule]:
    ids = [r.id for r in rows]
    rules = await _children(db, _SCHEDULE_RULES, ids, "schedule_id")
    exceptions = await _children(db, _SCHEDULE_EXCEPTIONS, ids, "schedule_id")
    return [
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
                                               "provider_id": None,
                                               **_keyset(after, limit)})).all()
        rows, next_position = _cut(found, limit, "providers", "created_at")
        return Page(await _provider_items(db, rows), next_position)

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
            "schedule_id": None, "provider_id": provider_id, "facility_id": facility_id,
            "active": active, **_keyset(after, limit)})).all()
        rows, next_position = _cut(found, limit, "provider-schedules", "created_at")
        return Page(await _schedule_items(db, rows), next_position)

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

    async def list_note_templates(self, db: AsyncSession, *, owner_user_id: UUID | None,
                                  active: bool | None, after: Position | None, limit: int
                                  ) -> Page[schemas.NoteTemplate]:
        found = (await db.execute(_NOTE_TEMPLATES, {
            "one_id": None, "owner_user_id": owner_user_id, "active": active,
            **_keyset(after, limit)})).all()
        rows, next_position = _cut(found, limit, "note-templates", "name")
        return Page(await _note_templates(db, rows), next_position)

    async def get_note_template(self, db: AsyncSession, note_template_id: UUID
                                ) -> schemas.NoteTemplate | None:
        found = (await db.execute(_NOTE_TEMPLATES, {
            "one_id": note_template_id, "owner_user_id": None, "active": None,
            **_keyset(None, 1)})).all()
        items = await _note_templates(db, found[:1])
        return items[0] if items else None


async def _note_templates(db: AsyncSession, rows: Sequence[Row[Any]]
                          ) -> list[schemas.NoteTemplate]:
    sections = await _children(db, _NOTE_TEMPLATE_SECTIONS, [r.id for r in rows], "template_id")
    return [
        schemas.NoteTemplate(
            id=r.id, code=r.code, version=r.version, name=r.name,
            specialty_code=r.specialty_code, note_type_loinc=r.note_type_loinc,
            personal=r.owner_user_id is not None,
            sections=[
                schemas.NoteTemplateSection(sequence=x.sequence, section_code=x.section_code,
                                            title=x.title, default_text=x.default_text,
                                            required=x.is_required)
                for x in sections.get(r.id, [])
            ],
            owner_user_id=r.owner_user_id, active=r.is_active, created_at=r.created_at,
            updated_at=r.updated_at)
        for r in rows
    ]


# ------------------------------------------------------------------------- practice settings
@dataclass(frozen=True)
class SettingsRow:
    """The practice's settings as stored: ``version`` is 0 while the practice has never set one
    (the platform default applies), so the first PATCH sends ``If-Match: "0"``."""
    show_sogi: bool
    version: int
    updated_at: datetime
    mrn_prefix: str
    mrn_system: str


class SettingsRepository(Protocol):
    async def get_settings(self, db: AsyncSession) -> SettingsRow | None: ...

    async def set_show_sogi(self, db: AsyncSession, value: bool, *, if_version: int
                            ) -> int | None:
        """The new version, or None when ``if_version`` isn't the current one."""
        ...


#: A49: the contract's showSexualOrientationAndGenderIdentity (D39).
SHOW_SOGI = "registration.show_sogi_fields"

# One row per practice (RLS): the setting, its platform default, and the MRN counter set at
# onboarding. A practice without an MRN counter has no settings to show (None).
_SETTINGS = text("""
SELECT COALESCE(ts.value, d.default_value) AS value, COALESCE(ts.version, 0) AS version,
       COALESCE(ts.updated_at, m.created_at) AS updated_at, m.prefix, m.system
FROM admin.mrn_counter m
CROSS JOIN admin.setting_definition d
LEFT JOIN admin.tenant_setting ts ON ts.setting_key = d.key
WHERE d.key = :key
""")
_UPDATE_SETTING = text("""
UPDATE admin.tenant_setting SET value = :value, updated_by_user_id = :user
WHERE setting_key = :key AND version = :version RETURNING version
""")
# The first value a practice sets: version 1. A concurrent first write loses on the
# (tenant_id, setting_key) key, as a stale If-Match would.
_INSERT_SETTING = text("""
INSERT INTO admin.tenant_setting (id, tenant_id, setting_key, value, created_by_user_id,
                                  updated_by_user_id)
VALUES (gen_random_uuid(), NULLIF(current_setting('app.current_tenant_id', true), '')::uuid,
        :key, :value, :user, :user)
ON CONFLICT (tenant_id, setting_key) DO NOTHING RETURNING version
""")
_USER = text("SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid")


class SqlSettingsRepository:
    async def get_settings(self, db: AsyncSession) -> SettingsRow | None:
        row = (await db.execute(_SETTINGS, {"key": SHOW_SOGI})).one_or_none()
        if row is None:
            return None
        return SettingsRow(row.value == "true", row.version, row.updated_at, row.prefix,
                           row.system)

    async def set_show_sogi(self, db: AsyncSession, value: bool, *, if_version: int
                            ) -> int | None:
        params = {"key": SHOW_SOGI, "value": "true" if value else "false",
                  "user": (await db.execute(_USER)).scalar_one()}
        if if_version == 0:
            version = (await db.execute(_INSERT_SETTING, params)).scalar_one_or_none()
        else:
            version = (await db.execute(_UPDATE_SETTING, {**params, "version": if_version})
                       ).scalar_one_or_none()
        return None if version is None else int(version)


# ------------------------------------------------------------------------- one facility
class FacilityRepository(Protocol):
    async def get_facility(self, db: AsyncSession, facility_id: UUID
                           ) -> tuple[schemas.Facility, int] | None: ...

    async def update_facility(self, db: AsyncSession, facility_id: UUID,
                              changes: schemas.FacilityPatch, *, if_version: int) -> int | None:
        """The facility's new version, or None when ``if_version`` isn't the current one."""
        ...


_FACILITY = text("""
SELECT f.id, f.code, f.name, f.timezone, f.npi, f.clia_number, f.place_of_service_code,
       f.is_billing_location, f.is_active, f.created_at, f.location_id, f.version,
       GREATEST(f.updated_at, l.meta_last_updated) AS updated_at
FROM admin.facility f JOIN clinical.location l ON l.id = f.location_id
WHERE f.id = :id
""")
#: The contract's names for the facility's own columns (the rest live on its site).
_FACILITY_COLUMNS = {"name": "name", "time_zone": "timezone", "npi": "npi",
                     "clia_number": "clia_number", "place_of_service_code": "place_of_service_code",
                     "billing_location": "is_billing_location", "active": "is_active"}
# Every column is set to itself unless the patch gives it (`set_<name>`), and the row is always
# updated, so the version (the ETag) moves when only the site's address or phone changes; the
# trigger bumps it (A41) and refuses a time zone that isn't IANA's.
_UPDATE_FACILITY = text("""
UPDATE admin.facility SET
  name = CASE WHEN :set_name THEN :name ELSE name END,
  timezone = CASE WHEN :set_time_zone THEN :time_zone ELSE timezone END,
  npi = CASE WHEN :set_npi THEN :npi ELSE npi END,
  clia_number = CASE WHEN :set_clia_number THEN :clia_number ELSE clia_number END,
  place_of_service_code = CASE WHEN :set_place_of_service_code THEN :place_of_service_code
                               ELSE place_of_service_code END,
  is_billing_location = CASE WHEN :set_billing_location THEN :billing_location
                             ELSE is_billing_location END,
  is_active = CASE WHEN :set_active THEN :active ELSE is_active END,
  updated_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
WHERE id = :id AND version = :version RETURNING version
""")
_SITE = text("SELECT location_id FROM admin.facility WHERE id = :id")
# The site's address and phone are replaced whole: the read shows one of each (_LOCATION_*),
# so an edit leaves exactly one. Other contact points (email, fax) are kept.
_DROP_ADDRESSES = text("DELETE FROM clinical.address WHERE location_id = :location")
_ADD_ADDRESS = text("""
INSERT INTO clinical.address (id, tenant_id, location_id, line, city, state, postal_code,
                             country, use)
VALUES (gen_random_uuid(), NULLIF(current_setting('app.current_tenant_id', true), '')::uuid,
        :location, :line, :city, :state, :postal_code, :country, 'work')
""")
_DROP_PHONES = text(
    "DELETE FROM clinical.contact_point WHERE location_id = :location AND system = 'phone'")
_ADD_PHONE = text("""
INSERT INTO clinical.contact_point (id, tenant_id, location_id, system, value, use, rank)
VALUES (gen_random_uuid(), NULLIF(current_setting('app.current_tenant_id', true), '')::uuid,
        :location, 'phone', :value, 'work', 1)
""")


class SqlFacilityRepository:
    async def get_facility(self, db: AsyncSession, facility_id: UUID
                           ) -> tuple[schemas.Facility, int] | None:
        r = (await db.execute(_FACILITY, {"id": facility_id})).one_or_none()
        if r is None:
            return None
        addresses = await _children(db, _LOCATION_ADDRESSES, [r.location_id], "location_id")
        phones = await _children(db, _LOCATION_PHONES, [r.location_id], "location_id")
        found = schemas.Facility(
            id=r.id, code=r.code, name=r.name, time_zone=r.timezone,
            address=_address(next(iter(addresses.get(r.location_id, [])), None)),
            phone=next((p.value for p in phones.get(r.location_id, [])), None),
            npi=r.npi, clia_number=r.clia_number, place_of_service_code=r.place_of_service_code,
            billing_location=r.is_billing_location, active=r.is_active,
            created_at=r.created_at, updated_at=r.updated_at)
        return found, int(r.version)

    async def update_facility(self, db: AsyncSession, facility_id: UUID,
                              changes: schemas.FacilityPatch, *, if_version: int) -> int | None:
        given = changes.model_dump(include=set(_FACILITY_COLUMNS))
        params = {**given, **{f"set_{k}": k in changes.model_fields_set for k in _FACILITY_COLUMNS},
                  "id": facility_id, "version": if_version}
        version = (await db.execute(_UPDATE_FACILITY, params)).scalar_one_or_none()
        if version is None:
            return None
        location = (await db.execute(_SITE, {"id": facility_id})).scalar_one()
        if changes.address is not None:
            a = changes.address
            await db.execute(_DROP_ADDRESSES, {"location": location})
            await db.execute(_ADD_ADDRESS, {"location": location, "line": a.lines, "city": a.city,
                                            "state": a.state, "postal_code": a.postal_code,
                                            "country": a.country})
        if changes.phone is not None:
            await db.execute(_DROP_PHONES, {"location": location})
            await db.execute(_ADD_PHONE, {"location": location, "value": changes.phone})
        return int(version)


# ------------------------------------------------------------------------- provider writes
# createProvider and createProviderSchedule (#129's tables, no schema change). Two rules the
# database doesn't enforce are the service's, each checked under a transaction-scoped advisory
# lock so two requests can't both pass: one NPI per practice (keyed on the NPI) and no
# overlapping availability rules for a provider at a facility (keyed on the pair). The lock
# key carries the clinic, so clinics never wait on each other. A unique index and an
# exclusion constraint would do this in the database; that is post-demo work (a migration
# that must first deal with the demo seed's overlapping rules).
#
# Contract to column:
# - Provider: a ``practitioner`` (``active`` true); ``name`` one official ``human_name``;
#   ``npi`` an official ``identifier`` in the NPI system; ``qualifications`` its
#   ``practitioner_qualification`` rows; ``phone`` and ``email`` work ``contact_point`` rows;
#   one active ``practitioner_role`` per facility (its organization the facility site's), with
#   a ``practitioner_role_location`` at the site and the ``specialties`` on every role.
# - ProviderSchedule: a ``schedule`` at the facility (``ext_facility_id``) with one
#   ``schedule_actor``, the provider's role there; rules and exceptions as the reads map them.
@dataclass(frozen=True)
class NewProvider:
    body: schemas.ProviderCreate
    facility_locations: dict[UUID, UUID]  # facility -> its site location


@dataclass(frozen=True)
class ExistingRule:
    day_of_week: str
    start_time: time
    end_time: time
    effective_from: date
    effective_to: date | None


Versioned = Literal["practitioner", "schedule"]


class ProviderRepository(Protocol):
    async def lock(self, db: AsyncSession, key: str) -> None: ...

    async def npi_valid(self, db: AsyncSession, npi: str) -> bool: ...

    async def npi_taken(self, db: AsyncSession, npi: str) -> bool: ...

    async def facility_locations(self, db: AsyncSession, facility_ids: list[UUID]
                                 ) -> dict[UUID, UUID]: ...

    async def create_provider(self, db: AsyncSession, new: NewProvider) -> UUID: ...

    async def get_provider(self, db: AsyncSession, provider_id: UUID
                           ) -> schemas.Provider | None: ...

    async def role_at(self, db: AsyncSession, provider_id: UUID, facility_id: UUID
                      ) -> UUID | None: ...

    async def missing_locations(self, db: AsyncSession, ids: set[UUID]) -> set[UUID]: ...

    async def missing_appointment_types(self, db: AsyncSession, ids: set[UUID]
                                        ) -> set[UUID]: ...

    async def rules_at(self, db: AsyncSession, provider_id: UUID, facility_id: UUID
                       ) -> list[ExistingRule]: ...

    async def booked_in(self, db: AsyncSession, provider_id: UUID, facility_id: UUID,
                        start: datetime, end: datetime) -> int: ...

    async def create_schedule(self, db: AsyncSession, body: schemas.ProviderScheduleCreate,
                              role_id: UUID) -> UUID: ...

    async def get_schedule(self, db: AsyncSession, schedule_id: UUID
                           ) -> schemas.ProviderSchedule | None: ...

    async def version(self, db: AsyncSession, table: Versioned, row_id: UUID) -> int: ...


_LOCK = text("SELECT pg_advisory_xact_lock(hashtextextended("
             "current_setting('app.current_tenant_id', true) || '|' || :key, 0))")
_NPI_VALID = text("SELECT public.shri_npi_valid(:npi)")
_NPI_TAKEN = text("""
SELECT EXISTS (SELECT 1 FROM clinical.identifier
               WHERE practitioner_id IS NOT NULL AND system = :system AND value = :npi
                 AND use IS DISTINCT FROM 'old')
""")
_FACILITY_SITES = text("""
SELECT f.id, f.location_id FROM admin.facility f WHERE f.id = ANY(CAST(:ids AS uuid[]))
""")
_SITE_ORGANIZATIONS = text("""
SELECT id, managing_organization_id FROM clinical.location WHERE id = ANY(CAST(:ids AS uuid[]))
""")
_ROLE_AT = text("""
SELECT r.id FROM clinical.practitioner_role r
JOIN clinical.practitioner_role_location rl ON rl.practitioner_role_id = r.id
JOIN admin.facility f ON f.location_id = rl.location_id
WHERE r.practitioner_id = :provider_id AND f.id = :facility_id AND r.active
ORDER BY r.created_at, r.id
LIMIT 1
""")
_LOCATIONS = text("SELECT id FROM clinical.location WHERE id = ANY(CAST(:ids AS uuid[]))")
_APPOINTMENT_TYPE_IDS = text(
    "SELECT id FROM admin.appointment_type WHERE id = ANY(CAST(:ids AS uuid[]))")
_RULES_AT = text("""
SELECT r.day_of_week, r.start_time, r.end_time, r.effective_from, r.effective_to
FROM admin.schedule_availability_rule r
JOIN clinical.schedule s ON s.id = r.schedule_id
JOIN clinical.schedule_actor a ON a.schedule_id = s.id
LEFT JOIN clinical.practitioner_role pr ON pr.id = a.practitioner_role_id
WHERE s.active AND s.ext_facility_id = :facility_id
  AND COALESCE(a.practitioner_id, pr.practitioner_id) = :provider_id
""")

#: The provider's appointments at the facility that time off must not cover: booked, arrived or
#: checked in (not fulfilled, cancelled or no-show).
HELD_STATUSES = ["booked", "arrived", "checked-in"]
_BOOKED_IN = text("""
SELECT count(DISTINCT a.id) FROM clinical.appointment a
JOIN clinical.appointment_participant x ON x.appointment_id = a.id
WHERE a.ext_facility_id = :facility_id AND x.actor_practitioner_id = :provider_id
  AND a.status = ANY(:held) AND a.start < :end AND a."end" > :start
""")


class SqlProviderRepository:
    async def lock(self, db: AsyncSession, key: str) -> None:
        await db.execute(_LOCK, {"key": key})

    async def npi_valid(self, db: AsyncSession, npi: str) -> bool:
        return bool((await db.execute(_NPI_VALID, {"npi": npi})).scalar_one())

    async def npi_taken(self, db: AsyncSession, npi: str) -> bool:
        return bool((await db.execute(_NPI_TAKEN, {"npi": npi, "system": systems.NPI}))
                    .scalar_one())

    async def facility_locations(self, db: AsyncSession, facility_ids: list[UUID]
                                 ) -> dict[UUID, UUID]:
        rows = (await db.execute(_FACILITY_SITES, {"ids": facility_ids})).all()
        return {r.id: r.location_id for r in rows}

    async def create_provider(self, db: AsyncSession, new: NewProvider) -> UUID:
        body, user_id = new.body, await _current_user(db)
        provider = M["practitioner"](active=True, gender=body.gender,
                                     created_by_user_id=user_id, updated_by_user_id=user_id)
        db.add(provider)
        await db.flush()
        pid: UUID = provider.id
        rows: list[Any] = [
            M["identifier"](practitioner_id=pid, system=systems.NPI, value=body.npi,
                            use="official"),
            M["human_name"](practitioner_id=pid, family=body.name.family,
                            given=list(body.name.given),
                            prefix=[body.name.prefix] if body.name.prefix else [],
                            suffix=[body.name.suffix] if body.name.suffix else [],
                            use="official"),
        ]
        rows += [M["practitioner_qualification"](
            practitioner_id=pid, code_system=q.code.system, code_code=q.code.code,
            code_display=q.code.display, identifier_value=q.license_number, ext_state=q.state,
            issuer_display=q.issuer, period_start=q.start_date, period_end=q.end_date)
            for q in body.qualifications]
        rows += [M["contact_point"](practitioner_id=pid, system=kind, value=value, use="work",
                                    rank=1)
                 for kind, value in (("phone", body.phone), ("email", body.email)) if value]
        sites = list(new.facility_locations.values())
        orgs = {r.id: r.managing_organization_id
                for r in (await db.execute(_SITE_ORGANIZATIONS, {"ids": sites})).all()}
        roles = [M["practitioner_role"](practitioner_id=pid, organization_id=orgs.get(site),
                                        active=True, created_by_user_id=user_id,
                                        updated_by_user_id=user_id)
                 for site in sites]
        db.add_all(rows + roles)
        await db.flush()
        for role, site in zip(roles, sites, strict=True):
            db.add(M["practitioner_role_location"](practitioner_role_id=role.id,
                                                   location_id=site))
            db.add_all(M["practitioner_role_specialty"](
                practitioner_role_id=role.id, specialty_system=c.system,
                specialty_code=c.code, specialty_display=c.display)
                for c in body.specialties)
        await db.flush()
        return pid

    async def get_provider(self, db: AsyncSession, provider_id: UUID
                           ) -> schemas.Provider | None:
        rows = (await db.execute(_PROVIDERS, {
            "active": None, "facility_id": None, "provider_id": provider_id,
            **_keyset(None, 1)})).all()
        items = await _provider_items(db, rows[:1])
        return items[0] if items else None

    async def role_at(self, db: AsyncSession, provider_id: UUID, facility_id: UUID
                      ) -> UUID | None:
        found: UUID | None = (await db.execute(_ROLE_AT, {
            "provider_id": provider_id, "facility_id": facility_id})).scalar_one_or_none()
        return found

    async def missing_locations(self, db: AsyncSession, ids: set[UUID]) -> set[UUID]:
        if not ids:
            return set()
        seen = set((await db.execute(_LOCATIONS, {"ids": list(ids)})).scalars())
        return ids - seen

    async def missing_appointment_types(self, db: AsyncSession, ids: set[UUID]
                                        ) -> set[UUID]:
        if not ids:
            return set()
        seen = set((await db.execute(_APPOINTMENT_TYPE_IDS, {"ids": list(ids)})).scalars())
        return ids - seen

    async def rules_at(self, db: AsyncSession, provider_id: UUID, facility_id: UUID
                       ) -> list[ExistingRule]:
        rows = (await db.execute(_RULES_AT, {"provider_id": provider_id,
                                             "facility_id": facility_id})).all()
        return [ExistingRule(r.day_of_week, r.start_time, r.end_time, r.effective_from,
                             r.effective_to) for r in rows]

    async def booked_in(self, db: AsyncSession, provider_id: UUID, facility_id: UUID,
                        start: datetime, end: datetime) -> int:
        count: int = (await db.execute(_BOOKED_IN, {
            "provider_id": provider_id, "facility_id": facility_id, "held": HELD_STATUSES,
            "start": start, "end": end})).scalar_one()
        return count

    async def create_schedule(self, db: AsyncSession, body: schemas.ProviderScheduleCreate,
                              role_id: UUID) -> UUID:
        user_id = await _current_user(db)
        by = {"created_by_user_id": user_id, "updated_by_user_id": user_id}
        schedule = M["schedule"](ext_facility_id=body.facility_id, active=True,
                                 comment=body.comment, **by)
        db.add(schedule)
        await db.flush()
        sid: UUID = schedule.id
        rules = [M["schedule_availability_rule"](
            schedule_id=sid, day_of_week=r.day_of_week, start_time=time.fromisoformat(r.start_time),
            end_time=time.fromisoformat(r.end_time), slot_minutes=r.slot_minutes,
            location_id=r.location_id, effective_from=r.start_date, effective_to=r.end_date, **by)
            for r in body.availability_rules]
        db.add(M["schedule_actor"](schedule_id=sid, practitioner_role_id=role_id))
        db.add_all(rules)
        db.add_all(M["schedule_exception"](schedule_id=sid, start_at=e.start_at, end_at=e.end_at,
                                           is_available=e.available, reason=e.reason, **by)
                   for e in body.exceptions)
        await db.flush()
        db.add_all(M["availability_rule_appointment_type"](rule_id=rule.id, appointment_type_id=t)
                   for rule, given in zip(rules, body.availability_rules, strict=True)
                   for t in dict.fromkeys(given.appointment_type_ids))
        await db.flush()
        return sid

    async def get_schedule(self, db: AsyncSession, schedule_id: UUID
                           ) -> schemas.ProviderSchedule | None:
        rows = (await db.execute(_SCHEDULES, {
            "schedule_id": schedule_id, "provider_id": None, "facility_id": None,
            "active": None, **_keyset(None, 1)})).all()
        items = await _schedule_items(db, rows[:1])
        return items[0] if items else None

    async def version(self, db: AsyncSession, table: Versioned, row_id: UUID) -> int:
        """The FHIR row's ``meta_version_id``, its ETag (ADR-0008)."""
        return int((await db.execute(_VERSIONS[table], {"id": row_id})).scalar_one())


_VERSIONS = {
    "practitioner": text("SELECT meta_version_id FROM clinical.practitioner WHERE id = :id"),
    "schedule": text("SELECT meta_version_id FROM clinical.schedule WHERE id = :id"),
}


async def _current_user(db: AsyncSession) -> UUID | None:
    found: UUID | None = (await db.execute(_USER)).scalar_one_or_none()
    return found
