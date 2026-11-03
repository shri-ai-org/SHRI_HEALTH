"""Eligibility API (batch 1, contracts/openapi/modules/eligibility.yaml; IMPL_BATCH1_PLAN §2.3,
PR-6a). Each route's operation_id is the contract's operationId, and the permission (`require`)
is the first dependency, so a caller without it gets 401 or 403 before anything else runs.

- ``runEligibilityCheck``: ``202`` with an ``eligibility.check`` operation. Core's tenant_db
  claims the required Idempotency-Key and replays a finished one; the check, the operation and
  the 270 in the outbox commit together (service.queue_check).
- ``getEligibilityCheck`` and ``listAppointmentEligibilityChecks``: reads.

Every route runs the restricted-chart check (D37) before it shows anything, and names the patient
for core's audit (x-audit patient ``result``). The repository, the chart check, the audit hook and
the partner (operations and outbox) are dependencies the tests replace.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core import audit as core_audit
from app.core.deps import CurrentUser, require, tenant_db
from app.core.long_running import accepted

from . import schemas, service
from .partner import Partner, partner
from .repository import EligibilityRepository, SqlEligibilityRepository

router = APIRouter(tags=["eligibility"])

AuditPatients = Callable[[Request, Iterable[UUID]], None]


def repository() -> EligibilityRepository:
    return SqlEligibilityRepository()


def chart_check() -> service.ChartCheck:
    """FastAPI dependency: core's restricted-chart check (404, or 403 break-glass-required)."""
    return core_access.ensure_chart_access


def audit_hook() -> AuditPatients:
    """FastAPI dependency: core's audit hook naming the patients (x-audit patient "result")."""
    return core_audit.audit_patients


DB = Annotated[AsyncSession, Depends(tenant_db)]
Repo = Annotated[EligibilityRepository, Depends(repository)]
Check = Annotated[service.ChartCheck, Depends(chart_check)]
Audit = Annotated[AuditPatients, Depends(audit_hook)]
Outbox = Annotated[Partner, Depends(partner)]
CheckId = Annotated[UUID, Path(alias="eligibilityCheckId")]
AppointmentId = Annotated[UUID, Path(alias="appointmentId")]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


@router.post("/eligibility-checks", operation_id="runEligibilityCheck",
             status_code=status.HTTP_202_ACCEPTED, response_class=JSONResponse)
async def run_eligibility_check(
    user: Annotated[CurrentUser, Depends(require("eligibility-checks:create"))],
    body: schemas.EligibilityCheckCreate, request: Request, db: DB, repo: Repo, check: Check,
    audit: Audit, outbox: Outbox,
) -> JSONResponse:
    queued = await service.queue_check(db, repo, outbox, check, user, body,
                                       today=datetime.now(UTC).date())
    audit(request, [queued.patient_id])  # x-audit patient "result"
    await db.commit()
    return accepted(queued.operation)  # 202, Location and Retry-After, as core answers


@router.get("/eligibility-checks/{eligibilityCheckId}", operation_id="getEligibilityCheck",
            response_model=schemas.EligibilityCheck, response_model_exclude_none=True)
async def get_eligibility_check(
    user: Annotated[CurrentUser, Depends(require("eligibility-checks:read"))],
    check_id: CheckId, request: Request, response: Response, db: DB, repo: Repo, check: Check,
    audit: Audit,
) -> schemas.EligibilityCheck:
    row = await service.readable_check(db, repo, check, user, check_id)
    audit(request, [row.patient_id])
    response.headers["ETag"] = service.etag(row)
    return service.to_contract(row)


@router.get("/appointments/{appointmentId}/eligibility-checks",
            operation_id="listAppointmentEligibilityChecks",
            response_model=schemas.EligibilityCheckList, response_model_exclude_none=True)
async def list_appointment_eligibility_checks(
    user: Annotated[CurrentUser, Depends(require("eligibility-checks:read"))],
    appointment_id: AppointmentId, request: Request, db: DB, repo: Repo, check: Check,
    audit: Audit, limit: Limit = 25, cursor: Cursor = None,
) -> schemas.EligibilityCheckList:
    found, patient_id = await service.appointment_checks(db, repo, check, user, appointment_id,
                                                         limit=limit, cursor=cursor)
    audit(request, [patient_id] if found.items else [])
    return found
