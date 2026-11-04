"""Eligibility against a live database, as shri_app, with nothing replaced but the sign-in: core's
tenant_db, idempotency, operations, audit, restricted-chart check and outbox (enqueue), and the
real reads and writes. The practice, users and client are scheduling's live fixtures (a fresh
clinic A with a facility, a provider with an NPI and synthetic patients, and a clinic B).

The 270 is built from the real tables and checked against its JSON Schema, and each recorded
synthetic 271 (contracts/partners/clearinghouse/examples/) is filed through ``record_response``
in a clinic session, as the /hooks/clearinghouse receiver will. Synthetic data only.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import os
import uuid
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.db import Database
from app.core.deps import CurrentUser
from app.core.errors import NotFound
from app.db.models import MAPPERS, systems
from app.db.tests.conftest import TEST_DATABASE_URL, switch_to_role, sync_url
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (fixtures)
    ZONE,
    Practice,
    client,
    practice,
    setup_session,
    users,
)
from app.modules.scheduling.tests.test_check_in_live import _sql

from .. import partner, service
from .schema_check import errors
from .test_messages import REQUEST, example

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
OPENBAO = pytest.mark.skipif(
    not os.environ.get("OPENBAO_TRANSIT_ADDR") and os.environ.get("REQUIRE_OPENBAO") != "1",
    reason="OPENBAO_TRANSIT_ADDR not set (the stored response is encrypted)")
API = "/api/v1"
M = MAPPERS


# ------------------------------------------------------------------------------ set-up
def _insured(practice: Practice, patient: str = "kaia") -> UUID:  # noqa: F811
    """An active coverage for the patient (self), with a payer the clearinghouse knows, a member
    ID and a group, written as Anand's helpers write them."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    payer_id = uuid.uuid4()
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.payer (id, name, payer_type, supports_eligibility, "
            "supports_claim_status, supports_era, is_active) VALUES (:i, :n, 'commercial', true, "
            "true, true, true)"), {"i": payer_id, "n": "Example Health Plan (synthetic)"})
        c.execute(text("INSERT INTO admin.practice_payer (id, tenant_id, payer_id, is_active) "
                       "VALUES (:i, :t, :p, true)"),
                  {"i": uuid.uuid4(), "t": practice.clinic, "p": payer_id})
        c.execute(text("INSERT INTO admin.payer_clearinghouse_id (id, payer_id, clearinghouse, "
                       "external_payer_id) VALUES (:i, :p, 'clearinghouse', :x)"),
                  {"i": uuid.uuid4(), "p": payer_id, "x": f"TESTPAYER-{payer_id.hex[:6]}"})
    db = setup_session(admin, practice.clinic)
    try:
        tenant, person = practice.clinic, practice.patients[patient]
        coverage = M["coverage"](tenant_id=tenant, status="active", beneficiary_patient_id=person,
                                 subscriber_patient_id=person, relationship_code="self",
                                 order=1, period_start=dt.date(2026, 1, 1))
        db.add(coverage)
        db.flush()
        db.add_all([
            M["coverage_payor"](tenant_id=tenant, coverage_id=coverage.id, payer_id=payer_id),
            M["identifier"](tenant_id=tenant, coverage_id=coverage.id,
                            type_system=systems.V2_0203, type_code="MB",
                            value="TEST-MEMBER-042"),
            M["coverage_class"](tenant_id=tenant, coverage_id=coverage.id, type="group",
                                value="TEST-GRP-7", name="Demo employer group")])
        coverage_id: UUID = coverage.id
        db.commit()
        return coverage_id
    finally:
        db.close()
        admin.dispose()


def _clearinghouse(practice: Practice) -> UUID:  # noqa: F811
    """The clinic's clearinghouse connection (the simulated payer's adapter, Thulasi's)."""
    endpoint_id = uuid.uuid4()
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.integration_endpoint (id, tenant_id, kind, adapter, name, "
            "environment, baa_on_file, is_active) VALUES (:i, :t, 'clearinghouse', 'simulated', "
            "'Simulated payer', 'test', false, true)"), {"i": endpoint_id, "t": practice.clinic})
    admin.dispose()
    return endpoint_id


def _count(practice: Practice, table: str) -> int:  # noqa: F811
    """Rows of one admin table in the test's clinic (the setup session sees every clinic)."""
    found: int = _sql(practice, f"SELECT count(*) FROM admin.{table} WHERE tenant_id = :t",
                      t=practice.clinic)[0][0]
    return found


