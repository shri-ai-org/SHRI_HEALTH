"""Prescriptions' side of the e-prescribing connection (D97, D99), registered with core's partner
registries (app/integration/outbound.py and inbound.py, Thulasi's #186):

- **NewRx builder** (``@builds("erx", "NewRx")``, the worker, as ``shri_integration``): the
  outbox row holds the prescription's ID only (partner.outbox_payload); the NewRx is built from
  the signed prescription at send time (service.build_new_rx). One that can never be built
  (``MessageNotBuildable``, or a payload without a prescription) is a permanent
  ``DeliveryError`` with its short code: dead-lettered at once, not retried.
- **NewRx sent** (``@on_sent``): the transmission moves ``queued`` → ``sent`` (D97). If the
  pharmacy's answer was filed first, nothing changes (service.record_sent is a no-op then).
- **NewRx dead-letter** (``@on_dead_letter``): the transmission becomes ``error`` with a fixed
  message (service.record_failed); an operator's replay queues it again.
- **RxStatus handler** (``@handles("erx", "RxStatus")``, the API's ``/hooks/erx``, as
  ``shri_app`` in the clinic's system session): core has matched the reply to our NewRx and
  passes that outbox payload as ``request``; the reply must name that prescription. Core turns
  ``NotFound`` into ``unknown-correlation`` and ``ValidationFailed`` into ``invalid-message``.
  The result names the patient for core's audit.

Nothing here logs or keeps a message: codes and IDs only. Registration is import-guarded until
#186 is merged, as in eligibility/partner_bridge.py.
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

REPLY_TYPE = "RxStatus"
INVALID_PAYLOAD = "invalid-payload"


@dataclass(frozen=True)
class Answered:
    """What filing an RxStatus did; ``patient_id`` goes on core's audit row."""

    prescription_id: UUID
    status: str
    duplicate: bool
    patient_id: UUID | None


def prescription_of(payload: dict[str, Any]) -> UUID:
    """The prescription the outbox payload names; ValueError when it names none."""
    try:
        return UUID(str(payload["prescriptionId"]))
    except (KeyError, TypeError, ValueError):
        raise ValueError(INVALID_PAYLOAD) from None


async def build_new_rx(db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
    """The NewRx for the outbox row's prescription, in the worker's clinic session."""
    try:
        prescription_id = prescription_of(payload)
    except ValueError:
        raise DeliveryError(INVALID_PAYLOAD, permanent=True) from None
    try:
        message = await service.build_new_rx(db, prescription_id, now=datetime.now(UTC))
    except service.MessageNotBuildable as refused:
        raise DeliveryError(refused.code, permanent=True) from None
    return message.as_json()


async def sent_new_rx(db: AsyncSession, payload: dict[str, Any], control_id: str) -> object:
    """The pharmacy took the NewRx: ``sent``. The control ID is the partner's, not kept here
    (the RxStatus carries the vendor's message ID)."""
    return await service.record_sent(db, prescription_of(payload))


async def dead_letter_new_rx(db: AsyncSession, payload: dict[str, Any],
                             error_code: str) -> object:
    """The NewRx was given up on: ``error`` with the fixed message (the code is not shown)."""
    return await service.record_failed(db, prescription_of(payload))


async def file_rx_status(db: AsyncSession, message: dict[str, Any],
                         request: dict[str, Any]) -> Answered:
    """Files the pharmacy's RxStatus on the prescription our NewRx named (``request``)."""
    try:
        prescription_id = prescription_of(request)
    except ValueError:
        raise NotFound() from None
    if str(message.get("correlationId", "")).lower() != str(prescription_id):
        raise NotFound()
    filed = await service.record_status(db, message)
    patient_id, _ = await repository.event_scope(db, filed.prescription_id)
    return Answered(filed.prescription_id, filed.status, filed.duplicate, patient_id)


def register() -> bool:
    """Registers the builder, the two send hooks and the handler with core; False where core's
    partner registries (#186) don't exist yet."""
    wanted = ("app.integration.outbound", "app.integration.inbound")
    try:
        outbound, inbound = (importlib.import_module(name) for name in wanted)
    except ModuleNotFoundError as missing:
        if missing.name not in wanted:
            raise
        return False
    outbound.builds(PARTNER, MESSAGE_TYPE)(build_new_rx)
    outbound.on_sent(PARTNER, MESSAGE_TYPE)(sent_new_rx)
    outbound.on_dead_letter(PARTNER, MESSAGE_TYPE)(dead_letter_new_rx)
    inbound.handles(PARTNER, REPLY_TYPE)(file_rx_status)
    return True


REGISTERED = register()
