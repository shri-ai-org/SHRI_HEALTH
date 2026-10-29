"""The outbox worker (T29, D25; DATA_OWNERSHIP §3.3): sends what enqueue() queued.

    python -m app.integration.worker      # INTEGRATION_DATABASE_URL: the shri_integration role

Each round:
1. **Claim** a batch across clinics with admin.claim_outbound_messages() (its only cross-clinic
   step, SECURITY DEFINER). It marks them `sending`, counts the attempt, holds back a message
   whose ordering key has an earlier unsent one, and dead-letters what has used its attempts.
2. **Send** each one in its own clinic's session (row-level security as for the API), through the
   adapter its connection names (admin.integration_endpoint.adapter).
3. **Record** the outcome in that session:
   - sent: `sent`, with the partner's control ID;
   - a transient failure: `failed`, retried after an exponential backoff with jitter;
   - a permanent failure, or the last attempt: `dead-letter`, with an error log line for the
     alert. An operator can replay it later (the replay route comes with its contract).

**No patient data is stored or logged here.** `last_error` and the logs hold only the adapter's
short error code, the message ID, its clinic and its type, never a payload, a partner's reply or
an exception's text. A message whose adapter doesn't exist is dead-lettered (`no-adapter`) so a
configuration mistake shows instead of waiting forever.

A worker that dies mid-send leaves the message `sending`; the claim takes it again after 15
minutes, so a partner may see it twice. Adapters send the message's idempotency key (or its
control ID) so the partner can drop the duplicate.
"""

import asyncio
import logging
import random
import signal
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.db import Database

log = logging.getLogger(__name__)

BATCH = 20
POLL_SECONDS = 2.0
BACKOFF_BASE_SECONDS = 30.0
BACKOFF_CAP_SECONDS = 3600.0


@dataclass(frozen=True)
class OutboundMessage:
    id: UUID
    tenant_id: UUID
    endpoint_id: UUID
    adapter: str
    message_type: str
    payload: dict[str, Any]
    idempotency_key: str | None
    ordering_key: str | None
    attempts: int
    max_attempts: int
    correlation_id: str | None


@dataclass(frozen=True)
class Delivered:
    control_id: str | None = None  # the partner's or the message's ID (MSH-10, ST02, …)


class DeliveryError(Exception):
    """An adapter's failure, as a short code with no patient data ("timeout", "http-503",
    "rejected"). `permanent`: retrying can't help, so the message goes to the dead-letter queue."""

    def __init__(self, code: str, *, permanent: bool = False) -> None:
        super().__init__(code)
        self.code = code[:100]
        self.permanent = permanent


class Adapter(Protocol):
    async def send(self, message: OutboundMessage, session: AsyncSession) -> Delivered:
        """Builds the partner message from the records the payload names, sends it, and returns
        how it went; raises DeliveryError on failure."""
        ...


def backoff_seconds(attempt: int, rng: Callable[[], float] = random.random) -> float:
    """Exponential, capped, with jitter: between half and all of base * 2^(attempt - 1)."""
    ceiling = min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2.0 ** max(0, attempt - 1))
    return float(ceiling * (0.5 + rng() / 2))


_CLAIM = text("SELECT id, tenant_id FROM admin.claim_outbound_messages(:n)")
_LOAD = text(
    "SELECT m.id, m.tenant_id, m.endpoint_id, e.adapter, m.message_type, "
    "coalesce(m.payload, '{}'::jsonb) AS payload, m.idempotency_key, m.ordering_key, "
    "m.attempts, m.max_attempts, m.correlation_id "
    "FROM admin.integration_message m JOIN admin.integration_endpoint e ON e.id = m.endpoint_id "
    "WHERE m.id = :id AND m.status = 'sending' FOR UPDATE OF m")
_SENT = text(
    "UPDATE admin.integration_message SET status = 'sent', sent_at = now(), control_id = :control, "
    "last_error = NULL, next_attempt_at = NULL, updated_at = now() WHERE id = :id")
_FAILED = text(
    "UPDATE admin.integration_message SET status = 'failed', last_error = :error, "
    "next_attempt_at = now() + make_interval(secs => :delay), updated_at = now() WHERE id = :id")
_DEAD = text(
    "UPDATE admin.integration_message SET status = 'dead-letter', last_error = :error, "
    "next_attempt_at = NULL, updated_at = now() WHERE id = :id")
_ENDPOINT_FAILED = text(
    "UPDATE admin.integration_endpoint SET last_failure_at = now() WHERE id = :id")
