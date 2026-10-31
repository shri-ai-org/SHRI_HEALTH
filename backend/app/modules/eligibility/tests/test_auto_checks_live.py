"""The automatic checks (D15: booking, check-in, the pre-visit batch) against a live database, as
shri_app with only the sign-in replaced: the 270 goes into core's outbox in the booking's or the
check-in's own transaction (IDs only, no operation), a retry queues nothing, no clearinghouse
connection still books and checks in, and the batch queues only what is missing. Each recorded
synthetic 271 (contracts/partners/clearinghouse/examples/) is filed through ``record_response``
in the worker's clinic session. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.pool import NullPool

from app.core.deps import CurrentUser
from app.db.models import MAPPERS
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (fixtures)
    ZONE,
    Practice,
    client,
    local,
    practice,
    setup_session,
    users,
)
from app.modules.scheduling.tests.test_check_in_live import _sql
from app.modules.scheduling.tests.test_scheduling_live import _booking

from .. import partner, service
from ..repository import NOT_SENT
from .test_eligibility_live import (
    OPENBAO,
    _clearinghouse,
    _count,
    _in_clinic,
    _insured,
    _reply,
    _today_appointment,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
API = "/api/v1"
M = MAPPERS


def _key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _book(client: Any, practice: Practice, headers: dict[str, str] | None = None,  # noqa: F811
          **kw: Any) -> Any:
    return client("fd").post(f"{API}/appointments", json=_booking(practice, **kw),
                             headers=headers or {})


def _checks(practice: Practice, appointment: str) -> list[tuple[Any, ...]]:  # noqa: F811
    rows = _sql(practice, "SELECT id, trigger, status, error_code, integration_message_id, "
                "encounter_id FROM admin.eligibility_check WHERE appointment_id = :a "
                "ORDER BY requested_at, id", a=appointment)
    return [tuple(r) for r in rows]


def _message(practice: Practice, message_id: UUID) -> tuple[Any, ...]:  # noqa: F811
    return tuple(_sql(practice, "SELECT message_type, status, idempotency_key, payload "
                      "FROM admin.integration_message WHERE id = :m", m=message_id)[0])


def _appointment_on(practice: Practice, patient: str, day: dt.date,  # noqa: F811
                    hour: int) -> str:
    """A booked appointment written directly (so no booking check), at ``hour`` facility time."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        start = dt.datetime.combine(day, dt.time(hour), ZoneInfo(ZONE))
        appointment = M["appointment"](
            tenant_id=practice.clinic, status="booked", start=start,
            end=start + dt.timedelta(minutes=20), minutes_duration=20,
            subject_patient_id=practice.patients[patient],
            ext_appointment_type_id=practice.types["FU"], ext_facility_id=practice.facility)
        appointment.participant = [
            M["appointment_participant"](actor_patient_id=practice.patients[patient],
                                         status="accepted"),
            M["appointment_participant"](actor_practitioner_id=practice.provider,
                                         status="accepted")]
        db.add(appointment)
        db.flush()
        appointment_id = str(appointment.id)
        db.commit()
        return appointment_id
    finally:
        db.close()
        admin.dispose()


# ------------------------------------------------------------------------------------ booking
def test_booking_queues_one_check(client: Any, practice: Practice) -> None:  # noqa: F811
    coverage = _insured(practice)
    endpoint = _clearinghouse(practice)
    made = _book(client, practice)
    assert made.status_code == 201, made.text
    [(check_id, trigger, status, code, message_id, encounter)] = _checks(practice,
                                                                         made.json()["id"])
    assert (trigger, status, code, encounter) == ("booking", "pending", None, None)
    assert _sql(practice, "SELECT coverage_id, provider_npi IS NOT NULL FROM "
                "admin.eligibility_check WHERE id = :c", c=check_id)[0] == (coverage, True)
    assert _message(practice, message_id) == (
        "270", "queued", f"270:{check_id}", partner.outbox_payload(check_id, None))
    assert _sql(practice, "SELECT endpoint_id FROM admin.integration_message WHERE id = :m",
                m=message_id)[0][0] == endpoint
    assert _count(practice, "operation") == 0  # nobody waits on a 202 for it


