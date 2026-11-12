"""Practice setup API (contracts/openapi/modules/practice-setup.yaml): the six list reads, the
note-template reads, the practice settings (read and JSON Merge Patch, A49), one facility's
read and JSON Merge Patch, and creating a provider or a provider schedule (201, with
`Location`).

Each route's operation_id is the contract's operationId, with require() on its x-permission
(`payers:read` for the payer directory, `note-templates:read` for the note templates (D73, A54),
`practice-setup:read` for the rest) and tenant_db, which
also writes the operation's x-audit rows and refuses a `facilityId` that is not one of the
user's facilities (404). The permission is the first dependency, so a caller without it gets
401 or 403 before anything else is resolved, an invalid cursor included.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Path, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, require, tenant_db

from . import schemas, service
from .repository import (
    FacilityRepository,
    ProviderRepository,
    SettingsRepository,
    SetupRepository,
    SqlFacilityRepository,
    SqlProviderRepository,
    SqlSettingsRepository,
    SqlSetupRepository,
)

router = APIRouter(tags=["practice-setup"])


def repository() -> SetupRepository:
    return SqlSetupRepository()


def settings_repository() -> SettingsRepository:
    return SqlSettingsRepository()


def facility_repository() -> FacilityRepository:
    return SqlFacilityRepository()


def provider_repository() -> ProviderRepository:
    return SqlProviderRepository()


Repo = Annotated[SetupRepository, Depends(repository)]
FacilityRepo = Annotated[FacilityRepository, Depends(facility_repository)]
SettingsRepo = Annotated[SettingsRepository, Depends(settings_repository)]
ProviderRepo = Annotated[ProviderRepository, Depends(provider_repository)]
DB = Annotated[AsyncSession, Depends(tenant_db)]
SetupRead = Annotated[CurrentUser, Depends(require("practice-setup:read"))]
SetupUpdate = Annotated[CurrentUser, Depends(require("practice-setup:update"))]
SetupCreate = Annotated[CurrentUser, Depends(require("practice-setup:create"))]
SchedulesCreate = Annotated[CurrentUser, Depends(require("provider-schedules:create"))]
IfMatch = Annotated[str | None, Header(alias="If-Match")]
FacilityPathId = Annotated[UUID, Path(alias="facilityId")]
PayersRead = Annotated[CurrentUser, Depends(require("payers:read"))]
TemplatesRead = Annotated[CurrentUser, Depends(require("note-templates:read"))]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]
Active = Annotated[bool | None, Query()]
FacilityId = Annotated[UUID | None, Query(alias="facilityId")]
ProviderId = Annotated[UUID | None, Query(alias="providerId")]
PayerName = Annotated[str | None, Query(alias="payerName", min_length=2, max_length=200)]
ExternalPayerId = Annotated[str | None, Query(alias="externalPayerId", max_length=40)]
PayerTypeQuery = Annotated[schemas.PayerType | None, Query(alias="payerType")]
OwnerUserId = Annotated[UUID | None, Query(alias="ownerUserId")]
NoteTemplateId = Annotated[UUID, Path(alias="noteTemplateId")]

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


@router.get("/note-templates", operation_id="listNoteTemplates",
            response_model=schemas.NoteTemplateList, response_model_exclude_none=True)
async def list_note_templates(user: TemplatesRead, db: DB, repo: Repo,
                              owner_user_id: OwnerUserId = None, active: Active = None,
                              limit: Limit = DEFAULT_LIMIT, cursor: Cursor = None
                              ) -> schemas.NoteTemplateList:
    return await service.list_note_templates(db, repo, owner_user_id=owner_user_id,
                                             active=active, cursor_value=cursor, limit=limit)


@router.get("/note-templates/{noteTemplateId}", operation_id="getNoteTemplate",
            response_model=schemas.NoteTemplate, response_model_exclude_none=True)
async def get_note_template(user: TemplatesRead, note_template_id: NoteTemplateId,
                            response: Response, db: DB, repo: Repo) -> schemas.NoteTemplate:
    found = await service.get_note_template(db, repo, note_template_id)
    response.headers["ETag"] = service.etag(found.version)
    return found


@router.get("/practice-settings", operation_id="getPracticeSettings",
            response_model=schemas.PracticeSettings)
async def get_practice_settings(user: SetupRead, response: Response, db: DB,
                                repo: SettingsRepo) -> schemas.PracticeSettings:
    found, version = await service.get_settings(db, repo)
    response.headers["ETag"] = service.etag(version)
    return found


@router.patch("/practice-settings", operation_id="updatePracticeSettings",
              response_model=schemas.PracticeSettings)
async def update_practice_settings(user: SetupUpdate, body: schemas.PracticeSettingsPatch,
                                   response: Response, db: DB, repo: SettingsRepo,
                                   if_match: IfMatch = None) -> schemas.PracticeSettings:
    updated, version = await service.update_settings(db, repo, body, if_match)
    await db.commit()
    response.headers["ETag"] = service.etag(version)
    return updated


@router.get("/facilities/{facilityId}", operation_id="getFacility",
            response_model=schemas.Facility, response_model_exclude_none=True)
async def get_facility(user: SetupRead, facility_id: FacilityPathId, response: Response, db: DB,
                       repo: FacilityRepo) -> schemas.Facility:
    found, version = await service.get_facility(db, repo, user, facility_id)
    response.headers["ETag"] = service.etag(version)
    return found


@router.patch("/facilities/{facilityId}", operation_id="updateFacility",
              response_model=schemas.Facility, response_model_exclude_none=True)
async def update_facility(user: SetupUpdate, facility_id: FacilityPathId,
                          body: schemas.FacilityPatch, response: Response, db: DB,
                          repo: FacilityRepo, if_match: IfMatch = None) -> schemas.Facility:
    updated, version = await service.update_facility(db, repo, user, facility_id, body, if_match)
    await db.commit()
    response.headers["ETag"] = service.etag(version)
    return updated


@router.post("/providers", operation_id="createProvider", status_code=status.HTTP_201_CREATED,
             response_model=schemas.Provider, response_model_exclude_none=True)
async def create_provider(user: SetupCreate, body: schemas.ProviderCreate, response: Response,
                          db: DB, repo: ProviderRepo) -> schemas.Provider:
    created, version = await service.create_provider(db, repo, user, body)
    await db.commit()
    response.headers["Location"] = service.location("providers", created.id)
    response.headers["ETag"] = service.etag(version)
    return created


@router.post("/provider-schedules", operation_id="createProviderSchedule",
             status_code=status.HTTP_201_CREATED, response_model=schemas.ProviderSchedule,
             response_model_exclude_none=True)
async def create_provider_schedule(user: SchedulesCreate, body: schemas.ProviderScheduleCreate,
                                   response: Response, db: DB, repo: ProviderRepo
                                   ) -> schemas.ProviderSchedule:
    created, version = await service.create_provider_schedule(db, repo, user, body)
    await db.commit()
    response.headers["Location"] = service.location("provider-schedules", created.id)
    response.headers["ETag"] = service.etag(version)
    return created