def _today_appointment(practice: Practice, patient: str = "kaia", *,  # noqa: F811
                       facility: UUID | None = None, hour: int = 12) -> str:
    """A booked appointment today at ``hour``, facility time, with the provider and the room
    (as scheduling's check-in tests write it; one hour each, so none double-books)."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        start = dt.datetime.combine(dt.datetime.now(ZoneInfo(ZONE)).date(), dt.time(hour),
                                    ZoneInfo(ZONE))
        appointment = M["appointment"](
            tenant_id=practice.clinic, status="booked", start=start,
            end=start + dt.timedelta(minutes=20), minutes_duration=20,
            subject_patient_id=practice.patients[patient],
            ext_appointment_type_id=practice.types["FU"],
            ext_facility_id=facility or practice.facility)
        appointment.participant = [
            M["appointment_participant"](actor_patient_id=practice.patients[patient],
                                         status="accepted"),
            M["appointment_participant"](actor_practitioner_id=practice.provider,
                                         status="accepted"),
            M["appointment_participant"](actor_location_id=practice.room, status="accepted")]
        db.add(appointment)
        db.flush()
        appointment_id = str(appointment.id)
        db.commit()
        return appointment_id
    finally:
        db.close()
        admin.dispose()


def _key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _run(client: Any, coverage: UUID, appointment: str | None = None,  # noqa: F811
         user: str = "fd", **extra: Any) -> Any:
    body: dict[str, Any] = {"coverageId": str(coverage), **extra}
    if appointment is not None:
        body["appointmentId"] = appointment
    return client(user).post(f"{API}/eligibility-checks", json=body, headers=_key())


def _check_of(practice: Practice, operation_id: str) -> UUID:  # noqa: F811
    """The check the operation's 270 names, from the outbox row (IDs only)."""
    rows = _sql(practice, "SELECT payload FROM admin.integration_message "
                "WHERE payload->>'operationId' = :o", o=operation_id)
    assert len(rows) == 1
    return UUID(rows[0][0]["eligibilityCheckId"])


def _in_clinic[T](practice: Practice,  # noqa: F811
                  work: Callable[[AsyncSession], Awaitable[T]], *,
                  user: CurrentUser | None = None) -> T:
    """``work`` in one clinic session as shri_app, committed: the user's (tenant_session) or the
    worker's (system_session, no user)."""
    async def go() -> T:
        database = Database(Settings(environment="test", database_url=TEST_DATABASE_URL))
        switch_to_role(database.engine.sync_engine, "shri_app")
        try:
            session = (database.tenant_session(practice.clinic, user.id) if user is not None
                       else database.system_session(practice.clinic))
            async with session:
                result = await work(session)
                await session.commit()
                return result
        finally:
            await database.dispose()
    return asyncio.run(go())


def _reply(name: str, check_id: UUID) -> dict[str, Any]:
    return example(name) | {"correlationId": str(check_id)}


def _local_today() -> str:
    return dt.datetime.now(ZoneInfo(ZONE)).date().isoformat()


# ------------------------------------------------------------------------ runEligibilityCheck
def test_run_writes_the_check_the_operation_and_the_270_together(
        client: Any, practice: Practice) -> None:  # noqa: F811
    coverage = _insured(practice)
    endpoint = _clearinghouse(practice)
    appointment = _today_appointment(practice)
    started = _run(client, coverage, appointment)
    assert started.status_code == 202, started.text
    operation = started.json()
    assert (operation["kind"], operation["status"]) == ("eligibility.check", "queued")
    assert started.headers["Location"] == f"{API}/operations/{operation['id']}"
    check_id = _check_of(practice, operation["id"])
    check = _sql(practice, "SELECT trigger, status, appointment_id, provider_npi, "
                 "integration_message_id, requested_by_user_id IS NOT NULL "
                 "FROM admin.eligibility_check WHERE id = :c", c=check_id)[0]
    npi = _sql(practice, "SELECT value FROM clinical.identifier WHERE practitioner_id = :p "
               "AND system = :s", p=practice.provider, s=systems.NPI)[0][0]
    assert tuple(check[:4]) == ("manual", "pending", UUID(appointment), npi) and check[5]
    message = _sql(practice, "SELECT id, endpoint_id, direction, message_type, status, "
                   "idempotency_key, payload FROM admin.integration_message WHERE id = :m",
                   m=check[4])[0]
    assert tuple(message[1:6]) == (endpoint, "outbound", "270", "queued", f"270:{check_id}")
    assert message[6] == partner.outbox_payload(check_id, UUID(operation["id"]))  # IDs only
    assert [r[0] for r in _sql(practice, "SELECT service_type_code FROM "
                               "admin.eligibility_service_type WHERE eligibility_check_id = :c",
                               c=check_id)] == ["30"]
    assert tuple(_sql(practice, "SELECT kind, status, assigned_to_integration FROM "
                      "admin.operation WHERE id = :o", o=operation["id"])[0]) == (
        "eligibility.check", "queued", True)
    polled = client("fd").get(f"{API}/operations/{operation['id']}")
    assert polled.status_code == 200 and polled.json()["status"] == "queued"
    audited = _sql(practice, "SELECT patient_id, category FROM audit.audit_event "
                   "WHERE entity_type = 'eligibility-checks' AND action = 'create' "
                   "AND tenant_id = :t", t=practice.clinic)
    assert [tuple(a) for a in audited] == [(practice.patients["kaia"], "phi-write")]


