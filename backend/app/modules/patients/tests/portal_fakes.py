"""In-memory stand-ins for the portal tables and core's invitation functions (portal_sign_in,
#148), for test_portal_invitations_api.py. They follow the real pieces where the API depends on
it: one open invitation per patient (a new one revokes the old one), core's 409 for a chart with
a live account, revoke's 404 and 409, and an invitation that is active only until it expires.
Codes come from core's own generator; only their HMAC-like digest is "stored". Synthetic data
only.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from app.core.errors import Conflict, NotFound
from app.core.portal_sign_in import INVITATION_HOURS, IssuedInvitation, new_code, normalize_code

from .. import schemas
from ..access import PortalInvitations
from .fakes import World


@dataclass
class Invitation:
    patient_id: UUID
    digest: str  # never the code
    issued_by: UUID
    issued_at: datetime
    expires_at: datetime
    used_at: datetime | None = None
    revoked_at: datetime | None = None

    @property
    def open(self) -> bool:
        return self.used_at is None and self.revoked_at is None


@dataclass
class Account:
    status: str
    enrolled_at: datetime | None = None
    factors_reset_at: datetime | None = None
    disabled_at: datetime | None = None


@dataclass
class PortalWorld:
    """The portal rows, per clinic, beside the patients' World."""

    world: World
    accounts: dict[UUID, dict[UUID, Account]] = field(default_factory=dict)  # clinic → patient
    invitations: dict[UUID, dict[UUID, Invitation]] = field(default_factory=dict)
    merged_into: dict[UUID, UUID] = field(default_factory=dict)  # merged → surviving patient
    issued_codes: list[str] = field(default_factory=list)  # what core handed back, for the tests

    def accounts_of(self, db: Any) -> dict[UUID, Account]:
        return self.accounts.setdefault(db.tenant_id, {})

    def invitations_of(self, db: Any) -> dict[UUID, Invitation]:
        return self.invitations.setdefault(db.tenant_id, {})


class FakePortalAccounts:
    def __init__(self, portal: PortalWorld) -> None:
        self.portal = portal

    async def lock_chart(self, db: Any, patient_id: UUID) -> UUID | None:
        if patient_id not in self.portal.world.clinic(db):
            raise NotFound()
        return self.portal.merged_into.get(patient_id)

    async def account_status(self, db: Any, patient_id: UUID) -> schemas.PortalAccountStatus:
        now = datetime.now(UTC)
        active = [(i, inv) for i, inv in self.portal.invitations_of(db).items()
                  if inv.patient_id == patient_id and inv.open and inv.expires_at > now]
        summary = None
        if active:
            invitation_id, inv = active[-1]
            summary = schemas.PortalInvitationSummary(
                id=invitation_id, status="active", issued_at=inv.issued_at,
                expires_at=inv.expires_at)
        account = self.portal.accounts_of(db).get(patient_id)
        if account is None:
            return schemas.PortalAccountStatus(
                patient_id=patient_id, status="invited" if summary else "none",
                invitation=summary)
        return schemas.PortalAccountStatus(
            patient_id=patient_id, status=account.status,
            invitation=summary, enrolled_at=account.enrolled_at,
            factors_reset_at=account.factors_reset_at,
            disabled_at=account.disabled_at if account.status == "disabled" else None)


def fake_invitations(portal: PortalWorld) -> PortalInvitations:
    """Core's issue_invitation and revoke_invitation, on PortalWorld."""

    async def issue(db: Any, patient_id: UUID, user_id: UUID) -> IssuedInvitation:
        account = portal.accounts_of(db).get(patient_id)
        if account is not None and account.status in ("pending-setup", "active"):
            raise Conflict("This patient already has a portal account",
                           currentState=account.status)
        now = datetime.now(UTC)
        for inv in portal.invitations_of(db).values():
            if inv.patient_id == patient_id and inv.open:
                inv.revoked_at = now
        code = new_code()
        digest = hashlib.sha256((normalize_code(code) or "").encode()).hexdigest()
        invitation_id = uuid4()
        expires = now + timedelta(hours=INVITATION_HOURS)
        portal.invitations_of(db)[invitation_id] = Invitation(
            patient_id, digest, user_id, now, expires)
        portal.issued_codes.append(code)
        return IssuedInvitation(invitation_id, code, expires)

    async def revoke(db: Any, patient_id: UUID, invitation_id: UUID, user_id: UUID) -> None:
        inv = portal.invitations_of(db).get(invitation_id)
        if inv is None or inv.patient_id != patient_id:
            raise NotFound()
        if inv.used_at is not None:
            raise Conflict("This invitation was already used", currentState="used")
        if inv.revoked_at is None:
            inv.revoked_at = datetime.now(UTC)

    return PortalInvitations(issue=issue, revoke=revoke)
