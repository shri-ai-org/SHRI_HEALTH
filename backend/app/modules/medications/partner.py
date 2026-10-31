"""The two core pieces signing uses, behind one interface so the API tests (no database) can
replace them:

- core's outbox ``enqueue(db, "erx", "NewRx", {"prescriptionId": …})`` (T29, D25, D99): IDs only,
  keyed by the prescription, so a retry of the same signature never sends twice, and ordered per
  prescription, so a later CancelRx never overtakes its NewRx;
- core's ``events.publish()``: ``prescription.signed`` and ``prescription.transmission-updated``
  (EVENTS.md §4), thin (IDs and statuses only).

Both write in the caller's transaction and never commit.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import publish
from app.integration.api import enqueue

PARTNER = "erx"  # app.integration.api.Partner
MESSAGE_TYPE = "NewRx"


class Partner(Protocol):
    async def send_new_rx(self, db: AsyncSession, prescription_id: UUID) -> UUID:
        """Queues the NewRx; returns the outbox message's ID (no commit)."""
        ...

    async def announce(self, db: AsyncSession, event: str, prescription_id: UUID,
                       data: Mapping[str, Any], *, patient_id: UUID | None,
                       facility_id: UUID | None) -> None:
        """Publishes a ``prescription.*`` event in the caller's transaction (no commit)."""
        ...


def outbox_payload(prescription_id: UUID) -> dict[str, str]:
    """What the outbox row holds: the ID only. The adapter builds the NewRx at send time
    (service.build_new_rx), so patient data never sits in the outbox."""
    return {"prescriptionId": str(prescription_id)}


async def announce(db: AsyncSession, event: str, prescription_id: UUID, data: Mapping[str, Any],
                   *, patient_id: UUID | None, facility_id: UUID | None) -> None:
    await publish(db, event, f"prescription/{prescription_id}", data, facility_id=facility_id,
                  patient_id=patient_id)


class CorePartner:
    async def send_new_rx(self, db: AsyncSession, prescription_id: UUID) -> UUID:
        return await enqueue(db, PARTNER, MESSAGE_TYPE, outbox_payload(prescription_id),
                             idempotency_key=f"newrx:{prescription_id}",
                             ordering_key=f"prescription:{prescription_id}")

    async def announce(self, db: AsyncSession, event: str, prescription_id: UUID,
                       data: Mapping[str, Any], *, patient_id: UUID | None,
                       facility_id: UUID | None) -> None:
        await announce(db, event, prescription_id, data, patient_id=patient_id,
                       facility_id=facility_id)


def partner() -> Partner:
    """FastAPI dependency: core's outbox and events."""
    return CorePartner()
