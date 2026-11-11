"""Practice-setup reads: turn the request's cursor into a keyset position, ask the repository for
one page, and turn the page's last position back into `nextCursor` (absent on the last page).

Clinic filtering is row-level security's (the session from tenant_db); a `facilityId` that is
not one of the user's facilities is refused by tenant_db (404) before any query runs. A note
template the session cannot see (unknown, or another clinic's) is 404 `not-found`.
"""

from __future__ import annotations

from datetime import date, time
from uuid import UUID
from zoneinfo import available_timezones

from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.access import require_facility
from app.core.deps import CurrentUser
from app.core.errors import (
    InternalError,
    NotFound,
    PreconditionFailed,
    PreconditionRequired,
    ValidationFailed,
    field_error,
)

from . import cursor, schemas
from .cursor import Kind, Position
from .repository import (
    ExistingRule,
    FacilityRepository,
    NewProvider,
    Page,
    ProviderRepository,
    SettingsRepository,
    SettingsRow,
    SetupRepository,
)


def _after(value: str | None, kind: Kind) -> Position | None:
    return cursor.decode(value, kind) if value is not None else None


def _next[T](page: Page[T]) -> str | None:
    return cursor.encode(page.next) if page.next is not None else None


async def list_facilities(db: AsyncSession, repo: SetupRepository, *, active: bool | None,
                          cursor_value: str | None, limit: int) -> schemas.FacilityList:
    page = await repo.list_facilities(db, active=active, limit=limit,
                                      after=_after(cursor_value, "facilities"))
    return schemas.FacilityList(items=page.items, next_cursor=_next(page))


async def list_providers(db: AsyncSession, repo: SetupRepository, *, facility_id: UUID | None,
                         active: bool | None, cursor_value: str | None, limit: int
                         ) -> schemas.ProviderList:
    page = await repo.list_providers(db, facility_id=facility_id, active=active, limit=limit,
                                     after=_after(cursor_value, "providers"))
    return schemas.ProviderList(items=page.items, next_cursor=_next(page))


async def list_appointment_types(db: AsyncSession, repo: SetupRepository, *,
                                 active: bool | None, cursor_value: str | None, limit: int
                                 ) -> schemas.AppointmentTypeList:
    page = await repo.list_appointment_types(db, active=active, limit=limit,
                                             after=_after(cursor_value, "appointment-types"))
    return schemas.AppointmentTypeList(items=page.items, next_cursor=_next(page))


async def list_provider_schedules(db: AsyncSession, repo: SetupRepository, *,
                                  provider_id: UUID | None, facility_id: UUID | None,
                                  active: bool | None, cursor_value: str | None, limit: int
                                  ) -> schemas.ProviderScheduleList:
    page = await repo.list_provider_schedules(
        db, provider_id=provider_id, facility_id=facility_id, active=active, limit=limit,
        after=_after(cursor_value, "provider-schedules"))
    return schemas.ProviderScheduleList(items=page.items, next_cursor=_next(page))


async def list_payers(db: AsyncSession, repo: SetupRepository, *, payer_name: str | None,
                      external_payer_id: str | None, payer_type: str | None,
                      active: bool | None, cursor_value: str | None, limit: int
                      ) -> schemas.PayerList:
    page = await repo.list_payers(db, payer_name=payer_name, external_payer_id=external_payer_id,
                                  payer_type=payer_type, active=active, limit=limit,
                                  after=_after(cursor_value, "payers"))
    return schemas.PayerList(items=page.items, next_cursor=_next(page))


async def list_practice_payers(db: AsyncSession, repo: SetupRepository, *, active: bool | None,
                               cursor_value: str | None, limit: int
                               ) -> schemas.PracticePayerList:
    page = await repo.list_practice_payers(db, active=active, limit=limit,
                                           after=_after(cursor_value, "practice-payers"))
    return schemas.PracticePayerList(items=page.items, next_cursor=_next(page))


async def list_note_templates(db: AsyncSession, repo: SetupRepository, *,
                              owner_user_id: UUID | None, active: bool | None,
                              cursor_value: str | None, limit: int) -> schemas.NoteTemplateList:
    page = await repo.list_note_templates(db, owner_user_id=owner_user_id, active=active,
                                          limit=limit,
                                          after=_after(cursor_value, "note-templates"))
    return schemas.NoteTemplateList(items=page.items, next_cursor=_next(page))


async def get_note_template(db: AsyncSession, repo: SetupRepository, note_template_id: UUID
                            ) -> schemas.NoteTemplate:
    found = await repo.get_note_template(db, note_template_id)
    if found is None:
        raise NotFound("Note template not found")
    return found


def etag(version: int) -> str:
    """A strong ETag from the row's A41 version (API_STANDARDS §11)."""
    return f'"{version}"'


# ------------------------------------------------------------------------- practice settings
def if_match_version(header: str | None) -> int:
    """The version a strong ETag names; 428 without one, 412 for a weak or malformed one."""
    if header is None:
        raise PreconditionRequired()
    value = header.strip()
    if value.startswith('"') and value.endswith('"') and value[1:-1].isdigit():
        return int(value[1:-1])
    raise PreconditionFailed()


