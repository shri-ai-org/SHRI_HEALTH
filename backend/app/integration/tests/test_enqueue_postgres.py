"""enqueue() against the real schema, as shri_app (forced RLS). Needs TEST_DATABASE_URL, migrated to
head; skipped otherwise. Synthetic IDs only."""

from collections.abc import Awaitable, Callable, Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.db import Database
from app.core.errors import InternalError, ServiceUnavailable
from app.db.tests import builders as b
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    app_engine,
    db,
    make_tenant,
    open_session,
    switch_to_role,
    tenant,
)
from app.integration.api import enqueue

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

RX = uuid4()
PAYLOAD = {"prescriptionId": str(RX)}


def _endpoint(admin: Engine, tenant_id: UUID, kind: str = "erx", *,
              active: bool = True) -> UUID:
    endpoint_id = uuid4()
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.integration_endpoint (id, tenant_id, kind, adapter, name, "
            "environment, baa_on_file, is_active) VALUES (:i, :t, :k, 'simulated', :n, 'test', "
            "false, :a)"), {"i": endpoint_id, "t": tenant_id, "k": kind,
                             "n": f"Simulated {kind} {endpoint_id.hex[:6]}", "a": active})
    return endpoint_id


@pytest.fixture
def clinic(db: Session, tenant: UUID, admin_engine: Engine) -> dict[str, Any]:  # noqa: F811
    user = b.practitioner(db, "Rivera", "Elena")["user"]
    db.commit()
    return {"tenant": tenant, "user": user.id, "erx": _endpoint(admin_engine, tenant)}


@pytest.fixture
def database() -> Iterator[Database]:
    found = Database(Settings(environment="test", database_url=TEST_DATABASE_URL))
    switch_to_role(found.engine.sync_engine, "shri_app")
    yield found


Work = Callable[[AsyncSession], Awaitable[Any]]


async def _in(database: Database, clinic: dict[str, Any], work: Work, *,
              commit: bool = True) -> Any:
    async with database.tenant_session(clinic["tenant"], clinic["user"], "test-req") as session:
        result = await work(session)
        if commit:
            await session.commit()
        return result


def _rows(admin: Engine, tenant_id: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT id, endpoint_id, direction, message_type, status, idempotency_key, "
            "ordering_key, payload, attempts, max_attempts, correlation_id, created_by_user_id "
            "FROM admin.integration_message WHERE tenant_id = :t ORDER BY created_at"),
            {"t": tenant_id}))


async def test_a_message_is_queued_in_the_callers_transaction(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    message_id = await _in(database, clinic, lambda s: enqueue(
        s, "erx", "NewRx", PAYLOAD, f"newrx:{RX}:1", ordering_key=f"prescription:{RX}"))
    (row,) = _rows(admin_engine, clinic["tenant"])
    assert row.id == message_id and row.endpoint_id == clinic["erx"]
    assert (row.direction, row.message_type, row.status) == ("outbound", "NewRx", "queued")
    assert (row.idempotency_key, row.ordering_key) == (f"newrx:{RX}:1", f"prescription:{RX}")
    assert row.payload == PAYLOAD and (row.attempts, row.max_attempts) == (0, 8)
    assert row.created_by_user_id == clinic["user"]
    assert row.correlation_id is None  # outside a request; inside one, its X-Request-ID
    await database.dispose()


async def test_nothing_is_queued_if_the_caller_rolls_back(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    await _in(database, clinic, lambda s: enqueue(s, "erx", "NewRx", PAYLOAD, "newrx:rolled-back"),
              commit=False)
    assert _rows(admin_engine, clinic["tenant"]) == []
    await database.dispose()


async def test_the_same_key_returns_the_same_message(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    first = await _in(database, clinic, lambda s: enqueue(s, "erx", "NewRx", PAYLOAD, "newrx:k"))
    again = await _in(database, clinic, lambda s: enqueue(s, "erx", "NewRx", PAYLOAD, "newrx:k"))
    assert first == again and len(_rows(admin_engine, clinic["tenant"])) == 1
    with pytest.raises(ValueError, match="different partner message"):
        await _in(database, clinic, lambda s: enqueue(
            s, "erx", "NewRx", {"prescriptionId": str(uuid4())}, "newrx:k"))
    await database.dispose()


async def test_no_connection_of_that_kind_is_503_and_queues_nothing(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _endpoint(admin_engine, clinic["tenant"], "fax", active=False)  # switched off: not used
    with pytest.raises(ServiceUnavailable):
        await _in(database, clinic, lambda s: enqueue(s, "fax", "Fax", {"faxId": str(RX)}, "f1"))
    assert _rows(admin_engine, clinic["tenant"]) == []
    await database.dispose()


async def test_two_active_connections_of_a_kind_are_refused(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _endpoint(admin_engine, clinic["tenant"], "lab")
    _endpoint(admin_engine, clinic["tenant"], "lab")
    with pytest.raises(InternalError):
        await _in(database, clinic, lambda s: enqueue(s, "lab", "ORM^O01",
                                                      {"orderId": str(RX)}, "orm:1"))
    await database.dispose()


async def test_another_clinics_connection_is_never_used(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    other = make_tenant(admin_engine)
    _endpoint(admin_engine, other, "clearinghouse")  # only the other clinic has one
    with pytest.raises(ServiceUnavailable):
        await _in(database, clinic, lambda s: enqueue(s, "clearinghouse", "270",
                                                      {"eligibilityCheckId": str(RX)}, "270:1"))
    await database.dispose()


async def test_keys_are_per_clinic(database: Database, clinic: dict[str, Any],
                                   admin_engine: Engine, app_engine: Engine) -> None:  # noqa: F811
    other_tenant = make_tenant(admin_engine)
    other_db = open_session(app_engine, other_tenant)
    other = {"tenant": other_tenant,
             "user": b.practitioner(other_db, "Lund", "Sami")["user"].id}
    other_db.commit()
    other_db.close()
    _endpoint(admin_engine, other_tenant)
    mine = await _in(database, clinic, lambda s: enqueue(s, "erx", "NewRx", PAYLOAD, "newrx:same"))
    theirs = await _in(database, other, lambda s: enqueue(s, "erx", "NewRx", PAYLOAD,
                                                          "newrx:same"))
    assert mine != theirs
    await database.dispose()