@OPENBAO
def test_run_replays_a_repeated_key_and_sends_once(client: Any, practice: Practice) -> None:  # noqa: F811
    coverage = _insured(practice)
    _clearinghouse(practice)
    key, body = _key(), {"coverageId": str(coverage)}
    first = client("fd").post(f"{API}/eligibility-checks", json=body, headers=key)
    assert first.status_code == 202, first.text
    again = client("fd").post(f"{API}/eligibility-checks", json=body, headers=key)
    assert again.status_code == 202 and again.headers["Idempotent-Replayed"] == "true"
    assert again.json()["id"] == first.json()["id"]
    assert _count(practice, "eligibility_check") == 1
    assert _count(practice, "integration_message") == 1
    other = client("fd").post(f"{API}/eligibility-checks", headers=key,
                              json={**body, "serviceTypeCodes": ["98"]})
    assert other.status_code == 422 and other.json()["code"] == "idempotency-key-reused"


def test_run_without_a_clearinghouse_connection_writes_nothing(
        client: Any, practice: Practice) -> None:  # noqa: F811
    coverage = _insured(practice)
    refused = _run(client, coverage)
    assert refused.status_code == 503 and refused.json()["code"] == "service-unavailable"
    assert _count(practice, "eligibility_check") == 0
    assert _count(practice, "operation") == 0


def test_run_refusals(client: Any, practice: Practice) -> None:  # noqa: F811
    coverage = _insured(practice)
    _clearinghouse(practice)
    denied = _run(client, coverage, user="ma")
    assert denied.status_code == 403 and denied.json()["code"] == "permission-denied"
    keyless = client("fd").post(f"{API}/eligibility-checks", json={"coverageId": str(coverage)})
    assert keyless.status_code == 400 and keyless.json()["code"] == "idempotency-key-missing"
    invalid = _run(client, coverage, serviceTypeCodes=["thirty"])
    assert invalid.status_code == 422 and invalid.json()["code"] == "validation-failed"
    assert _run(client, coverage, user="fd-b").status_code == 404  # another clinic's coverage
    marcus = _today_appointment(practice, "marcus", hour=13)
    wrong = _run(client, coverage, marcus)
    assert wrong.status_code == 422 and wrong.json()["errors"][0]["pointer"] == "/appointmentId"
    elsewhere = _today_appointment(practice, facility=practice.other_facility, hour=14)
    assert _run(client, coverage, elsewhere).status_code == 404  # not the user's facility
    restricted = _run(client, _insured(practice, "restricted"))
    assert restricted.status_code == 403 and restricted.json()["code"] == "break-glass-required"
    _sql(practice, "UPDATE clinical.coverage SET status = 'cancelled' WHERE id = :c", c=coverage)
    ended = _run(client, coverage)
    assert ended.status_code == 422 and ended.json()["errors"][0]["pointer"] == "/coverageId"
    assert _count(practice, "eligibility_check") == 0


