"""Code search API: searchCodes, ``GET /codes`` (contracts/openapi/modules/encounters.yaml;
x-owner Vimal, built by Anand at Vimal's request on #85, 29 Oct).

The permission is the first dependency, so a caller without ``codes:read`` gets 401 or 403
before anything else, an invalid cursor included. Reference data, not patient data: ``q`` may
be in the query string (API_STANDARDS §16) and the call is not audited (x-audit category
``none``). The rules are in service.py; the search in app.db.terminology.search.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, require, tenant_db

from . import schemas, service

router = APIRouter(tags=["encounters"])

DEFAULT_LIMIT = 20
Limit = Annotated[int, Query(ge=1, le=50)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


@router.get("/codes", operation_id="searchCodes", response_model=schemas.CodeMatchList,
            response_model_exclude_none=True)
async def search_codes(
    user: Annotated[CurrentUser, Depends(require("codes:read"))],
    db: Annotated[AsyncSession, Depends(tenant_db)],
    system: Annotated[schemas.CodeSystem, Query()],
    q: Annotated[str, Query(min_length=2, max_length=100)],
    billable_only: Annotated[bool, Query(alias="billableOnly")] = False,
    limit: Limit = DEFAULT_LIMIT, cursor: Cursor = None,
) -> schemas.CodeMatchList:
    return await service.search_codes(db, system=system, q=q, billable_only=billable_only,
                                      cursor_value=cursor, limit=limit)
