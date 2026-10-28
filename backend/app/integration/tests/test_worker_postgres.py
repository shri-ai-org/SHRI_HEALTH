"""The outbox worker against the real schema, as shri_integration (forced RLS; the claim is its
only cross-clinic step). Needs TEST_DATABASE_URL, migrated to head; skipped otherwise. The
adapters are fakes; synthetic IDs only."""

import json
import logging
from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.db import Database
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    make_tenant,
    switch_to_role,
)
from app.integration.worker import (
    BACKOFF_BASE_SECONDS,
    Delivered,
    DeliveryError,
    OutboundMessage,
    OutboxWorker,
    backoff_seconds,
)

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

SECRET_LOOKING = "Kaia Lindgren"  # what an adapter's exception text must never leak


class FakeAdapter:
    """Answers from a script: "ok", "transient", "permanent" or "crash", one per send."""

    def __init__(self, *script: str) -> None:
        self.script = list(script)
        self.sent: list[OutboundMessage] = []
        self.clinics: list[str] = []

    async def send(self, message: OutboundMessage, session: AsyncSession) -> Delivered:
        self.sent.append(message)
        self.clinics.append((await session.execute(text(
            "SELECT current_setting('app.current_tenant_id', true)"))).scalar_one())
        outcome = self.script.pop(0) if self.script else "ok"
        if outcome == "transient":
            raise DeliveryError("timeout")
        if outcome == "permanent":
            raise DeliveryError("rejected", permanent=True)
        if outcome == "crash":
            raise RuntimeError(f"bad reply about {SECRET_LOOKING}")
        return Delivered(control_id=f"CTRL-{len(self.sent)}")


@pytest.fixture
def database() -> Iterator[Database]:
    found = Database(Settings(environment="test", database_url=TEST_DATABASE_URL))
    switch_to_role(found.engine.sync_engine, "shri_integration")
    yield found


def _clinic(admin: Engine, adapter: str = "fake") -> dict[str, UUID]:
    tenant = make_tenant(admin)
    endpoint = uuid4()
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.integration_endpoint (id, tenant_id, kind, adapter, name, "
            "environment, baa_on_file, is_active) VALUES (:i, :t, 'erx', :a, 'Simulated', "
            "'test', false, true)"), {"i": endpoint, "t": tenant, "a": adapter})
    return {"tenant": tenant, "endpoint": endpoint}


def _queue(admin: Engine, clinic: dict[str, UUID], *, ordering_key: str | None = None,
           max_attempts: int = 8, payload: dict[str, Any] | None = None) -> UUID:
    message_id = uuid4()
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.integration_message (id, tenant_id, endpoint_id, direction, "
            "message_type, status, idempotency_key, ordering_key, payload, attempts, "
            "max_attempts) VALUES (:i, :t, :e, 'outbound', 'NewRx', 'queued', :k, :o, "
            "CAST(:p AS jsonb), 0, :m)"),
            {"i": message_id, "t": clinic["tenant"], "e": clinic["endpoint"],
             "k": f"newrx:{message_id}", "o": ordering_key,
             "p": json.dumps(payload or {"prescriptionId": str(uuid4())}), "m": max_attempts})
    return message_id


def _state(admin: Engine, message_id: UUID) -> Any:
    with admin.connect() as c:
        return c.execute(text(
            "SELECT status, attempts, last_error, control_id, sent_at, "
            "next_attempt_at - now() AS wait FROM admin.integration_message WHERE id = :i"),
            {"i": message_id}).one()


def _due_now(admin: Engine, message_id: UUID) -> None:
    with admin.begin() as c:
        c.execute(text("UPDATE admin.integration_message SET next_attempt_at = now() "
                       "WHERE id = :i"), {"i": message_id})


async def test_a_queued_message_is_sent_in_its_clinics_session(
        database: Database, admin_engine: Engine) -> None:  # noqa: F811
    clinic = _clinic(admin_engine)
    message_id = _queue(admin_engine, clinic)
    adapter = FakeAdapter("ok")
    counts = await OutboxWorker(database, {"fake": adapter}, batch=500).run_once()
    assert counts["sent"] >= 1
    state = _state(admin_engine, message_id)
    assert (state.status, state.attempts, state.last_error) == ("sent", 1, None)
    assert state.control_id is not None and state.sent_at is not None
    mine = [m for m in adapter.sent if m.id == message_id]
    assert len(mine) == 1 and mine[0].message_type == "NewRx"
    assert adapter.clinics[adapter.sent.index(mine[0])] == str(clinic["tenant"])  # RLS as the API
    await database.dispose()


