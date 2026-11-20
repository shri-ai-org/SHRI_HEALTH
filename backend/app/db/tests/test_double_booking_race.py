"""One slot, one patient, under concurrency: two real connections race for one practitioner slot.

The guarantee is the database's, not the service's. ``ex_appointment_participant_no_double_booking``
(``EXCLUDE USING gist (actor_practitioner_id WITH =, tstzrange(period_start, period_end) WITH &&)
WHERE (ext_blocking)``) refuses an overlapping blocking row with SQLSTATE 23P01, which
``app.db.errors`` maps to 409. ``ext_blocking`` and the period are never taken from the writer:
``trg_appointment_participant_sync`` (BEFORE INSERT OR UPDATE on the participant) copies them from
the appointment, and ``trg_appointment_sync`` (AFTER UPDATE OF start, end, status, ext_overbook,
ext_appointment_type_id on the appointment) touches the participants so they are recomputed.
The scheduling repository's per-day ``pg_advisory_xact_lock`` only serializes its own callers;
these tests don't take it, so they show what holds without it.

Each test uses two sessions on two connections (``shri_app``, RLS on, same clinic): transaction A
writes and stays open, transaction B writes from a worker thread, and the test checks from a
superuser connection whether B is waiting on A (``pg_blocking_pids``) before A ends. B runs with
a ``lock_timeout`` and every wait is bounded, so a regression fails instead of hanging.

Synthetic data only.
"""
from __future__ import annotations

import datetime as dt
import time
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.db.errors import db_error_detail
from app.db.models import MAPPERS
from app.db.tests import builders as b
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, open_session

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS
CONSTRAINT = "ex_appointment_participant_no_double_booking"
SLOT = b.NOW                       # 14:00 UTC; every booking below is 30 minutes
HALF = dt.timedelta(minutes=30)
QUARTER = dt.timedelta(minutes=15)
WAIT_S = 10.0                      # longest the test waits for B to block or to finish
LOCK_TIMEOUT = "20s"               # B gives up on its own after this, so nothing can hang


# =========================================================================== fixtures / helpers
@pytest.fixture
def clinic(app_engine: Engine, tenant: uuid.UUID) -> dict[str, uuid.UUID]:
    """A committed practice: two practitioners, three patients, and an appointment type that
    allows overlap. Committed, so both racing connections see it."""
    s = open_session(app_engine, tenant)
    try:
        ctx = b.practice(s)
        dr2 = b.practitioner(s, "Okafor", "Sam")
        p1 = b.patient(s, "Nguyen", "Mai")
        p2 = b.patient(s, "Silva", "Ana")
        p3 = b.patient(s, "Kowalski", "Jan")
        group = M["appointment_type"](tenant_id=tenant, code="GROUP", name="Group session",
                                      allow_overlap=True)
        s.add(group)
        s.flush()
        ids = {"dr1": ctx["practitioner"].id, "dr2": dr2["practitioner"].id,
               "p1": p1.id, "p2": p2.id, "p3": p3.id, "group": group.id}
        s.commit()
        return ids
    finally:
        s.close()


@pytest.fixture
def pair(app_engine: Engine, tenant: uuid.UUID) -> Iterator[tuple[Session, Session]]:
    """Two sessions, two connections, one clinic."""
    sessions = [open_session(app_engine, tenant) for _ in range(2)]
    for s in sessions:
        s.execute(text(f"SET lock_timeout = '{LOCK_TIMEOUT}'"))
    yield sessions[0], sessions[1]
    for s in sessions:
        s.rollback()
        conn = s.bind
        s.close()
        conn.close()  # type: ignore[union-attr]


@pytest.fixture
def worker() -> Iterator[ThreadPoolExecutor]:
    pool = ThreadPoolExecutor(max_workers=1)
    yield pool
    pool.shutdown(wait=True)


