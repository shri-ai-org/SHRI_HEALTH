"""Work no user started (the outbox worker, partner callbacks) runs in a system session: the
clinic is set, the user is empty. It must still finish operations and queue partner messages
(Vimal's review of #186: `session_user_id()` turned the empty user into `UUID("")`).

The Postgres tests need TEST_DATABASE_URL, migrated to head; skipped otherwise. Synthetic data.
"""

from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.db import Database, session_user_id
from app.core.long_running import create_operation, finish_operation
from app.db.tests import builders as b
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    app_engine,
    db,
    switch_to_role,
    tenant,
)
from app.integration.api import enqueue

# Never connected to: the unit test only opens sessions, which connect lazily.
UNREACHABLE = SecretStr("postgresql+asyncpg://u:p@db.invalid/x")


def test_a_system_session_has_no_user_and_a_tenant_session_has_one() -> None:
    database = Database(Settings(environment="test"), UNREACHABLE)
    clinic, user = uuid4(), uuid4()
    assert session_user_id(database.system_session(clinic, "req-1")) is None
    assert session_user_id(database.tenant_session(clinic, user, "req-1")) == user
    assert session_user_id(database.sessions()) is None  # no clinic context at all


@pytest.fixture
def database() -> Iterator[Database]:
    found = Database(Settings(environment="test", database_url=TEST_DATABASE_URL))
    switch_to_role(found.engine.sync_engine, "shri_app")
    yield found


@pytest.fixture
def clinic(db: Session, tenant: UUID, admin_engine: Engine) -> dict[str, Any]:  # noqa: F811
    user = b.practitioner(db, "Halvorsen64", "Rowan318")["user"]
    db.commit()
    with admin_engine.begin() as c:
        c.execute(text(
            "INSERT INTO admin.integration_endpoint (id, tenant_id, kind, adapter, name, "
            "environment, baa_on_file, is_active) VALUES (:i, :t, 'clearinghouse', "
            "'simulated-clearinghouse', 'Simulated', 'test', false, true)"),
            {"i": uuid4(), "t": tenant})
    return {"tenant": tenant, "user": user.id}


async def test_a_system_session_finishes_an_operation_a_user_started(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    async with database.tenant_session(clinic["tenant"], clinic["user"], "req-1") as s:
        operation = await create_operation(s, "eligibility.check", assigned_to_integration=True)
        await s.commit()
    check_id = uuid4()

    async with database.system_session(clinic["tenant"], "req-2") as s:
        finished = await finish_operation(s, operation.id, "succeeded",
                                          result=("eligibility-check", check_id))
        await s.commit()
    await database.dispose()

    assert finished.status == "succeeded"
    with admin_engine.connect() as c:
        row = c.execute(text("SELECT status, created_by_user_id, updated_by_user_id "
                             "FROM admin.operation WHERE id = :i"), {"i": operation.id}).one()
        told = c.execute(text("SELECT target_user_id FROM admin.event_log WHERE subject = :s"),
                         {"s": f"operation/{operation.id}"}).scalars().all()
    assert (row.status, row.created_by_user_id, row.updated_by_user_id) == (
        "succeeded", clinic["user"], None)
    assert told == [clinic["user"]]  # its creator still hears about it


async def test_a_system_session_queues_a_partner_message(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    async with database.system_session(clinic["tenant"], "req-3") as s:
        message_id = await enqueue(s, "clearinghouse", "270", {"eligibilityCheckId": str(uuid4())},
                                   idempotency_key=f"270:{uuid4()}")
        await s.commit()
    await database.dispose()

    with admin_engine.connect() as c:
        row = c.execute(text("SELECT status, created_by_user_id FROM admin.integration_message "
                             "WHERE id = :i"), {"i": message_id}).one()
    assert (row.status, row.created_by_user_id) == ("queued", None)
