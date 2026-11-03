"""Migration 0018: the partner worker reads what the NewRx and the eligibility request need,
times out an eligibility request and finishes its operations, and nothing more (D95, D97).

The worker runs as shri_integration (SET ROLE from the superuser URL, see conftest.py) in the
clinic of the message it handles, as core's system_session sets it. Synthetic data only.
"""
from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from pydantic import SecretStr
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.pool import NullPool

from app.core import long_running
from app.core.config import Settings
from app.core.db import Database
from app.db.models import MAPPERS
from app.db.tests import builders as b
from app.db.tests.conftest import (
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)
from app.db.tests.test_db_rules import fails

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS

#: What the two messages read (migration 0018): each table, a column and which of the clinic's
#: rows it should find there.
READS = {
    "clinical.medication_request": ("id", "prescription"),
    "clinical.dosage": ("medication_request_id", "prescription"),
    "clinical.patient": ("id", "patient"),
    "clinical.human_name": ("patient_id", "patient"),
    "clinical.identifier": ("patient_id", "patient"),
    "clinical.encounter": ("subject_patient_id", "patient"),
    "clinical.coverage": ("id", "coverage"),
    "clinical.coverage_payor": ("coverage_id", "coverage"),
    "clinical.coverage_class": ("coverage_id", "coverage"),
    "clinical.appointment": ("id", "appointment"),
    "clinical.appointment_participant": ("appointment_id", "appointment"),
    "admin.eligibility_check": ("id", "check"),
    "admin.eligibility_service_type": ("eligibility_check_id", "check"),
}


@pytest.fixture(scope="module")
def worker() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_integration")
    yield engine
    engine.dispose()


def _clinic(app_engine: Engine, admin_engine: Engine) -> dict[str, Any]:
    """A clinic with a signed prescription and a pending eligibility check for its booked
    visit, plus an operation assigned to the worker and one that isn't."""
    tenant = make_tenant(admin_engine)
    s = open_session(app_engine, tenant)
    try:
        ctx = b.practice(s)
        pt = b.patient(s)
        enc = b.encounter(s, pt, ctx, status="in-progress")
        mr = b.prescription(s, pt, enc, ctx)
        b.sign_prescription(s, mr, ctx)
        cov = M["coverage"](status="active", beneficiary_patient_id=pt.id, order=1,
                            relationship_code="self", subscriber_id="W123456789")
        appt = M["appointment"](status="booked", subject_patient_id=pt.id, start=b.NOW,
                                end=b.NOW + dt.timedelta(minutes=20),
                                ext_facility_id=ctx["facility"].id)
        s.add_all([cov, appt])
        s.flush()
        cov.class_ = [M["coverage_class"](type="group", value="GRP-55", name="Acme Inc")]
        cov.payor = [M["coverage_payor"](patient_id=pt.id)]
        appt.participant = [M["appointment_participant"](
            actor_practitioner_id=ctx["practitioner"].id, required="required",
            status="accepted")]
        check = M["eligibility_check"](coverage_id=cov.id, patient_id=pt.id,
                                       appointment_id=appt.id, trigger="booking",
                                       clearinghouse="clearinghouse", status="pending",
                                       requested_at=b.NOW)
        s.add(check)
        s.flush()
        s.add(M["eligibility_service_type"](eligibility_check_id=check.id,
                                            service_type_code="30"))
        s.commit()
        found = {"tenant": tenant, "patient": pt.id, "prescription": mr.id, "check": check.id,
                 "coverage": cov.id, "appointment": appt.id, "user": ctx["user"].id}
    finally:
        conn = s.bind
        s.close()
        conn.close()  # type: ignore[union-attr]
    with admin_engine.begin() as c:
        for key, assigned in (("assigned", True), ("unassigned", False)):
            found[key] = c.execute(text(
                "INSERT INTO admin.operation (id, tenant_id, created_by_user_id, kind, status, "
                "assigned_to_integration) VALUES (gen_random_uuid(), :t, :u, "
                "'eligibility.check', 'queued', :a) RETURNING id"),
                {"t": tenant, "u": found["user"], "a": assigned}).scalar_one()
    return found


@pytest.fixture(scope="module")
def clinic(app_engine: Engine, admin_engine: Engine) -> dict[str, Any]:
    return _clinic(app_engine, admin_engine)


def _in_clinic(conn: Connection, tenant: uuid.UUID) -> Connection:
    conn.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": str(tenant)})
    return conn


@pytest.mark.parametrize("table", sorted(READS))
def test_the_worker_reads_what_its_messages_need_in_its_clinic_only(
        worker: Engine, admin_engine: Engine, clinic: dict[str, Any], table: str) -> None:
    column, row = READS[table]
    query = text(f"SELECT count(*) FROM {table} WHERE {column} = :k")  # noqa: S608
    key = {"k": clinic[row]}
    with worker.begin() as c:
        assert _in_clinic(c, clinic["tenant"]).execute(query, key).scalar_one() >= 1
    with worker.begin() as c:
        assert _in_clinic(c, make_tenant(admin_engine)).execute(query, key).scalar_one() == 0


@pytest.mark.parametrize("table", ["admin.pharmacy", "admin.payer", "admin.payer_clearinghouse_id",
                                   "admin.facility", "clinical.organization",
                                   "clinical.related_person"])