def book(s: Session, patient_id: uuid.UUID, practitioner_id: uuid.UUID, start: dt.datetime,
         *, status: str = "booked", participant_status: str = "accepted",
         ext_blocking: bool | None = None, **kw: Any) -> uuid.UUID:
    """An appointment with its patient and practitioner participants, flushed (not committed)."""
    extra = {} if ext_blocking is None else {"ext_blocking": ext_blocking}
    a = M["appointment"](status=status, subject_patient_id=patient_id, start=start,
                         end=start + HALF, minutes_duration=30, **kw)
    a.participant = [
        M["appointment_participant"](actor_patient_id=patient_id, required="required",
                                     status="accepted"),
        M["appointment_participant"](actor_practitioner_id=practitioner_id, required="required",
                                     status=participant_status, **extra)]
    s.add(a)
    s.flush()
    appointment_id: uuid.UUID = a.id
    return appointment_id


def appointment(s: Session, appointment_id: uuid.UUID) -> Any:
    row = s.get(M["appointment"], appointment_id)
    assert row is not None
    return row


def backend_pid(s: Session) -> int:
    pid: int = s.execute(text("SELECT pg_backend_pid()")).scalar_one()
    return pid


def wait_until_blocked(admin_engine: Engine, waiter: int, holder: int, fut: Future[Any]) -> str:
    """Waits until backend ``waiter`` is blocked by backend ``holder``; returns the lock type it
    waits on. Fails if the waiter finishes first or never blocks."""
    deadline = time.monotonic() + WAIT_S
    while time.monotonic() < deadline:
        if fut.done():
            fut.result()           # re-raises the waiter's error, if any
            raise AssertionError("B finished without waiting for A")
        with admin_engine.connect() as c:
            row = c.execute(text(
                "SELECT :h = ANY(pg_blocking_pids(:w)), "
                "(SELECT locktype FROM pg_locks WHERE pid = :w AND NOT granted LIMIT 1)"),
                {"h": holder, "w": waiter}).one()
        if row[0]:
            return str(row[1])
        time.sleep(0.02)
    raise AssertionError(f"B never blocked on A within {WAIT_S}s")


def assert_double_booking(exc: BaseException) -> None:
    assert isinstance(exc, DBAPIError), f"expected 23P01, got {exc!r}"
    detail = db_error_detail(exc)
    assert (detail.sqlstate, detail.constraint, detail.status) == ("23P01", CONSTRAINT, 409), \
        detail


def run(worker: ThreadPoolExecutor, fn: Callable[[], Any]) -> Future[Any]:
    return worker.submit(fn)


def blocking_rows(app_engine: Engine, tenant: uuid.UUID, practitioner_id: uuid.UUID,
                  start: dt.datetime, end: dt.datetime) -> list[uuid.UUID]:
    """Patients of the committed appointments whose practitioner row blocks [start, end)."""
    s = open_session(app_engine, tenant)
    try:
        return list(s.execute(text(
            "SELECT a.subject_patient_id FROM appointment_participant x "
            "JOIN appointment a ON a.id = x.appointment_id "
            "WHERE x.actor_practitioner_id = :d AND x.ext_blocking "
            "AND tstzrange(x.period_start, x.period_end) && tstzrange(:s, :e)"),
            {"d": practitioner_id, "s": start, "e": end}).scalars())
    finally:
        s.close()


# =========================================================================== 1. the race
@pytest.mark.parametrize("status", ["booked", "pending", "arrived", "checked-in"])
def test_two_bookings_for_one_slot_exactly_one_commits(
        app_engine: Engine, admin_engine: Engine, tenant: uuid.UUID,
        clinic: dict[str, uuid.UUID], pair: tuple[Session, Session],
        worker: ThreadPoolExecutor, status: str) -> None:
    """A books patient 1 with Dr 1 at 14:00 and stays open; B books patient 2 with Dr 1 at
    14:15. B's insert waits on A's transaction (the exclusion check found A's uncommitted row),
    not on any lock the service takes. A commits, so B fails with 23P01 on the named constraint
    (409), and only patient 1 holds the slot. Every active status blocks."""
    a, b_ = pair
    pid_a, pid_b = backend_pid(a), backend_pid(b_)
    book(a, clinic["p1"], clinic["dr1"], SLOT, status=status)
    fut = run(worker, lambda: book(b_, clinic["p2"], clinic["dr1"], SLOT + QUARTER))
    assert wait_until_blocked(admin_engine, pid_b, pid_a, fut) == "transactionid"
    a.commit()
    with pytest.raises(DBAPIError) as err:
        fut.result(timeout=WAIT_S)
    assert_double_booking(err.value)
    b_.rollback()
    assert blocking_rows(app_engine, tenant, clinic["dr1"], SLOT, SLOT + QUARTER + HALF) \
        == [clinic["p1"]]


