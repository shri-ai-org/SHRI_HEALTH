"""Migration 0015: the partner worker files a pharmacy's answer to a NewRx (D97, D99).

The worker runs as shri_integration (SET ROLE from the superuser URL, see conftest.py) in the
clinic of the message it handles, as core's system_session sets it. Synthetic data only.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.pool import NullPool

from app.db.models import MAPPERS
from app.db.tests import builders as b
from app.db.tests.conftest import (
    SKIP_WITHOUT_DATABASE,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)
from app.db.tests.test_db_rules import fails

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS


@pytest.fixture(scope="module")
def worker() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_integration")
    yield engine
    engine.dispose()


def _queued_new_rx(app_engine: Engine, admin_engine: Engine) -> dict[str, Any]:
    """A signed prescription with its NewRx queued, in a clinic of its own."""
    tenant = make_tenant(admin_engine)
    s = open_session(app_engine, tenant)
    try:
        ctx = b.practice(s)
        pt = b.patient(s)
        enc = b.encounter(s, pt, ctx, status="in-progress")
        mr = b.prescription(s, pt, enc, ctx)
        b.sign_prescription(s, mr, ctx)
        tx = M["erx_transaction"](medication_request_id=mr.id, patient_id=pt.id,
                                  message_type="NewRx", direction="outbound", status="queued",
                                  occurred_at=b.NOW)
        s.add(tx)
        s.commit()
        return {"tenant": tenant, "tx": tx.id}
    finally:
        conn = s.bind
        s.close()
        conn.close()  # type: ignore[union-attr]


def _in_clinic(conn: Connection, tenant: uuid.UUID) -> Connection:
    conn.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": str(tenant)})
    return conn


def test_the_worker_files_the_pharmacys_answer(worker: Engine, app_engine: Engine,
                                               admin_engine: Engine) -> None:
    rx = _queued_new_rx(app_engine, admin_engine)
    with worker.begin() as c:
        _in_clinic(c, rx["tenant"])
        moved = c.execute(text("UPDATE admin.erx_transaction SET status = 'rejected', "
                               "error_message = 'Unknown prescriber', vendor_message_id = 'V-1' "
                               "WHERE id = :i RETURNING status"), {"i": rx["tx"]}).scalar_one()
        assert moved == "rejected"


@pytest.mark.parametrize("sql", [
    "UPDATE admin.erx_transaction SET occurred_at = now() WHERE id = :i",
    "UPDATE admin.erx_transaction SET medication_request_id = NULL WHERE id = :i",
    "DELETE FROM admin.erx_transaction WHERE id = :i",
    "INSERT INTO admin.erx_transaction (id, tenant_id, message_type, direction, status, "
    "occurred_at) SELECT gen_random_uuid(), tenant_id, 'NewRx', 'inbound', 'received', now() "
    "FROM admin.erx_transaction WHERE id = :i",
])
def test_the_worker_changes_nothing_else(worker: Engine, app_engine: Engine,
                                         admin_engine: Engine, sql: str) -> None:
    rx = _queued_new_rx(app_engine, admin_engine)
    with worker.connect() as c:
        _in_clinic(c, rx["tenant"])
        with fails(c, "42501"):  # type: ignore[arg-type]  # a Connection nests the same way
            c.execute(text(sql), {"i": rx["tx"]})


def test_the_worker_sees_only_the_clinic_it_works_in(worker: Engine, app_engine: Engine,
                                                     admin_engine: Engine) -> None:
    rx = _queued_new_rx(app_engine, admin_engine)
    with worker.begin() as c:
        _in_clinic(c, make_tenant(admin_engine))
        assert c.execute(text("SELECT count(*) FROM admin.erx_transaction WHERE id = :i"),
                         {"i": rx["tx"]}).scalar_one() == 0