def _settings(row: SettingsRow) -> schemas.PracticeSettings:
    return schemas.PracticeSettings(
        registration=schemas.PracticeRegistrationSettings(
            show_sexual_orientation_and_gender_identity=row.show_sogi),
        mrn_prefix=row.mrn_prefix, mrn_system=row.mrn_system, updated_at=row.updated_at)


async def _current(db: AsyncSession, repo: SettingsRepository) -> SettingsRow:
    row = await repo.get_settings(db)
    if row is None:  # onboarding creates the MRN counter with the practice (D41)
        raise InternalError("The practice has no MRN counter")
    return row


async def get_settings(db: AsyncSession, repo: SettingsRepository
                       ) -> tuple[schemas.PracticeSettings, int]:
    row = await _current(db, repo)
    return _settings(row), row.version


async def update_settings(db: AsyncSession, repo: SettingsRepository,
                          body: schemas.PracticeSettingsPatch, if_match: str | None
                          ) -> tuple[schemas.PracticeSettings, int]:
    """JSON Merge Patch: every level needs at least one member, and no member may be null."""
    registration = body.registration
    if registration is None or not registration.model_fields_set:
        pointer = "/registration" if "registration" in body.model_fields_set else ""
        raise ValidationFailed(errors=[field_error("body", pointer, "required")])
    show = registration.show_sexual_orientation_and_gender_identity
    if show is None:
        raise ValidationFailed(errors=[field_error(
            "body", "/registration/showSexualOrientationAndGenderIdentity", "invalid-type")])
    expected = if_match_version(if_match)
    row = await _current(db, repo)
    if row.version != expected:
        raise PreconditionFailed(headers={"ETag": etag(row.version)})
    if row.show_sogi != show:
        version = await repo.set_show_sogi(db, show, if_version=expected)
        if version is None:  # another request changed it since the read
            raise PreconditionFailed(headers={"ETag": etag((await _current(db, repo)).version)})
    row = await _current(db, repo)
    return _settings(row), row.version


# ------------------------------------------------------------------------- one facility
#: A database refusal of a patched value, by constraint, and the field it names.
_REFUSED = {"npi_valid": "/npi", "clia_format": "/cliaNumber", "pos_format": "/placeOfServiceCode"}


async def get_facility(db: AsyncSession, repo: FacilityRepository, user: CurrentUser,
                       facility_id: UUID) -> tuple[schemas.Facility, int]:
    """One of the user's facilities, or 404 (another clinic's is invisible under RLS)."""
    require_facility(user, facility_id)
    found = await repo.get_facility(db, facility_id)
    if found is None:
        raise NotFound("Facility not found")
    return found


async def update_facility(db: AsyncSession, repo: FacilityRepository, user: CurrentUser,
                          facility_id: UUID, body: schemas.FacilityPatch, if_match: str | None
                          ) -> tuple[schemas.Facility, int]:
    """JSON Merge Patch: at least one field, none of them null (no field is nullable)."""
    if not body.model_fields_set:
        raise ValidationFailed(errors=[field_error("body", "", "required")])
    nulls = sorted(f for f in body.model_fields_set if getattr(body, f) is None)
    if nulls:
        fields = schemas.FacilityPatch.model_fields
        raise ValidationFailed(errors=[field_error("body", f"/{fields[f].alias}", "invalid-type")
                                       for f in nulls])
    if body.time_zone is not None and body.time_zone not in available_timezones():
        raise ValidationFailed(errors=[field_error("body", "/timeZone", "invalid-format")])
    expected = if_match_version(if_match)
    _, version = await get_facility(db, repo, user, facility_id)
    if version != expected:
        raise PreconditionFailed(headers={"ETag": etag(version)})
    try:
        updated = await repo.update_facility(db, facility_id, body, if_version=expected)
    except DBAPIError as refused:
        constraint = getattr(getattr(refused.orig, "__cause__", None), "constraint_name", "") or ""
        pointer = next((p for name, p in _REFUSED.items() if constraint.endswith(name)), None)
        if pointer is None:
            raise
        raise ValidationFailed(errors=[field_error("body", pointer, "invalid-format")]
                               ) from None
    if updated is None:  # changed by another request since the read
        _, now = await get_facility(db, repo, user, facility_id)
        raise PreconditionFailed(headers={"ETag": etag(now)})
    return await get_facility(db, repo, user, facility_id)


# ------------------------------------------------------------------------- provider writes
def _rule(errors: list[dict[str, str]]) -> ValidationFailed:
    detail = "1 rule is not met." if len(errors) == 1 else f"{len(errors)} rules are not met."
    return ValidationFailed(detail, code="business-rule-violation", errors=errors)


def location(kind: str, item_id: UUID) -> str:
    return f"/api/v1/{kind}/{item_id}"