def test_the_waiting_booking_goes_through_when_the_first_rolls_back(
        app_engine: Engine, admin_engine: Engine, tenant: uuid.UUID,
        clinic: dict[str, uuid.UUID], pair: tuple[Session, Session],
        worker: ThreadPoolExecutor) -> None:
    """Same race, but A rolls back: B was waiting on A's outcome, so it now succeeds and
    commits, and patient 2 holds the slot. Exactly one of the two still commits."""
    a, b_ = pair
    pid_a, pid_b = backend_pid(a), backend_pid(b_)
    book(a, clinic["p1"], clinic["dr1"], SLOT)
    fut = run(worker, lambda: book(b_, clinic["p2"], clinic["dr1"], SLOT + QUARTER))
    assert wait_until_blocked(admin_engine, pid_b, pid_a, fut) == "transactionid"
    a.rollback()
    fut.result(timeout=WAIT_S)
    b_.commit()
    assert blocking_rows(app_engine, tenant, clinic["dr1"], SLOT, SLOT + QUARTER + HALF) \
        == [clinic["p2"]]


def test_the_writer_cannot_opt_out_of_blocking(
        admin_engine: Engine, clinic: dict[str, uuid.UUID], pair: tuple[Session, Session],
        worker: ThreadPoolExecutor) -> None:
    """``ext_blocking`` is derived, not trusted: B sends ``ext_blocking=false`` on an active,
    accepted practitioner row, the trigger sets it back to true, and B still loses the race."""
    a, b_ = pair
    pid_a, pid_b = backend_pid(a), backend_pid(b_)
    book(a, clinic["p1"], clinic["dr1"], SLOT)
    fut = run(worker, lambda: book(b_, clinic["p2"], clinic["dr1"], SLOT + QUARTER,
                                   ext_blocking=False))
    wait_until_blocked(admin_engine, pid_b, pid_a, fut)
    a.commit()
    with pytest.raises(DBAPIError) as err:
        fut.result(timeout=WAIT_S)
    assert_double_booking(err.value)


# =========================================================================== 2. no false conflicts
NO_CONFLICT: dict[str, tuple[str, dt.timedelta, dict[str, Any]]] = {
    # name: (practitioner, start offset, extra book() arguments)
    "touching-after": ("dr1", HALF, {}),
    "touching-before": ("dr1", -HALF, {}),
    "other-practitioner": ("dr2", dt.timedelta(0), {}),
    "declined-participant": ("dr1", QUARTER, {"participant_status": "declined"}),
    "overbook": ("dr1", QUARTER, {"ext_overbook": True}),
    "type-allows-overlap": ("dr1", QUARTER, {"ext_appointment_type_id": "group"}),
    "proposed": ("dr1", QUARTER, {"status": "proposed"}),
    "waitlist": ("dr1", QUARTER, {"status": "waitlist"}),
}