def test_the_worker_reads_the_reference_tables(worker: Engine, clinic: dict[str, Any],
                                               table: str) -> None:
    with worker.begin() as c:
        _in_clinic(c, clinic["tenant"]).execute(text(f"SELECT * FROM {table} LIMIT 1"))  # noqa: S608


def test_the_worker_reads_its_clinics_time_zone_and_nothing_else_of_it(
        worker: Engine, clinic: dict[str, Any]) -> None:
    with worker.begin() as c:
        rows = _in_clinic(c, clinic["tenant"]).execute(
            text("SELECT id, timezone FROM admin.tenant")).all()
    assert [r.id for r in rows] == [clinic["tenant"]]
    with worker.connect() as c:
        _in_clinic(c, clinic["tenant"])
        with fails(c, "42501"):  # type: ignore[arg-type]  # a Connection nests the same way
            c.execute(text("SELECT pre_registration_code FROM admin.tenant"))


def test_the_worker_times_out_a_pending_request(worker: Engine, app_engine: Engine,
                                                admin_engine: Engine) -> None:
    """eligibility mark_timed_out's statement (the dead-letter hook), as the worker."""
    own = _clinic(app_engine, admin_engine)
    timed_out = text("UPDATE admin.eligibility_check SET status = 'timeout', "
                     "error_code = 'timeout', error_message = :m, updated_at = now(), "
                     "updated_by_user_id = CAST(NULLIF(current_setting('app.current_user_id', "
                     "true), '') AS uuid) WHERE id = :i AND status = 'pending'")
    with worker.begin() as c:
        moved = _in_clinic(c, own["tenant"]).execute(timed_out,
                                                     {"i": own["check"], "m": "No reply"})
        assert moved.rowcount == 1
    with admin_engine.connect() as c:
        assert c.execute(text("SELECT status FROM admin.eligibility_check WHERE id = :i"),
                         {"i": own["check"]}).scalar_one() == "timeout"


@pytest.mark.parametrize("sql", [
    "UPDATE admin.eligibility_check SET plan_name = 'Gold' WHERE id = :check",
    "UPDATE admin.eligibility_check SET coverage_id = coverage_id WHERE id = :check",
    "DELETE FROM admin.eligibility_check WHERE id = :check",
    "SELECT count(*) FROM admin.eligibility_benefit",
    "INSERT INTO admin.eligibility_benefit (id, tenant_id, eligibility_check_id, benefit_type) "
    "SELECT gen_random_uuid(), tenant_id, id, 'active' FROM admin.eligibility_check "
    "WHERE id = :check",
    "UPDATE clinical.patient SET birth_date = birth_date WHERE id = :patient",
    "UPDATE clinical.medication_request SET status = status WHERE id = :rx",
    "DELETE FROM clinical.dosage WHERE medication_request_id = :rx",
    "DELETE FROM clinical.medication_request WHERE id = :rx",
    "INSERT INTO clinical.human_name (id, tenant_id, patient_id, family) "
    "SELECT gen_random_uuid(), tenant_id, id, 'Doe' FROM clinical.patient WHERE id = :patient",
    "UPDATE admin.tenant SET timezone = timezone",
    "UPDATE admin.operation SET kind = kind WHERE id = :op",
    "DELETE FROM admin.operation WHERE id = :op",
    "SELECT count(*) FROM audit.audit_event",
])
def test_the_worker_changes_nothing_else(worker: Engine, clinic: dict[str, Any],
                                         sql: str) -> None:
    keys = {"check": clinic["check"], "patient": clinic["patient"],
            "rx": clinic["prescription"], "op": clinic["assigned"]}
    with worker.connect() as c:
        _in_clinic(c, clinic["tenant"])
        with fails(c, "42501"):  # type: ignore[arg-type]
            c.execute(text(sql), {k: v for k, v in keys.items() if f":{k}" in sql})


async def test_core_finishes_an_assigned_operation_as_the_worker(
        app_engine: Engine, admin_engine: Engine) -> None:
    """finish_operation's own statements (core's _GET and _SET), as shri_integration in the
    operation's clinic: the column grants cover what it reads back and sets, and the
    assigned-only policy still holds. (finish_operation itself needs #186's session_user_id,
    which returns None for a system session.)"""
    own = _clinic(app_engine, admin_engine)
    database = Database(Settings(database_url=SecretStr(TEST_DATABASE_URL or "")))
    switch_to_role(database.engine.sync_engine, "shri_integration")
    finish = {"status": "succeeded", "final": True, "result_type": "eligibility-check",
              "result_id": own["check"], "error": None, "user": None}
    try:
        async with database.system_session(own["tenant"]) as s:  # as the outbox worker
            assert (await s.execute(long_running._GET, {"id": own["assigned"]})).one()
            done = (await s.execute(long_running._SET, {"id": own["assigned"], **finish})).one()
            assert (await s.execute(long_running._GET, {"id": own["unassigned"]})).first() is None
            await s.commit()
    finally:
        await database.dispose()
    assert (done.status, done.created_by_user_id, done.result_id) == (
        "succeeded", own["user"], own["check"])
    assert done.completed_at is not None
    with admin_engine.connect() as c:
        assert c.execute(text("SELECT status FROM admin.operation WHERE id = :i"),
                         {"i": own["unassigned"]}).scalar_one() == "queued"