_ENDPOINT_OK = text(
    "UPDATE admin.integration_endpoint SET last_success_at = now() WHERE id = :id")


class OutboxWorker:
    def __init__(self, db: Database, adapters: Mapping[str, Adapter], *, batch: int = BATCH,
                 rng: Callable[[], float] = random.random) -> None:
        self._db = db
        self._adapters = adapters
        self._batch = batch
        self._rng = rng

    async def run_once(self) -> dict[str, int]:
        """One round; returns how many were sent, failed and dead-lettered."""
        counts = {"sent": 0, "failed": 0, "dead-letter": 0}
        async with self._db.sessions() as session:  # the claim's own cross-clinic transaction
            claimed = (await session.execute(_CLAIM, {"n": self._batch})).all()
            await session.commit()
        for message_id, tenant_id in claimed:
            counts[await self._deliver(message_id, tenant_id)] += 1
        return counts

    async def _deliver(self, message_id: UUID, tenant_id: UUID) -> str:
        async with self._db.system_session(tenant_id) as session:
            row = (await session.execute(_LOAD, {"id": message_id})).one_or_none()
            if row is None:  # taken over by another worker after a lease ran out
                return "failed"
            message = OutboundMessage(**dict(row._mapping))
            outcome = await self._send(message, session)
            await session.commit()
            return outcome

    async def _send(self, message: OutboundMessage, session: AsyncSession) -> str:
        adapter = self._adapters.get(message.adapter)
        try:
            if adapter is None:
                raise DeliveryError("no-adapter", permanent=True)
            delivered = await adapter.send(message, session)
        except DeliveryError as error:
            return await self._failed(message, session, error)
        except Exception as error:  # an adapter bug: its text may hold patient data, so not kept
            log.error("Outbox adapter %s raised %s for message %s", message.adapter,
                      type(error).__name__, message.id)
            return await self._failed(message, session, DeliveryError("internal-error"))
        control = delivered.control_id[:60] if delivered.control_id else None
        await session.execute(_SENT, {"id": message.id, "control": control})
        await session.execute(_ENDPOINT_OK, {"id": message.endpoint_id})
        return "sent"

    async def _failed(self, message: OutboundMessage, session: AsyncSession,
                      error: DeliveryError) -> str:
        await session.execute(_ENDPOINT_FAILED, {"id": message.endpoint_id})
        if error.permanent or message.attempts >= message.max_attempts:
            await session.execute(_DEAD, {"id": message.id, "error": error.code})
            # The alert: monitoring raises it from this line (no payload, no patient data).
            log.error("Outbox message %s (clinic %s, %s %s) dead-lettered after %s attempt(s): %s",
                      message.id, message.tenant_id, message.adapter, message.message_type,
                      message.attempts, error.code)
            return "dead-letter"
        delay = backoff_seconds(message.attempts, self._rng)
        await session.execute(_FAILED, {"id": message.id, "error": error.code, "delay": delay})
        log.warning("Outbox message %s (%s %s) failed attempt %s of %s (%s); retry in %ds",
                    message.id, message.adapter, message.message_type, message.attempts,
                    message.max_attempts, error.code, delay)
        return "failed"


def adapters() -> dict[str, Adapter]:
    """The partner adapters by name (admin.integration_endpoint.adapter). The simulated payer and
    pharmacy for the demo join here once their message shapes are in the contract (7 Nov)."""
    return {}


async def run(settings: Settings, stop: asyncio.Event) -> None:
    if settings.integration_database_url is None:
        raise SystemExit("INTEGRATION_DATABASE_URL is not configured (the shri_integration role)")
    db = Database(settings, settings.integration_database_url)
    if await db.role_bypasses_rls():
        await db.dispose()
        raise SystemExit("The worker's database role bypasses row-level security (D23)")
    worker = OutboxWorker(db, adapters())
    log.info("Outbox worker started")
    try:
        while not stop.is_set():
            try:
                counts = await worker.run_once()
            except Exception:
                log.exception("Outbox round failed; trying again")
                counts = {}
            if not any(counts.values()):
                try:
                    await asyncio.wait_for(stop.wait(), POLL_SECONDS)
                except TimeoutError:
                    pass
    finally:
        await db.dispose()
        log.info("Outbox worker stopped")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    async def start() -> None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(signum, stop.set)
        await run(get_settings(), stop)

    asyncio.run(start())
    return 0


if __name__ == "__main__":
    sys.exit(main())
