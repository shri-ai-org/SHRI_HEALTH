"""The automatic checks (D15: booking, the pre-visit batch, check-in) on the in-memory fakes:
what each queues, that a retry queues nothing, and that nothing they meet (no coverage, a type
that runs no checks, no clearinghouse connection) ever raises. test_auto_checks_live.py runs the
same paths on the real tables. Synthetic data only."""

from __future__ import annotations

from datetime import date, timedelta
from uuid import UUID, uuid4

import pytest

from app.core.errors import NotFound

from .. import service
from ..repository import NOT_SENT
from .fakes import NOW, FakePartner, FakeRepository, FakeSession, World

CLINIC, OTHER_CLINIC, FACILITY = uuid4(), uuid4(), uuid4()
TOMORROW = date(2026, 11, 4)


async def _queue(world: World, appointment_id: UUID, trigger: str = "booking", *,
                 encounter_id: UUID | None = None,
                 coverage_id: UUID | None = None) -> service.AutoCheck:
    return await service.queue_for_appointment(
        FakeSession(CLINIC), appointment_id, trigger=trigger,  # type: ignore[arg-type]
        encounter_id=encounter_id, coverage_id=coverage_id, repo=FakeRepository(world),
        partner=FakePartner(world))


def _insured(world: World, day: date = date(2026, 11, 3)) -> tuple[UUID, UUID]:
    patient = world.patient(CLINIC)
    coverage = world.coverage(CLINIC, patient)
    return coverage, world.appointment(CLINIC, patient, FACILITY, day=day)


async def test_booking_queues_one_check_without_an_operation() -> None:
    world = World()
    coverage, appointment = _insured(world)
    done = await _queue(world, appointment)
    assert done.outcome == "queued" and done.check_id is not None
    assert world.sent == [(done.check_id, None)]  # no operation: nobody waits on a 202
    assert world.operations == []
    _, row = world.checks[done.check_id]
    assert (row.trigger, row.status, row.coverage_id, row.appointment_id) == (
        "booking", "pending", coverage, appointment)
    assert world.service_types[done.check_id] == ("30",)
    assert world.npis[done.check_id] == "1234567893"  # the appointment's provider
    assert done.check_id in world.linked
    assert world.locks == [appointment]


async def test_a_retry_queues_none() -> None:
    world = World()
    _, appointment = _insured(world)
    first = await _queue(world, appointment)
    again = await _queue(world, appointment)
    assert again == service.AutoCheck("already-queued", first.check_id)
    assert len(world.checks) == 1 and len(world.sent) == 1


async def test_check_in_queues_one_per_encounter() -> None:
    world = World()
    coverage, appointment = _insured(world)
    booked = await _queue(world, appointment)
    encounter = uuid4()
    checked_in = await _queue(world, appointment, "check-in", encounter_id=encounter,
                        coverage_id=coverage)
    assert checked_in.outcome == "queued" and checked_in.check_id != booked.check_id
    assert world.encounter_of[checked_in.check_id] == encounter  # type: ignore[index]
    retried = await _queue(world, appointment, "check-in", encounter_id=encounter,
                     coverage_id=coverage)
    assert retried.outcome == "already-queued"
    again = await _queue(world, appointment, "check-in", encounter_id=uuid4(),
                         coverage_id=coverage)
    assert again.outcome == "queued"  # checked in again after an undo: a new encounter (D55)
    assert len(world.sent) == 3


async def test_no_connection_records_the_check_as_not_sent() -> None:
    world = World(connected=False)
    _, appointment = _insured(world)
    done = await _queue(world, appointment)
    assert done.outcome == "not-sent" and world.sent == []
    _, row = world.checks[done.check_id]  # type: ignore[index]
    assert (row.status, row.error_code, row.error_message) == (
        "error", NOT_SENT, service.NOT_SENT_MESSAGE)
    shown = service.to_contract(row)
    assert (shown.status, shown.error_code, shown.responded_at) == ("error", NOT_SENT, None)
    assert done.check_id not in world.linked
    assert (await _queue(world, appointment)).outcome == "already-queued"  # still once