@pytest.mark.parametrize("case", list(NO_CONFLICT))
def test_non_overlapping_or_non_blocking_bookings_both_commit(
        app_engine: Engine, tenant: uuid.UUID, clinic: dict[str, uuid.UUID],
        pair: tuple[Session, Session], worker: ThreadPoolExecutor, case: str) -> None:
    """A books Dr 1 at 14:00-14:30 and stays open. B's booking finishes while A is still open
    (so nothing made it wait on A) and both commit: periods are half-open, so 14:30 touches but
    doesn't overlap; another practitioner is another key; a declined participant, an overbook,
    a type that allows overlap, and a proposed or waitlisted appointment don't block. Only A's
    row blocks afterwards."""
    who, offset, extra = NO_CONFLICT[case]
    kw: dict[str, Any] = {k: clinic[v] if k == "ext_appointment_type_id" else v
                          for k, v in extra.items()}
    a, b_ = pair
    book(a, clinic["p1"], clinic["dr1"], SLOT)
    fut = run(worker, lambda: book(b_, clinic["p2"], clinic[who], SLOT + offset, **kw))
    fut.result(timeout=WAIT_S)          # A is still open here
    a.commit()
    b_.commit()
    window = (SLOT - HALF, SLOT + 2 * HALF)
    dr1 = blocking_rows(app_engine, tenant, clinic["dr1"], *window)
    if case.startswith("touching"):
        assert sorted(map(str, dr1)) == sorted(map(str, [clinic["p1"], clinic["p2"]]))
    else:
        assert dr1 == [clinic["p1"]]
    if who == "dr2":
        assert blocking_rows(app_engine, tenant, clinic["dr2"], *window) == [clinic["p2"]]


# =========================================================================== 3. cancellation
@pytest.mark.parametrize("ending", ["cancelled", "noshow"])
def test_a_cancel_frees_the_slot_only_when_it_commits(
        app_engine: Engine, admin_engine: Engine, tenant: uuid.UUID,
        clinic: dict[str, uuid.UUID], pair: tuple[Session, Session],
        worker: ThreadPoolExecutor, ending: str) -> None:
    """What the database guarantees on cancel: the scheduling service's ``cancel()`` only sets
    the appointment's status (and reason/time); it never touches ``ext_blocking``. The DB clears
    it: ``trg_appointment_sync`` fires on the status change and the participant trigger
    recomputes ``ext_blocking`` as false for any status outside booked / arrived / checked-in /
    pending, so the row leaves the constraint's ``WHERE (ext_blocking)``. The participant keeps
    its practitioner and period. A no-show frees the slot the same way.

    Under concurrency the slot is freed only at commit: while A's cancel is open, B's booking of
    the same slot waits on A; A commits and B goes through. Reinstating the cancelled
    appointment (status back to booked) is then refused with 23P01, because the same triggers
    make the row blocking again."""
    a, b_ = pair
    first = book(a, clinic["p1"], clinic["dr1"], SLOT)
    a.commit()
    pid_a, pid_b = backend_pid(a), backend_pid(b_)
    row = appointment(a, first)
    row.status, row.ext_cancelled_at = ending, b.NOW
    a.flush()
    assert a.execute(text("SELECT ext_blocking FROM appointment_participant WHERE "
                          "appointment_id = :a AND actor_practitioner_id IS NOT NULL"),
                     {"a": first}).scalar_one() is False
    fut = run(worker, lambda: book(b_, clinic["p2"], clinic["dr1"], SLOT + QUARTER))
    assert wait_until_blocked(admin_engine, pid_b, pid_a, fut) == "transactionid"
    a.commit()
    fut.result(timeout=WAIT_S)
    b_.commit()
    assert blocking_rows(app_engine, tenant, clinic["dr1"], SLOT, SLOT + QUARTER + HALF) \
        == [clinic["p2"]]

    row = appointment(a, first)
    row.status, row.ext_cancelled_at = "booked", None
    with pytest.raises(DBAPIError) as err:
        a.flush()
    assert_double_booking(err.value)


def test_a_cancel_that_rolls_back_keeps_the_slot(
        admin_engine: Engine, clinic: dict[str, uuid.UUID], pair: tuple[Session, Session],
        worker: ThreadPoolExecutor) -> None:
    """A cancels and rolls back: B, which waited on A, finds the original booking still
    blocking and fails with 23P01."""
    a, b_ = pair
    first = book(a, clinic["p1"], clinic["dr1"], SLOT)
    a.commit()
    pid_a, pid_b = backend_pid(a), backend_pid(b_)
    row = appointment(a, first)
    row.status, row.ext_cancelled_at = "cancelled", b.NOW
    a.flush()
    fut = run(worker, lambda: book(b_, clinic["p2"], clinic["dr1"], SLOT + QUARTER))
    wait_until_blocked(admin_engine, pid_b, pid_a, fut)
    a.rollback()
    with pytest.raises(DBAPIError) as err:
        fut.result(timeout=WAIT_S)
    assert_double_booking(err.value)