# ------------------------------------------------------------------ the 270 and the 271s
def test_the_270_and_the_active_reply_through_the_real_tables(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:  # noqa: F811
    coverage = _insured(practice)
    _clearinghouse(practice)
    appointment = _today_appointment(practice)
    operation = _run(client, coverage, appointment).json()
    check_id = _check_of(practice, operation["id"])

    async def build(db: AsyncSession) -> Any:  # in the worker's clinic session
        return await service.build_request(db, check_id, now=dt.datetime.now(dt.UTC))

    request = _in_clinic(practice, build).as_json()
    assert errors(REQUEST, request) == []
    payer_id = _sql(practice, "SELECT x.external_payer_id FROM admin.payer_clearinghouse_id x "
                    "JOIN clinical.coverage_payor p ON p.payer_id = x.payer_id "
                    "WHERE p.coverage_id = :c", c=coverage)[0][0]
    assert request["correlationId"] == str(check_id)
    assert request["payer"] == {"name": "Example Health Plan (synthetic)", "payerId": payer_id}
    assert request["subscriber"] == {"memberId": "TEST-MEMBER-042",
                                     "name": {"family": "Lindgren118", "given": ["Kaia401"]},
                                     "birthDate": "1984-03-09", "groupNumber": "TEST-GRP-7"}
    assert "dependent" not in request and request["serviceTypeCodes"] == ["30"]
    assert request["serviceDate"] == _local_today()

    async def file(db: AsyncSession) -> service.Filed:  # the receiver, naming the operation
        return await service.record_response(db, _reply("response-active-copay.json", check_id),
                                             operation_id=UUID(operation["id"]))

    filed = _in_clinic(practice, file, user=users["fd"])
    assert (filed.status, filed.duplicate) == ("active", False)
    got = client("fd").get(f"{API}/eligibility-checks/{check_id}")
    assert got.status_code == 200, got.text
    body = got.json()
    assert (body["status"], body["coverageStatus"], body["planName"]) == (
        "complete", "active", "Test PPO")
    assert body["copay"] == {"value": "25.00", "currency": "USD"}
    assert body["deductible"] == {"value": "1500.00", "currency": "USD"}
    assert body["deductibleRemainingAmount"] == {"value": "640.00", "currency": "USD"}
    assert len(body["benefits"]) == 9 and body["respondedAt"].startswith("2026-11-03T14:52:09")
    done = client("fd").get(f"{API}/operations/{operation['id']}").json()
    assert done["status"] == "succeeded"
    assert done["result"] == {"type": "eligibility-check", "id": str(check_id)}
    event = _sql(practice, "SELECT data, patient_id, facility_id FROM admin.event_log "
                 "WHERE type = 'eligibility.completed' AND tenant_id = :t", t=practice.clinic)
    assert [tuple(e) for e in event] == [({"appointmentId": appointment,
                                           "coverageStatus": "active"},
                                          practice.patients["kaia"], practice.facility)]
    listed = client("ma").get(f"{API}/appointments/{appointment}/eligibility-checks")
    assert [i["id"] for i in listed.json()["items"]] == [str(check_id)]

    async def again(db: AsyncSession) -> service.Filed:  # a second delivery changes nothing
        return await service.record_response(db, _reply("response-inactive.json", check_id))

    assert _in_clinic(practice, again).duplicate is True
    assert client("fd").get(f"{API}/eligibility-checks/{check_id}").json() == body


@pytest.mark.parametrize(("name", "status", "coverage_status", "error_code"), [
    ("response-inactive.json", "complete", "inactive", None),
    ("response-member-not-found.json", "complete", "unknown", None),
    ("response-payer-error.json", "error", None, "72"),
])
def test_each_recorded_reply_through_the_worker_session(
        client: Any, practice: Practice, name: str, status: str,  # noqa: F811
        coverage_status: str | None, error_code: str | None) -> None:
    coverage = _insured(practice)
    _clearinghouse(practice)
    check_id = _check_of(practice, _run(client, coverage).json()["id"])

    async def file(db: AsyncSession) -> service.Filed:
        return await service.record_response(db, _reply(name, check_id))

    assert _in_clinic(practice, file).duplicate is False
    body = client("adm").get(f"{API}/eligibility-checks/{check_id}").json()
    assert (body["status"], body.get("coverageStatus"), body.get("errorCode")) == (
        status, coverage_status, error_code)
    if error_code:
        assert body["errorMessage"] == "The payer reports an invalid member ID."
        stored = _sql(practice, "SELECT * FROM admin.eligibility_check WHERE id = :c", c=check_id)
        assert "Invalid/Missing" not in str(stored)  # the payer's own text is never kept


def test_a_reply_for_an_unknown_or_foreign_check_is_not_found(
        client: Any, practice: Practice) -> None:  # noqa: F811
    coverage = _insured(practice)
    _clearinghouse(practice)
    check_id = _check_of(practice, _run(client, coverage).json()["id"])

    async def unknown(db: AsyncSession) -> Any:
        return await service.record_response(db, _reply("response-inactive.json", uuid.uuid4()))

    with pytest.raises(NotFound):
        _in_clinic(practice, unknown)
    foreign = Practice(**{**practice.__dict__, "clinic": practice.clinic_b})

    async def theirs(db: AsyncSession) -> Any:
        return await service.record_response(db, _reply("response-inactive.json", check_id))

    with pytest.raises(NotFound):  # clinic B's session can't see clinic A's check
        _in_clinic(foreign, theirs)
    assert _sql(practice, "SELECT status FROM admin.eligibility_check WHERE id = :c",
                c=check_id)[0][0] == "pending"


def test_a_dead_lettered_270_times_out_and_a_late_answer_is_still_filed(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:  # noqa: F811
    coverage = _insured(practice)
    _clearinghouse(practice)
    operation = _run(client, coverage).json()
    check_id = _check_of(practice, operation["id"])

    async def time_out(db: AsyncSession) -> bool:
        return await service.mark_timed_out(db, check_id, operation_id=UUID(operation["id"]))

    assert _in_clinic(practice, time_out, user=users["fd"]) is True
    body = client("fd").get(f"{API}/eligibility-checks/{check_id}").json()
    assert (body["status"], body["errorCode"]) == ("error", "timeout")
    failed = client("fd").get(f"{API}/operations/{operation['id']}").json()
    assert failed["status"] == "failed" and failed["error"]["code"] == "upstream-timeout"
    assert _in_clinic(practice, time_out, user=users["fd"]) is False  # only from pending

    async def late(db: AsyncSession) -> service.Filed:
        return await service.record_response(db, _reply("response-inactive.json", check_id))

    assert _in_clinic(practice, late).status == "inactive"
    assert client("fd").get(f"{API}/eligibility-checks/{check_id}").json()["status"] == "complete"


def test_a_check_in_check_is_sendable(client: Any, practice: Practice) -> None:  # noqa: F811
    """Check-in queues its check (D15); its 270 is built at send time, with the appointment's
    provider's NPI stored with the check."""
    _insured(practice)
    _clearinghouse(practice)
    appointment = _today_appointment(practice)
    done = client("fd").post(f"{API}/appointments/{appointment}/check-in", json={},
                             headers=_key())
    assert done.status_code == 200, done.text
    check_id = UUID(done.json()["eligibilityCheckId"])

    async def build(db: AsyncSession) -> Any:
        return await service.build_request(db, check_id, now=dt.datetime.now(dt.UTC))

    request = _in_clinic(practice, build).as_json()
    assert errors(REQUEST, request) == [] and len(request["provider"]["npi"]) == 10
    assert request["serviceTypeCodes"] == ["30"]  # none stored: the default

    async def answered(db: AsyncSession) -> Any:
        await service.record_response(db, _reply("response-inactive.json", check_id))
        return await service.build_request(db, check_id, now=dt.datetime.now(dt.UTC))

    with pytest.raises(service.RequestNotBuildable) as refused:
        _in_clinic(practice, answered)
    assert refused.value.code == "check-not-pending"


# ----------------------------------------------------------------------------- the reads
def test_reads_are_this_clinics_and_respect_restricted_charts(
        client: Any, practice: Practice) -> None:  # noqa: F811
    coverage = _insured(practice, "restricted")
    _clearinghouse(practice)
    appointment = _today_appointment(practice, "restricted")
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:  # recorded directly, as check-in does: running one needs break-glass
        row = M["eligibility_check"](
            tenant_id=practice.clinic, coverage_id=coverage,
            patient_id=practice.patients["restricted"], appointment_id=UUID(appointment),
            trigger="check-in", clearinghouse="clearinghouse", status="pending",
            requested_at=dt.datetime.now(dt.UTC))
        db.add(row)
        db.flush()
        check_id = row.id
        db.commit()
    finally:
        db.close()
        admin.dispose()
    one = f"{API}/eligibility-checks/{check_id}"
    listed = f"{API}/appointments/{appointment}/eligibility-checks"
    for path in (one, listed):
        refused = client("fd").get(path)
        assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
        assert client("md-b").get(path).status_code == 404
        assert client("none").get(path).status_code == 403
    assert client("fd").get(f"{API}/eligibility-checks/{uuid.uuid4()}").status_code == 404
    assert client("fd").get(f"{API}/eligibility-checks/not-a-uuid").status_code == 422
    assert client("fd").get(listed, params={"limit": 0}).status_code == 422