def test_reschedule_queues_for_a_new_day_only(client: Any, practice: Practice) -> None:  # noqa: F811
    _insured(practice)
    _clearinghouse(practice)
    old = _book(client, practice).json()
    same_day = client("fd").post(f"{API}/appointments/{old['id']}/reschedule", json={
        "startAt": local(practice.day, 11), "reasonCode": "patient-request"})
    assert same_day.status_code == 201, same_day.text
    assert _checks(practice, same_day.json()["id"]) == []  # the day's check still answers
    next_day = client("fd").post(f"{API}/appointments/{same_day.json()['id']}/reschedule",
                                 json={"startAt": local(practice.day + dt.timedelta(days=1), 11),
                                       "reasonCode": "patient-request"})
    assert next_day.status_code == 201, next_day.text
    assert [c[1:4] for c in _checks(practice, next_day.json()["id"])] == [
        ("booking", "pending", None)]
    assert _count(practice, "integration_message") == 2


# ----------------------------------------------------------------------------------- check-in
def test_check_in_queues_one_and_the_answer_shows_copay_and_deductible(
        client: Any, practice: Practice) -> None:  # noqa: F811
    _insured(practice)
    _clearinghouse(practice)
    appointment = _today_appointment(practice)
    done = client("fd").post(f"{API}/appointments/{appointment}/check-in", json={},
                             headers=_key())
    assert done.status_code == 200, done.text
    check_id = UUID(done.json()["eligibilityCheckId"])
    [(found, trigger, status, _, message_id, encounter)] = _checks(practice, appointment)
    assert (found, trigger, status) == (check_id, "check-in", "pending")
    assert encounter == UUID(done.json()["encounterId"])
    assert _message(practice, message_id)[2:] == (
        f"270:{check_id}", {"eligibilityCheckId": str(check_id)})

    async def file(db: AsyncSession) -> service.Filed:  # the receiver, in the worker's session
        return await service.record_response(db, _reply("response-active-copay.json", check_id))

    assert _in_clinic(practice, file).status == "active"
    got = client("fd").get(f"{API}/eligibility-checks/{check_id}")
    assert got.status_code == 200, got.text
    body = got.json()
    assert (body["status"], body["coverageStatus"], body["trigger"]) == (
        "complete", "active", "check-in")
    assert body["copay"] == {"value": "25.00", "currency": "USD"}
    assert body["deductible"] == {"value": "1500.00", "currency": "USD"}
    assert body["deductibleRemainingAmount"] == {"value": "640.00", "currency": "USD"}


@OPENBAO
def test_a_retried_booking_or_check_in_queues_none(client: Any, practice: Practice) -> None:  # noqa: F811
    _insured(practice)
    _clearinghouse(practice)
    key = _key()
    first = _book(client, practice, headers=key)
    assert first.status_code == 201, first.text
    again = _book(client, practice, headers=key)
    assert again.status_code == 201 and again.headers["Idempotent-Replayed"] == "true"
    assert len(_checks(practice, first.json()["id"])) == 1
    appointment = _today_appointment(practice)
    key = _key()
    checked = client("fd").post(f"{API}/appointments/{appointment}/check-in", json={},
                                headers=key)
    assert checked.status_code == 200, checked.text
    replayed = client("fd").post(f"{API}/appointments/{appointment}/check-in", json={},
                                 headers=key)
    assert replayed.status_code == 200 and replayed.headers["Idempotent-Replayed"] == "true"
    assert replayed.json()["eligibilityCheckId"] == checked.json()["eligibilityCheckId"]
    assert len(_checks(practice, appointment)) == 1
    assert _count(practice, "eligibility_check") == 2
    assert _count(practice, "integration_message") == 2