# =========================================================================== 4. a gap
def add_practitioner(s: Session, appointment_id: uuid.UUID, practitioner_id: uuid.UUID) -> None:
    s.add(M["appointment_participant"](appointment_id=appointment_id,
                                       actor_practitioner_id=practitioner_id,
                                       required="required", status="accepted"))
    s.flush()


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=(
    "GAP: shri_participant_sync (BEFORE INSERT) reads the appointment without locking it, so a "
    "practitioner row inserted while another transaction moves or reinstates the appointment "
    "copies the old period/status. The insert then waits on the appointment row only in "
    "trg_appointment_participant_touch (AFTER INSERT), after the stale values are set, and "
    "that touch updates meta_last_updated only, so trg_appointment_sync never recomputes the "
    "row. Not reachable through the scheduling service today: it never moves or reinstates an "
    "appointment in place, and adds only location participants to an existing one."))
@pytest.mark.parametrize("change", ["move", "reinstate"])
def test_a_practitioner_added_while_the_appointment_changes_stays_in_step(
        app_engine: Engine, admin_engine: Engine, tenant: uuid.UUID,
        clinic: dict[str, uuid.UUID], pair: tuple[Session, Session],
        worker: ThreadPoolExecutor, change: str) -> None:
    """The invariant behind the constraint: a practitioner row's period and ``ext_blocking``
    always match its appointment. A changes appointment X (moves it from 14:00 to 16:00, or
    reinstates it from cancelled to booked) and stays open; B adds Dr 2 to X and waits on A; A
    commits, then B. Then Dr 2 must be blocked at X's real time, so a booking of Dr 2 for
    another patient at that time must be refused. Today B's row keeps X's old period / status,
    Dr 2 is free at 16:00 (or, for the reinstated appointment, not blocking at all), and the
    second booking commits: Dr 2 is booked twice for one slot."""
    a, b_ = pair
    cancelled: dict[str, Any] = ({"status": "cancelled", "ext_cancelled_at": b.NOW}
                                 if change == "reinstate" else {})
    first = book(a, clinic["p1"], clinic["dr1"], SLOT, **cancelled)
    a.commit()
    pid_a, pid_b = backend_pid(a), backend_pid(b_)
    row = appointment(a, first)
    if change == "move":
        row.start, row.end = SLOT + 4 * HALF, SLOT + 5 * HALF
    else:
        row.status, row.ext_cancelled_at = "booked", None
    a.flush()
    fut = run(worker, lambda: add_practitioner(b_, first, clinic["dr2"]))
    wait_until_blocked(admin_engine, pid_b, pid_a, fut)   # on the touch of X, after the copy
    a.commit()
    fut.result(timeout=WAIT_S)
    b_.commit()

    s = open_session(app_engine, tenant)
    try:
        drift = s.execute(text(
            "SELECT count(*) FROM appointment_participant x JOIN appointment a "
            "ON a.id = x.appointment_id WHERE x.actor_practitioner_id = :d "
            "AND (x.period_start IS DISTINCT FROM a.start OR NOT x.ext_blocking)"),
            {"d": clinic["dr2"]}).scalar_one()
        start = appointment(s, first).start
        try:
            book(s, clinic["p3"], clinic["dr2"], start)
            s.commit()
            second_booking: BaseException | None = None
        except DBAPIError as exc:
            second_booking = exc
            s.rollback()
    finally:
        s.close()
    # Both facts in one assertion, so a failure shows the drift and the double booking together.
    assert {"rows out of step": drift, "second booking committed": second_booking is None} \
        == {"rows out of step": 0, "second booking committed": False}
    assert second_booking is not None
    assert_double_booking(second_booking)