async def test_a_transient_failure_is_retried_after_a_backoff(
        database: Database, admin_engine: Engine) -> None:  # noqa: F811
    clinic = _clinic(admin_engine)
    message_id = _queue(admin_engine, clinic)
    worker = OutboxWorker(database, {"fake": FakeAdapter("transient", "ok")}, batch=500,
                          rng=lambda: 1.0)
    await worker.run_once()
    state = _state(admin_engine, message_id)
    assert (state.status, state.attempts, state.last_error) == ("failed", 1, "timeout")
    assert 0 < state.wait.total_seconds() <= BACKOFF_BASE_SECONDS
    await worker.run_once()
    assert _state(admin_engine, message_id).status == "failed"  # not due yet: left alone
    _due_now(admin_engine, message_id)
    await worker.run_once()
    state = _state(admin_engine, message_id)
    assert (state.status, state.attempts, state.last_error) == ("sent", 2, None)
    await database.dispose()


async def test_a_permanent_failure_is_dead_lettered_with_an_alert(
        database: Database, admin_engine: Engine, caplog: pytest.LogCaptureFixture) -> None:  # noqa: F811
    clinic = _clinic(admin_engine)
    message_id = _queue(admin_engine, clinic, payload={"prescriptionId": "rx-synthetic-42"})
    with caplog.at_level(logging.ERROR):
        await OutboxWorker(database, {"fake": FakeAdapter("permanent")}, batch=500).run_once()
    state = _state(admin_engine, message_id)
    assert (state.status, state.last_error) == ("dead-letter", "rejected")
    assert str(message_id) in caplog.text and "dead-lettered" in caplog.text
    assert "rx-synthetic-42" not in caplog.text  # the payload is never logged
    await database.dispose()


async def test_the_last_attempt_is_dead_lettered(database: Database,
                                                 admin_engine: Engine) -> None:  # noqa: F811
    clinic = _clinic(admin_engine)
    message_id = _queue(admin_engine, clinic, max_attempts=1)
    await OutboxWorker(database, {"fake": FakeAdapter("transient")}, batch=500).run_once()
    state = _state(admin_engine, message_id)
    assert (state.status, state.attempts, state.last_error) == ("dead-letter", 1, "timeout")
    await database.dispose()


async def test_an_adapter_crash_keeps_no_text_and_is_retried(
        database: Database, admin_engine: Engine, caplog: pytest.LogCaptureFixture) -> None:  # noqa: F811
    clinic = _clinic(admin_engine)
    message_id = _queue(admin_engine, clinic)
    with caplog.at_level(logging.WARNING):
        await OutboxWorker(database, {"fake": FakeAdapter("crash")}, batch=500).run_once()
    state = _state(admin_engine, message_id)
    assert (state.status, state.last_error) == ("failed", "internal-error")
    assert SECRET_LOOKING not in caplog.text and "RuntimeError" in caplog.text
    await database.dispose()


async def test_a_connection_without_an_adapter_is_dead_lettered(
        database: Database, admin_engine: Engine) -> None:  # noqa: F811
    clinic = _clinic(admin_engine, adapter="not-installed")
    message_id = _queue(admin_engine, clinic)
    await OutboxWorker(database, {"fake": FakeAdapter()}, batch=500).run_once()
    assert _state(admin_engine, message_id)[:3] == ("dead-letter", 1, "no-adapter")
    await database.dispose()


async def test_a_later_message_waits_for_an_earlier_one_with_its_ordering_key(
        database: Database, admin_engine: Engine) -> None:  # noqa: F811
    clinic = _clinic(admin_engine)
    first = _queue(admin_engine, clinic, ordering_key="prescription:1")
    second = _queue(admin_engine, clinic, ordering_key="prescription:1")
    adapter = FakeAdapter("transient", "ok", "ok")
    worker = OutboxWorker(database, {"fake": adapter}, batch=500)
    await worker.run_once()
    assert _state(admin_engine, first).status == "failed"
    assert _state(admin_engine, second).status == "queued"  # held back: CancelRx after NewRx
    _due_now(admin_engine, first)
    await worker.run_once()
    await worker.run_once()
    assert [m.id for m in adapter.sent if m.id in (first, second)] == [first, first, second]
    assert _state(admin_engine, second).status == "sent"
    await database.dispose()


async def test_the_role_cannot_bypass_row_level_security(database: Database) -> None:
    assert await database.role_bypasses_rls() is False
    await database.dispose()


def test_the_backoff_doubles_with_jitter_and_is_capped() -> None:
    assert backoff_seconds(1, lambda: 0.0) == BACKOFF_BASE_SECONDS / 2
    assert backoff_seconds(1, lambda: 1.0) == BACKOFF_BASE_SECONDS
    assert backoff_seconds(3, lambda: 1.0) == BACKOFF_BASE_SECONDS * 4
    assert backoff_seconds(30, lambda: 1.0) == 3600.0
