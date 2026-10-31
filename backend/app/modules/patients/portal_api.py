"""Patient portal, staff side (B8a, D89; ADR-0013 §3, §4): the front desk issues and revokes
invitation codes and sees the chart's portal account. x-owner Vimal.

``api.py`` mounts this router only once core has the ``portal-invitations:*`` and
``portal-accounts:read`` permissions (NOTE_FOR_THULASI T45); before that ``require()`` refuses an
unknown permission at import. The operations are already in the operations map. The rules are in
portal_service.py.

Resetting sign-in factors, disabling and enabling an account (#289-291) are x-owner Thulasi and
implemented in core (D92), so they are not here.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, require, tenant_db

from . import portal_service, schemas, service
from .access import (
    AuditHooks,
    ChartCheck,
    PortalInvitations,
    audit_hooks,
    chart_check,
    portal_invitations,
)
from .api import repository as patient_repository
from .portal_repository import PortalAccountRepository, SqlPortalAccountRepository
from .repository import PatientRepository

router = APIRouter(tags=["patients"])

OPERATIONS = frozenset({"getPortalAccount", "createPortalInvitation", "revokePortalInvitation"})
PERMISSIONS = frozenset({"portal-accounts:read", "portal-invitations:create",
                         "portal-invitations:revoke"})
PATIENT = "/patients/{patientId}"


def portal_accounts() -> PortalAccountRepository:
    return SqlPortalAccountRepository()


Repo = Annotated[PortalAccountRepository, Depends(portal_accounts)]
Patients = Annotated[PatientRepository, Depends(patient_repository)]
Invitations = Annotated[PortalInvitations, Depends(portal_invitations)]
Check = Annotated[ChartCheck, Depends(chart_check)]
Audit = Annotated[AuditHooks, Depends(audit_hooks)]
DB = Annotated[AsyncSession, Depends(tenant_db)]
PatientId = Annotated[UUID, Path(alias="patientId")]
InvitationId = Annotated[UUID, Path(alias="invitationId")]


async def _chart(db: AsyncSession, patients: PatientRepository, check: ChartCheck,
                 user: CurrentUser, patient_id: UUID) -> None:
    """404 for a patient the clinic can't see, then 403 break-glass-required for a restricted
    chart without a grant or care-team membership (D37)."""
    await service.readable_patient(db, patients, patient_id)
    await check(db, user, patient_id)


def _note(request: Request, audit: AuditHooks) -> portal_service.AuditNote:
    return lambda action, reason: audit.detail(request, action, reason)


@router.get(f"{PATIENT}/portal-account", operation_id="getPortalAccount",
            response_model=schemas.PortalAccountStatus, response_model_exclude_none=True)
async def get_portal_account(
    user: Annotated[CurrentUser, Depends(require("portal-accounts:read"))],
    patient_id: PatientId, db: DB, repo: Repo, patients: Patients, check: Check,
) -> schemas.PortalAccountStatus:
    await _chart(db, patients, check, user, patient_id)
    return await repo.account_status(db, patient_id)


@router.post(f"{PATIENT}/portal-invitations", operation_id="createPortalInvitation",
             status_code=status.HTTP_201_CREATED, response_model=schemas.PortalInvitation,
             response_model_exclude_none=True)
async def create_portal_invitation(
    user: Annotated[CurrentUser, Depends(require("portal-invitations:create"))],
    patient_id: PatientId, body: schemas.PortalInvitationCreate, request: Request,
    response: Response, db: DB, repo: Repo, patients: Patients, check: Check,
    invitations: Invitations, audit: Audit,
) -> schemas.PortalInvitation:
    await _chart(db, patients, check, user, patient_id)
    issued = await portal_service.issue(db, repo, invitations, _note(request, audit), patient_id,
                                        user.id)
    response.headers["Location"] = f"/api/v1/patients/{patient_id}/portal-account"
    return issued


@router.post(f"{PATIENT}/portal-invitations/{{invitationId}}/revoke",
             operation_id="revokePortalInvitation", response_model=schemas.PortalAccountStatus,
             response_model_exclude_none=True)
async def revoke_portal_invitation(
    user: Annotated[CurrentUser, Depends(require("portal-invitations:revoke"))],
    patient_id: PatientId, invitation_id: InvitationId, request: Request, db: DB, repo: Repo,
    patients: Patients, check: Check, invitations: Invitations, audit: Audit,
) -> schemas.PortalAccountStatus:
    await _chart(db, patients, check, user, patient_id)
    return await portal_service.revoke(db, repo, invitations, _note(request, audit), patient_id,
                                       invitation_id, user.id)