# ------------------------------------------------------------------- no clearinghouse connection
def test_no_connection_still_books_and_checks_in(client: Any, practice: Practice) -> None:  # noqa: F811
    _insured(practice)
    made = _book(client, practice)
    assert made.status_code == 201, made.text
    [(check_id, trigger, status, code, message_id, _)] = _checks(practice, made.json()["id"])
    assert (trigger, status, code, message_id) == ("booking", "error", NOT_SENT, None)
    shown = client("fd").get(f"{API}/eligibility-checks/{check_id}").json()
    assert (shown["status"], shown["errorCode"], shown["errorMessage"]) == (
        "error", NOT_SENT, service.NOT_SENT_MESSAGE)
    assert "respondedAt" not in shown and "coverageStatus" not in shown
    appointment = _today_appointment(practice)
    done = client("fd").post(f"{API}/appointments/{appointment}/check-in", json={},
                             headers=_key())
    assert done.status_code == 200, done.text
    assert _checks(practice, appointment)[0][1:4] == ("check-in", "error", NOT_SENT)
    assert _count(practice, "integration_message") == 0
    self_pay = _today_appointment(practice, "marcus", hour=13)  # no coverage: nothing recorded
    paid = client("fd").post(f"{API}/appointments/{self_pay}/check-in", json={"selfPay": True},
                             headers=_key())
    assert paid.status_code == 200 and "eligibilityCheckId" not in paid.json()
    assert _checks(practice, self_pay) == []


# ---------------------------------------------------------------------------- the pre-visit batch
def test_the_batch_queues_only_the_missing_ones(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:  # noqa: F811
    """Run in a user's clinic session: the job's own system session waits on core (see the next
    test)."""
    _insured(practice)  # kaia: booked through the API, so her check is fresh
    _insured(practice, "marcus")  # marcus: written directly, no check yet
    _clearinghouse(practice)
    booked = _book(client, practice).json()["id"]
    missing = _appointment_on(practice, "marcus", practice.day, 10)
    self_pay = _appointment_on(practice, "restricted", practice.day, 11)  # no coverage
    _appointment_on(practice, "marcus", practice.day + dt.timedelta(days=1), 10)  # another day
    now = dt.datetime.now(dt.UTC)

    async def batch(db: AsyncSession) -> service.BatchResult:
        return await service.queue_pre_visit_checks(db, for_date=practice.day, now=now)

    assert _in_clinic(practice, batch, user=users["adm"]) == service.BatchResult(
        queued=1, fresh=1, no_coverage=1)
    [(check_id, trigger, status, _, message_id, _)] = _checks(practice, missing)
    assert (trigger, status) == ("pre-visit-batch", "pending")
    assert _message(practice, message_id)[2:] == (
        f"270:{check_id}", {"eligibilityCheckId": str(check_id)})
    assert [c[1] for c in _checks(practice, booked)] == ["booking"]
    assert _checks(practice, self_pay) == []

    assert _in_clinic(practice, batch, user=users["adm"]) == service.BatchResult(
        already_queued=1, fresh=1, no_coverage=1)  # idempotent per appointment and day
    assert _count(practice, "eligibility_check") == 2
    assert _count(practice, "integration_message") == 2


@pytest.mark.xfail(strict=True, raises=ValueError,
                   reason="core: session_user_id() reads the system session's empty user as a "
                          "UUID, so enqueue() fails outside a user's session (app/core/db.py:118)")
def test_the_batch_in_the_jobs_system_session(practice: Practice) -> None:  # noqa: F811
    """How the job runner will call it: one clinic's system session, no user. Passes once core's
    session_user_id returns None for an empty user."""
    _insured(practice, "marcus")
    _clearinghouse(practice)
    _appointment_on(practice, "marcus", practice.day, 10)
    now = dt.datetime.now(dt.UTC)

    async def batch(db: AsyncSession) -> service.BatchResult:
        return await service.queue_pre_visit_checks(db, for_date=practice.day, now=now)

    assert _in_clinic(practice, batch) == service.BatchResult(queued=1)
