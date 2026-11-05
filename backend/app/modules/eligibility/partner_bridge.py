"""Eligibility's side of the clearinghouse connection, registered with core's partner registries
(app/integration/outbound.py and inbound.py, Thulasi's #186):

- **270 builder** (``@builds("clearinghouse", "270")``, the worker, as ``shri_integration``): the
  outbox row holds IDs only (partner.outbox_payload); the 270 is built from the check at send
  time (service.build_request). A check that can never be sent (``RequestNotBuildable``, or a
  payload without a check) is a permanent ``DeliveryError`` with its short code, so it is
  dead-lettered at once instead of retried.
- **270 dead-letter** (``@on_dead_letter``): the pending check times out and its operation, if
  any, fails with ``upstream-timeout`` (service.mark_timed_out). A 270 that was sent needs
  nothing: the check stays pending until the 271.
- **271 handler** (``@handles("clearinghouse", "271")``, the API's ``/hooks/clearinghouse``, as
  ``shri_app`` in the clinic's system session): core has already matched the reply to our 270
  (its ``correlationId`` is one of the outbox payload's IDs, in the same clinic) and passes that
  payload as ``request``; the operation ID comes from it. The reply must name the check itself,
  not another ID in the payload. Core turns ``NotFound`` into ``unknown-correlation`` and
  ``ValidationFailed`` into ``invalid-message``. The result names the patient for core's audit.

Nothing here logs or keeps a message: codes and IDs only.

**Registration is import-guarded** until #186 is merged: ``REGISTERED`` is False where core's
registries don't exist yet, and the functions stay plain, testable coroutines. ``api.py`` imports
this module, so the API and the worker (``outbound.load_modules``) both register. Once #186 is
on main, the importlib lookup becomes a plain import.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.integration.worker import DeliveryError

from . import repository, service
from .partner import MESSAGE_TYPE, PARTNER

REPLY_TYPE = "271"
INVALID_PAYLOAD = "invalid-payload"


@dataclass(frozen=True)
class Answered:
    """What filing a 271 did; ``patient_id`` goes on core's audit row."""

    check_id: UUID
    status: str
    duplicate: bool
    patient_id: UUID | None


def ids(payload: dict[str, Any]) -> tuple[UUID, UUID | None]:
    """(check, operation) from the outbox payload (partner.outbox_payload). Raises ValueError
    when the payload names no check."""
    try:
        check_id = UUID(str(payload["eligibilityCheckId"]))
        operation = payload.get("operationId")
        return check_id, UUID(str(operation)) if operation else None
    except (KeyError, TypeError, ValueError):
        raise ValueError(INVALID_PAYLOAD) from None


async def build_270(db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
    """The 270 for the outbox row's check, in the worker's clinic session."""
    try:
        check_id, _ = ids(payload)
    except ValueError:
        raise DeliveryError(INVALID_PAYLOAD, permanent=True) from None
    try:
        request = await service.build_request(db, check_id, now=datetime.now(UTC))
    except service.RequestNotBuildable as refused:
        raise DeliveryError(refused.code, permanent=True) from None
    return request.as_json()


async def dead_letter_270(db: AsyncSession, payload: dict[str, Any], error_code: str) -> bool:
    """The 270 was given up on: the check times out and its operation fails. The code is the
    worker's and is not kept on the check (the check's message is fixed). False when the check
    was no longer pending, or the payload names none."""
    try:
        check_id, operation_id = ids(payload)
    except ValueError:
        return False
    return await service.mark_timed_out(db, check_id, operation_id=operation_id)


async def file_271(db: AsyncSession, message: dict[str, Any],
                   request: dict[str, Any]) -> Answered:
    """Files the payer's 271 on the check our 270 named (``request``, core's match)."""
    try:
        check_id, operation_id = ids(request)
    except ValueError:
        raise NotFound() from None
    if str(message.get("correlationId", "")).lower() != str(check_id):
        raise NotFound()  # it matched another ID of our request (the operation's), not the check
    filed = await service.record_response(db, message, operation_id=operation_id)
    return Answered(filed.check_id, filed.status, filed.duplicate,
                    await repository.patient_of(db, filed.check_id))


def register() -> bool:
    """Registers the builder, the dead-letter hook and the handler with core; False where
    core's partner registries (#186) don't exist yet."""
    wanted = ("app.integration.outbound", "app.integration.inbound")
    try:
        outbound, inbound = (importlib.import_module(name) for name in wanted)
    except ModuleNotFoundError as missing:
        if missing.name not in wanted:
            raise
        return False
    outbound.builds(PARTNER, MESSAGE_TYPE)(build_270)
    outbound.on_dead_letter(PARTNER, MESSAGE_TYPE)(dead_letter_270)
    inbound.handles(PARTNER, REPLY_TYPE)(file_271)
    return True


REGISTERED = register()
