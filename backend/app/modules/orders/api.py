"""Orders and results API (contracts/openapi/modules/orders.yaml; x-owner Thulasi). Built so far:
the doctor's reads of a patient's lab results and imaging reports (the record's Test results and
Imaging reports tabs; listLabResults, listImagingReports), each after core's restricted-chart
check (D37). Their x-audit takes the patient from the path. Orders, the compendium and filing
follow in batch 5."""
from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core.deps import CurrentUser, require, tenant_db

from . import schemas, service
from .repository import ResultsRepository, SqlResultsRepository

router = APIRouter(tags=["orders"])

LAB_RESULTS = "/patients/{patientId}/lab-results"
IMAGING_REPORTS = "/patients/{patientId}/imaging-reports"


def repository() -> ResultsRepository:
    return SqlResultsRepository()


def chart_check() -> service.ChartCheck:
    """Core's restricted-chart check (D37; 404 unknown patient, 403 break-glass-required)."""
    return core_access.ensure_chart_access


DB = Annotated[AsyncSession, Depends(tenant_db)]
Repo = Annotated[ResultsRepository, Depends(repository)]
Check = Annotated[service.ChartCheck, Depends(chart_check)]
PatientId = Annotated[UUID, Path(alias="patientId")]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


@router.get(LAB_RESULTS, operation_id="listLabResults", response_model=schemas.LabResultList,
            response_model_exclude_none=True)
async def list_lab_results(
    user: Annotated[CurrentUser, Depends(require("results:read"))],
    patient_id: PatientId, db: DB, repo: Repo, check: Check,
    limit: Limit = 25, cursor: Cursor = None,
) -> schemas.LabResultList:
    items, next_cursor = await service.lab_results(db, repo, check, user, patient_id,
                                                   limit=limit, cursor=cursor)
    return schemas.LabResultList(items=items, next_cursor=next_cursor)


@router.get(IMAGING_REPORTS, operation_id="listImagingReports",
            response_model=schemas.ImagingReportList, response_model_exclude_none=True)
async def list_imaging_reports(
    user: Annotated[CurrentUser, Depends(require("results:read"))],
    patient_id: PatientId, db: DB, repo: Repo, check: Check,
    limit: Limit = 25, cursor: Cursor = None,
) -> schemas.ImagingReportList:
    items, next_cursor = await service.imaging_reports(db, repo, check, user, patient_id,
                                                       limit=limit, cursor=cursor)
    return schemas.ImagingReportList(items=items, next_cursor=next_cursor)
