"""Reads for the staff side of the patient portal (B8a, D89; ADR-0013 §3, §4): the chart's portal
account and its active invitation, as the front desk sees them.

Codes, Keycloak and portal sessions are core's (``app.core.portal_sign_in``, through
``access.portal_invitations``); this module only reads ``admin.portal_account`` and
``admin.portal_invitation`` under the request's session, so forced row-level security keeps every
query in the caller's clinic. It never reads ``code_hmac``.
"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound

from . import schemas


class PortalAccountRepository(Protocol):
    async def lock_chart(self, db: AsyncSession, patient_id: UUID) -> UUID | None:
        """Lock the patient's row until the transaction ends, so two invitations for one chart
        (or an invitation and a merge) never interleave; then the patient it was merged into,
        if any (D103). 404 if the clinic has no such patient."""
        ...

    async def account_status(self, db: AsyncSession, patient_id: UUID
                             ) -> schemas.PortalAccountStatus: ...


_LOCK = text("SELECT id FROM clinical.patient WHERE id = :id FOR NO KEY UPDATE")
_MERGED_INTO = text("SELECT other_patient_id FROM clinical.patient_link "
                    "WHERE patient_id = :id AND type = 'replaced-by' LIMIT 1")
_ACCOUNT = text("SELECT status, enrolled_at, factors_reset_at, disabled_at "
                "FROM admin.portal_account WHERE patient_id = :id")
# At most one open invitation per patient (uq_portal_invitation_one_open); an open one past its
# expiry no longer counts as active.
_INVITATION = text("SELECT id, created_at, expires_at FROM admin.portal_invitation "
                   "WHERE patient_id = :id AND used_at IS NULL AND revoked_at IS NULL "
                   "AND expires_at > now() ORDER BY created_at DESC LIMIT 1")


class SqlPortalAccountRepository:
    async def lock_chart(self, db: AsyncSession, patient_id: UUID) -> UUID | None:
        if (await db.execute(_LOCK, {"id": patient_id})).first() is None:
            raise NotFound()
        merged: UUID | None = (await db.execute(_MERGED_INTO, {"id": patient_id})
                               ).scalar_one_or_none()
        return merged

    async def account_status(self, db: AsyncSession, patient_id: UUID
                             ) -> schemas.PortalAccountStatus:
        account = (await db.execute(_ACCOUNT, {"id": patient_id})).one_or_none()
        invitation = (await db.execute(_INVITATION, {"id": patient_id})).one_or_none()
        summary = None
        if invitation is not None:
            summary = schemas.PortalInvitationSummary(
                id=invitation.id, status="active", issued_at=invitation.created_at,
                expires_at=invitation.expires_at)
        if account is None:
            return schemas.PortalAccountStatus(
                patient_id=patient_id, status="invited" if summary else "none",
                invitation=summary)
        return schemas.PortalAccountStatus(
            patient_id=patient_id, status=account.status, invitation=summary,
            enrolled_at=account.enrolled_at, factors_reset_at=account.factors_reset_at,
            disabled_at=account.disabled_at if account.status == "disabled" else None)
