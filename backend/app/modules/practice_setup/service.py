"""Practice-setup reads: turn the request's cursor into a keyset position, ask the repository for
one page, and turn the page's last position back into `nextCursor` (absent on the last page).

Clinic filtering is row-level security's (the session from tenant_db); a `facilityId` that is
not one of the user's facilities is refused by tenant_db (404) before any query runs.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from . import cursor, schemas
from .cursor import Kind, Position
from .repository import Page, SetupRepository


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
