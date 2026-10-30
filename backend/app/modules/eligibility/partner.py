"""The two core pieces a manual check uses, behind one interface so the API tests (no database)
can replace them:

- core's ``create_operation(db, "eligibility.check", assigned_to_integration=True)``: the ``202``'s
  operation, which the partner side finishes when the 271 is filed (service.record_response);
- core's outbox ``enqueue(db, "clearinghouse", "270", {...})`` (T29, D25): IDs only, keyed by the
  check, so a retry of the same check never sends twice.

Both write in the caller's transaction and never commit.
"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.long_running import Operation, create_operation
from app.integration.api import enqueue

PARTNER = "clearinghouse"
MESSAGE_TYPE = "270"
OPERATION_KIND = "eligibility.check"


class Partner(Protocol):
    async def start(self, db: AsyncSession) -> Operation:
        """A queued ``eligibility.check`` operation for the session's user (no commit)."""
        ...

    async def send_270(self, db: AsyncSession, check_id: UUID, operation_id: UUID) -> UUID:
        """Queues the 270 for the check; returns the outbox message's ID (no commit)."""
        ...


def outbox_payload(check_id: UUID, operation_id: UUID) -> dict[str, str]:
    """What the outbox row holds: IDs only. The adapter builds the 270 from the check at send
    time (service.build_request) and hands ``operationId`` back to record_response."""
    return {"eligibilityCheckId": str(check_id), "operationId": str(operation_id)}


class CorePartner:
    async def start(self, db: AsyncSession) -> Operation:
        return await create_operation(db, OPERATION_KIND, assigned_to_integration=True)

    async def send_270(self, db: AsyncSession, check_id: UUID, operation_id: UUID) -> UUID:
        return await enqueue(db, PARTNER, MESSAGE_TYPE, outbox_payload(check_id, operation_id),
                             idempotency_key=f"270:{check_id}")


def partner() -> Partner:
    """FastAPI dependency: core's operations and outbox."""
    return CorePartner()
