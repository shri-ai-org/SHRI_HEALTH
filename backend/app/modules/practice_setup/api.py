"""Practice setup API (contracts/openapi/modules/practice-setup.yaml): the six list reads.

Each route's operation_id is the contract's operationId, with require() on its x-permission
(`payers:read` for the payer directory, `practice-setup:read` for the rest) and tenant_db, which
also writes the operation's x-audit rows and refuses a `facilityId` that is not one of the
user's facilities (404). The permission is the first dependency, so a caller without it gets
401 or 403 before anything else is resolved, an invalid cursor included.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, require, tenant_db

from . import schemas, service
from .repository import SetupRepository, SqlSetupRepository

router = APIRouter(tags=["practice-setup"])


def repository() -> SetupRepository:
    return SqlSetupRepository()


Repo = Annotated[SetupRepository, Depends(repository)]
DB = Annotated[AsyncSession, Depends(tenant_db)]
SetupRead = Annotated[CurrentUser, Depends(require("practice-setup:read"))]
PayersRead = Annotated[CurrentUser, Depends(require("payers:read"))]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]
Active = Annotated[bool | None, Query()]
FacilityId = Annotated[UUID | None, Query(alias="facilityId")]
ProviderId = Annotated[UUID | None, Query(alias="providerId")]
PayerName = Annotated[str | None, Query(alias="payerName", min_length=2, max_length=200)]
ExternalPayerId = Annotated[str | None, Query(alias="externalPayerId", max_length=40)]
PayerTypeQuery = Annotated[schemas.PayerType | None, Query(alias="payerType")]

DEFAULT_LIMIT = 25  # API_STANDARDS §8.1


@router.get("/facilities", operation_id="listFacilitys", response_model=schemas.FacilityList,
            response_model_exclude_none=True)
async def list_facilities(user: SetupRead, db: DB, repo: Repo, active: Active = None,
                          limit: Limit = DEFAULT_LIMIT, cursor: Cursor = None
                          ) -> schemas.FacilityList:
    return await service.list_facilities(db, repo, active=active, cursor_value=cursor,
                                         limit=limit)


@router.get("/providers", operation_id="listProviders", response_model=schemas.ProviderList,
            response_model_exclude_none=True)
async def list_providers(user: SetupRead, db: DB, repo: Repo, facility_id: FacilityId = None,
                         active: Active = None, limit: Limit = DEFAULT_LIMIT,
                         cursor: Cursor = None) -> schemas.ProviderList:
    return await service.list_providers(db, repo, facility_id=facility_id, active=active,
                                        cursor_value=cursor, limit=limit)


@router.get("/appointment-types", operation_id="listAppointmentTypes",
            response_model=schemas.AppointmentTypeList, response_model_exclude_none=True)
async def list_appointment_types(user: SetupRead, db: DB, repo: Repo, active: Active = None,
                                 limit: Limit = DEFAULT_LIMIT, cursor: Cursor = None
                                 ) -> schemas.AppointmentTypeList:
    return await service.list_appointment_types(db, repo, active=active, cursor_value=cursor,
                                                limit=limit)


@router.get("/provider-schedules", operation_id="listProviderSchedules",
            response_model=schemas.ProviderScheduleList, response_model_exclude_none=True)
async def list_provider_schedules(user: SetupRead, db: DB, repo: Repo,
                                  provider_id: ProviderId = None, facility_id: FacilityId = None,
                                  active: Active = None, limit: Limit = DEFAULT_LIMIT,
                                  cursor: Cursor = None) -> schemas.ProviderScheduleList:
    return await service.list_provider_schedules(
        db, repo, provider_id=provider_id, facility_id=facility_id, active=active,
        cursor_value=cursor, limit=limit)


@router.get("/payers", operation_id="listPayers", response_model=schemas.PayerList,
            response_model_exclude_none=True)
async def list_payers(user: PayersRead, db: DB, repo: Repo, payer_name: PayerName = None,
                      external_payer_id: ExternalPayerId = None,
                      payer_type: PayerTypeQuery = None, active: Active = None,
                      limit: Limit = DEFAULT_LIMIT, cursor: Cursor = None) -> schemas.PayerList:
    return await service.list_payers(db, repo, payer_name=payer_name,
                                     external_payer_id=external_payer_id, payer_type=payer_type,
                                     active=active, cursor_value=cursor, limit=limit)


@router.get("/practice-payers", operation_id="listPracticePayers",
            response_model=schemas.PracticePayerList, response_model_exclude_none=True)
async def list_practice_payers(user: SetupRead, db: DB, repo: Repo, active: Active = None,
                               limit: Limit = DEFAULT_LIMIT, cursor: Cursor = None
                               ) -> schemas.PracticePayerList:
    return await service.list_practice_payers(db, repo, active=active, cursor_value=cursor,
                                              limit=limit)