async def create_provider(db: AsyncSession, repo: ProviderRepository, user: CurrentUser,
                          body: schemas.ProviderCreate) -> tuple[schemas.Provider, int]:
    """A provider with a role at each facility. Every facility must be one of the user's
    (`invalid-reference`); the NPI must pass its check digit and be unused in the practice,
    which is checked under a lock on the NPI, so two requests with one NPI can't both pass."""
    facilities = list(dict.fromkeys(body.facility_ids))
    errors = [field_error("body", f"/facilityIds/{i}", "invalid-reference")
              for i, f in enumerate(body.facility_ids) if f not in user.facility_ids]
    errors += [field_error("body", f"/qualifications/{i}/endDate", "out-of-range")
               for i, q in enumerate(body.qualifications)
               if q.start_date and q.end_date and q.end_date < q.start_date]
    if not await repo.npi_valid(db, body.npi):
        errors.append(field_error("body", "/npi", "invalid-format"))
    if errors:
        raise _rule(errors)
    sites = await repo.facility_locations(db, facilities)
    if len(sites) != len(facilities):  # one of the user's facilities isn't this clinic's
        raise _rule([field_error("body", f"/facilityIds/{i}", "invalid-reference")
                     for i, f in enumerate(body.facility_ids) if f not in sites])
    await repo.lock(db, f"provider-npi:{body.npi}")
    if await repo.npi_taken(db, body.npi):
        raise _rule([field_error("body", "/npi", "not-allowed-value")])
    provider_id = await repo.create_provider(db, NewProvider(body, sites))
    created = await repo.get_provider(db, provider_id)
    if created is None:  # just written in this transaction
        raise InternalError("The new provider is not readable")
    return created, await repo.version(db, "practitioner", provider_id)


def _overlaps(a: schemas.AvailabilityRuleIn | ExistingRule,
              b: schemas.AvailabilityRuleIn | ExistingRule) -> bool:
    """Same day, overlapping times and overlapping dates (an open end runs on)."""
    def span(r: schemas.AvailabilityRuleIn | ExistingRule
             ) -> tuple[str, time, time, date, date]:
        if isinstance(r, ExistingRule):
            return (r.day_of_week, r.start_time, r.end_time, r.effective_from,
                    r.effective_to or date.max)
        return (r.day_of_week, time.fromisoformat(r.start_time), time.fromisoformat(r.end_time),
                r.start_date, r.end_date or date.max)
    day_a, start_a, end_a, from_a, to_a = span(a)
    day_b, start_b, end_b, from_b, to_b = span(b)
    return (day_a == day_b and start_a < end_b and start_b < end_a
            and from_a <= to_b and from_b <= to_a)


async def create_provider_schedule(db: AsyncSession, repo: ProviderRepository,
                                   user: CurrentUser, body: schemas.ProviderScheduleCreate
                                   ) -> tuple[schemas.ProviderSchedule, int]:
    """A schedule for a provider at one of the user's facilities, where the provider has an
    active role. No two of the provider's active rules at the facility may overlap (this
    schedule's or another's), checked under a lock on the provider and facility, so two
    requests can't both add overlapping rules."""
    rules = body.availability_rules
    errors = []
    if body.facility_id not in user.facility_ids:
        errors.append(field_error("body", "/facilityId", "invalid-reference"))
    for i, r in enumerate(rules):
        if r.end_time <= r.start_time:  # HH:MM compares as text
            errors.append(field_error("body", f"/availabilityRules/{i}/endTime", "out-of-range"))
        if r.end_date is not None and r.end_date < r.start_date:
            errors.append(field_error("body", f"/availabilityRules/{i}/endDate", "out-of-range"))
    errors += [field_error("body", f"/exceptions/{i}/endAt", "out-of-range")
               for i, e in enumerate(body.exceptions) if e.end_at <= e.start_at]
    if errors:
        raise _rule(errors)
    await repo.lock(db, f"provider-schedule:{body.provider_id}:{body.facility_id}")
    role_id = await repo.role_at(db, body.provider_id, body.facility_id)
    if role_id is None:  # unknown, or not working at the facility
        errors.append(field_error("body", "/providerId", "invalid-reference"))
    no_location = await repo.missing_locations(
        db, {r.location_id for r in rules if r.location_id is not None})
    no_type = await repo.missing_appointment_types(
        db, {t for r in rules for t in r.appointment_type_ids})
    for i, r in enumerate(rules):
        if r.location_id in no_location:
            errors.append(field_error("body", f"/availabilityRules/{i}/locationId",
                                      "invalid-reference"))
        errors += [field_error("body", f"/availabilityRules/{i}/appointmentTypeIds/{j}",
                               "invalid-reference")
                   for j, t in enumerate(r.appointment_type_ids) if t in no_type]
    existing: list[schemas.AvailabilityRuleIn | ExistingRule] = [
        *await repo.rules_at(db, body.provider_id, body.facility_id)]
    errors += [field_error("body", f"/availabilityRules/{i}", "conflicting-fields")
               for i, r in enumerate(rules)
               if any(_overlaps(r, other) for other in [*rules[:i], *rules[i + 1:], *existing])]
    if errors or role_id is None:  # a missing role is always among the errors
        raise _rule(errors)
    schedule_id = await repo.create_schedule(db, body, role_id)
    created = await repo.get_schedule(db, schedule_id)
    if created is None:
        raise InternalError("The new schedule is not readable")
    return created, await repo.version(db, "schedule", schedule_id)
