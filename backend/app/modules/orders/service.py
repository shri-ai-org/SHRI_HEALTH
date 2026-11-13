"""Rules for the orders module's reads: the restricted-chart check first (D37: 404 for a patient
the clinic can't see, 403 break-glass-required), then one page, newest first."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser

from ..history.service import decode_cursor, encode_cursor
from . import schemas
from .repository import ResultsRepository

ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[Any]]


async def _page[T](db: AsyncSession, check: ChartCheck, user: CurrentUser, patient_id: UUID,
                   read: Callable[..., Awaitable[list[T]]], *, limit: int, cursor: str | None
                   ) -> tuple[list[T], str | None]:
    offset = decode_cursor(cursor)
    await check(db, user, patient_id)
    found = await read(db, patient_id, limit=limit + 1, offset=offset)
    if len(found) > limit:
        return found[:limit], encode_cursor(offset + limit)
    return found, None


async def lab_results(db: AsyncSession, repo: ResultsRepository, check: ChartCheck,
                      user: CurrentUser, patient_id: UUID, *, limit: int, cursor: str | None
                      ) -> tuple[list[schemas.LabResult], str | None]:
    return await _page(db, check, user, patient_id, repo.lab_results, limit=limit, cursor=cursor)


async def imaging_reports(db: AsyncSession, repo: ResultsRepository, check: ChartCheck,
                          user: CurrentUser, patient_id: UUID, *, limit: int, cursor: str | None
                          ) -> tuple[list[schemas.ImagingReport], str | None]:
    return await _page(db, check, user, patient_id, repo.imaging_reports, limit=limit,
                       cursor=cursor)
