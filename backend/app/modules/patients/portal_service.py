"""Rules for the staff side of the patient portal (B8a, D89; ADR-0013 §3, §4; D84, D85).

The front desk issues an invitation after checking the patient's photo ID in person, and can
revoke it or look at the chart's portal account. Everything that touches a code is core's
(``access.PortalInvitations``): core makes the code, stores only its HMAC and hands the code back
once; this module puts it in the one response and nowhere else (never in a log, an audit reason,
an exception or the database).

As elsewhere in the module, the service owns the transaction: one commit per request, with
core's audit row (category ``security``; the action and reason named here) in the same commit.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict
from app.core.portal_sign_in import INVITATION_HOURS

from . import schemas
from .access import PortalInvitations
from .portal_repository import PortalAccountRepository

#: An account in any of these states is the chart's one account (P1: one account per chart,
#: ADR-0013 §3.5); a new invitation is refused while it exists. `enable` reopens a disabled one
#: (D92), and a suspended one belongs to a chart merged into another, which is 409
#: patient-merged first.
ACCOUNT_STATES = frozenset({"pending-setup", "active", "disabled", "suspended"})

AuditNote = Callable[[str, str], None]  # (action, reason): core's audit_detail


async def issue(db: AsyncSession, repo: PortalAccountRepository,
                invitations: PortalInvitations, note: AuditNote, patient_id: UUID,
                user_id: UUID) -> schemas.PortalInvitation:
    """409 patient-merged for a chart merged into another (D103: the front desk invites the
    surviving chart), 409 invalid-state-transition while the chart has an account; otherwise the
    patient's open invitation is revoked and a new one issued, in one transaction."""
    if await repo.lock_chart(db, patient_id) is not None:
        raise Conflict("The patient was merged into another record", code="patient-merged")
    current = await repo.account_status(db, patient_id)
    if current.status in ACCOUNT_STATES:
        raise Conflict("This patient already has a portal account", currentState=current.status)
    issued = await invitations.issue(db, patient_id, user_id)
    # ADR-0013 §6: the patient (the row's), the invitation and its expiry; never the code.
    note("create", f"Portal invitation {issued.id} issued after an in-person ID check; "
                   f"expires {issued.expires_at.isoformat()}")
    await db.commit()
    return schemas.PortalInvitation(
        id=issued.id, code=issued.code,
        issued_at=issued.expires_at - timedelta(hours=INVITATION_HOURS),  # the insert's now()
        expires_at=issued.expires_at)


async def revoke(db: AsyncSession, repo: PortalAccountRepository,
                 invitations: PortalInvitations, note: AuditNote, patient_id: UUID,
                 invitation_id: UUID, user_id: UUID) -> schemas.PortalAccountStatus:
    """404 for an invitation that isn't this patient's, 409 for a used one; an invitation already
    revoked or expired stays as it is, so repeating the request changes nothing."""
    await invitations.revoke(db, patient_id, invitation_id, user_id)
    note("update", f"Portal invitation {invitation_id} revoked")
    status = await repo.account_status(db, patient_id)
    await db.commit()
    return status