async def test_no_coverage_and_types_without_checks_record_nothing() -> None:
    world = World()
    self_pay = world.appointment(CLINIC, world.patient(CLINIC), FACILITY)
    assert await _queue(world, self_pay) == service.AutoCheck("no-coverage")
    ended_patient = world.patient(CLINIC)
    world.coverage(CLINIC, ended_patient, end=date(2026, 10, 1))  # ended before the visit
    ended = world.appointment(CLINIC, ended_patient, FACILITY)
    assert (await _queue(world, ended)).outcome == "no-coverage"
    _, phone_call = _insured(world)
    world.not_required.add(phone_call)
    assert await _queue(world, phone_call) == service.AutoCheck("not-required")
    assert world.checks == {} and world.sent == []


async def test_only_automatic_triggers() -> None:
    world = World()
    _, appointment = _insured(world)
    with pytest.raises(ValueError, match="automatic"):
        await _queue(world, appointment, "manual")


async def test_another_clinics_appointment_is_not_found() -> None:
    world = World()
    patient = world.patient(OTHER_CLINIC)
    world.coverage(OTHER_CLINIC, patient)
    theirs = world.appointment(OTHER_CLINIC, patient, FACILITY)
    with pytest.raises(NotFound):
        await _queue(world, theirs)


# ------------------------------------------------------------------------- the pre-visit batch
async def _batch(world: World, day: date = TOMORROW) -> service.BatchResult:
    return await service.queue_pre_visit_checks(
        FakeSession(CLINIC), for_date=day, now=NOW,  # type: ignore[arg-type]
        repo=FakeRepository(world), partner=FakePartner(world))


async def test_the_batch_queues_only_the_missing_ones() -> None:
    world = World()
    _, missing = _insured(world, TOMORROW)
    fresh_cov, fresh = _insured(world, TOMORROW)
    world.check(CLINIC, fresh_cov, fresh, minutes_ago=60)  # pending, asked an hour ago
    answered_cov, answered = _insured(world, TOMORROW)
    world.check(CLINIC, answered_cov, answered, status="active", minutes_ago=120)
    stale_cov, stale = _insured(world, TOMORROW)
    world.check(CLINIC, stale_cov, stale, status="active", minutes_ago=25 * 60)  # expired
    failed_cov, failed = _insured(world, TOMORROW)
    world.check(CLINIC, failed_cov, failed, status="error", minutes_ago=30)  # not fresh
    self_pay = world.appointment(CLINIC, world.patient(CLINIC), FACILITY, day=TOMORROW)
    _insured(world, TOMORROW + timedelta(days=1))  # another day
    _, cancelled = _insured(world, TOMORROW)
    world.cancelled.add(cancelled)
    before = set(world.checks)

    result = await _batch(world)
    assert result == service.BatchResult(queued=3, fresh=2, no_coverage=1)
    added = {world.checks[c][1].appointment_id for c in set(world.checks) - before}
    assert added == {missing, stale, failed}
    assert {world.checks[c][1].trigger for c in set(world.checks) - before} == {
        "pre-visit-batch"}
    assert self_pay not in added

    again = await _batch(world)
    assert again == service.BatchResult(already_queued=3, fresh=2, no_coverage=1)
    assert len(world.sent) == 3  # idempotent per appointment and day


async def test_the_batch_without_a_connection_never_raises() -> None:
    world = World(connected=False)
    _insured(world, TOMORROW)
    _insured(world, TOMORROW)
    assert await _batch(world) == service.BatchResult(not_sent=2)
    assert await _batch(world) == service.BatchResult(already_queued=2)  # not re-recorded nightly
    assert {r.error_code for _, r in world.checks.values()} == {NOT_SENT}
