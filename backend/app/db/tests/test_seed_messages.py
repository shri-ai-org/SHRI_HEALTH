"""Linda Thompson's secure-message threads (app.db.seed.messages), against a real database: the
rows as the portal stores them, a second run that changes nothing, what the portal's role and
the staff's role read through 0031's functions, and the reset that restores them. Synthetic data
only."""
from __future__ import annotations

import datetime as dt
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session

from app.core.deps import CLINIC_A, FACILITY_A
from app.db.seed import demo, messages, reset
from app.db.seed.starter import sid
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE
from app.db.tests.test_portal_access import portal_engine
from app.db.tests.test_seed import migrator_engine

__all__ = ["migrator_engine", "portal_engine"]       # fixtures, used by name
LINDA = sid(demo.PATIENT, 3)
NOTE = messages.THREADS[2].messages[1]               # demo.doctor's note to the assistant
ROWS = {"work_item": "SELECT * FROM admin.work_item WHERE id = ANY(:ids) ORDER BY id",
        "work_item_event": "SELECT * FROM admin.work_item_event WHERE work_item_id = ANY(:ids) "
                           "ORDER BY id",
        "work_item_reply": "SELECT * FROM admin.work_item_reply WHERE work_item_id = ANY(:ids) "
                           "ORDER BY id"}


def _seeded(migrator_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(demo, "POPULATION_SIZE", 5)
    with Session(migrator_engine) as db, db.begin():
        demo.load_demo(db)
    messages.run(migrator_engine)


def _rows(admin_engine: Engine) -> dict[str, list[Any]]:
    ids = list(messages.thread_ids())
    with admin_engine.connect() as c:
        return {table: list(c.execute(text(sql), {"ids": ids}).all())
                for table, sql in ROWS.items()}


def _as_linda(c: Connection) -> Connection:
    c.execute(text("SELECT set_config('app.current_tenant_id', :t, true), "
                   "set_config('app.current_patient_id', :p, true)"),
              {"t": str(CLINIC_A), "p": str(LINDA)})
    return c


def test_three_threads_answered_unanswered_and_with_a_staff_note() -> None:
    """The table itself: Linda's own messages always reach her, only thread 3 has a staff
    note, every message is short and synthetic, and each thread runs forward in time."""
    day = dt.date(2026, 11, 20)
    assert [len(t.messages) for t in messages.THREADS] == [2, 1, 3]
    assert [m.to_patient for t in messages.THREADS for m in t.messages] == [
        True, True, True, True, False, True]
    assert all(m.to_patient for t in messages.THREADS for m in t.messages if m.author is None)
    assert all(t.messages[0].author is None for t in messages.THREADS)       # Linda starts each
    assert all(3 <= len(t.subject) <= 200 and all(1 <= len(m.body) <= 4000 for m in t.messages)
               for t in messages.THREADS)
    for t in messages.THREADS:
        sent = [m.sent(day) for m in t.messages]
        assert sent == sorted(sent) and sent[-1] < dt.datetime.combine(
            day, dt.time(), demo.CLINIC_ZONE)                                # before the day


def test_the_threads_count_back_from_the_demo_day_or_today(
        monkeypatch: pytest.MonkeyPatch) -> None:
    """SHRI_DEMO_DAY set ahead of the reset would put messages in the future: then today."""
    monkeypatch.setattr(demo, "DEMO_DAY", dt.date(2026, 11, 20))
    at = dt.datetime(2026, 11, 18, 17, 0, tzinfo=dt.UTC)                    # 09:00 in San Jose
    assert messages.anchor(at) == dt.date(2026, 11, 18)
    assert messages.anchor(at + dt.timedelta(days=5)) == dt.date(2026, 11, 20)


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_threads_are_stored_as_the_portal_stores_them_once(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    _seeded(migrator_engine, monkeypatch)
    rows = _rows(admin_engine)
    with admin_engine.connect() as c:
        role = c.execute(text("SELECT id FROM admin.role WHERE code = 'MA' "
                              "AND tenant_id IS NULL")).scalar_one()
    items = {r.id: r for r in rows["work_item"]}
    assert set(items) == set(messages.thread_ids())
    for t in messages.THREADS:
        w = items[sid(messages.MESSAGE_THREAD, t.n)]
        assert (w.tenant_id, w.item_type, w.status, w.priority, w.title, w.body, w.patient_id,
                w.assigned_role_id, w.assigned_user_id, w.facility_id, w.encounter_id) == (
            CLINIC_A, "patient-message", "open", 4, t.subject, None, LINDA, role, None,
            FACILITY_A, None)
        replies = [r for r in rows["work_item_reply"] if r.work_item_id == w.id]
        assert [r.id for r in replies] == [sid(messages.MESSAGE_REPLY, t.n * 10 + i)
                                           for i in range(1, len(t.messages) + 1)]
        assert [(r.author_user_id, r.author_patient_id, r.body, r.to_patient)
                for r in replies] == [(m.author, None if m.author else LINDA, m.body,
                                       m.to_patient) for m in t.messages]
        times = [r.created_at for r in replies]
        assert times == sorted(times) and w.created_at == times[0] and w.updated_at == times[-1]
    events = rows["work_item_event"]
    assert [(e.id, e.event, e.to_status, e.occurred_at) for e in events] == sorted(
        (sid(messages.MESSAGE_EVENT, t.n), "created", "open",
         items[sid(messages.MESSAGE_THREAD, t.n)].created_at) for t in messages.THREADS)
    (note,) = [r for r in rows["work_item_reply"] if not r.to_patient]
    assert (note.body, note.author_user_id) == (NOTE.body, messages.DOCTOR_USER)
    assert max(r.created_at for r in rows["work_item_reply"]) < dt.datetime.now(dt.UTC)
    with admin_engine.connect() as c:                       # notifications are runtime only
        assert c.execute(text("SELECT count(*) FROM admin.event_log WHERE subject = ANY(:s)"),
                         {"s": [f"inbox-item/{t}" for t in messages.thread_ids()]}
                         ).scalar_one() == 0
    assert messages.run(migrator_engine) == 0               # a second run writes nothing
    assert _rows(admin_engine) == rows


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_portal_lists_exactly_the_threads_and_never_the_staff_note(
        migrator_engine: Engine, portal_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    _seeded(migrator_engine, monkeypatch)
    with portal_engine.begin() as c:
        _as_linda(c)
        listed = c.execute(text("SELECT * FROM admin.portal_message_threads(25, 0)")).all()
        threads = {t: c.execute(text("SELECT * FROM admin.portal_message_thread(:t)"),
                                {"t": t}).all() for t in messages.thread_ids()}
    seeded = set(messages.thread_ids())
    mine = [r for r in listed if r.id in seeded]
    assert len(mine) == len(listed) == 3                    # hers, and nothing else
    first, unanswered, noted = (sid(messages.MESSAGE_THREAD, n) for n in (1, 2, 3))
    assert [r.id for r in listed] == [unanswered, noted, first]     # latest activity first
    assert [(r.status, r.last_message_from) for r in listed] == [
        ("open", "patient"), ("open", "clinic"), ("open", "clinic")]
    seen = [m for rows in threads.values() for m in rows]
    assert NOTE.body not in {m.body for m in seen}
    assert sid(messages.MESSAGE_REPLY, 32) not in {m.message_id for m in seen}
    assert [(m.author, m.author_name) for m in threads[noted]] == [
        ("patient", None), ("clinic", "Tobias289 Lindqvist45")]
    assert [(m.author, m.author_name) for m in threads[first]] == [
        ("patient", None), ("clinic", "Rowan318 Halvorsen64")]
    assert [m.author for m in threads[unanswered]] == ["patient"]


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_staff_read_the_note_in_the_inbox(
        migrator_engine: Engine, app_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    _seeded(migrator_engine, monkeypatch)
    with app_engine.begin() as c:
        c.execute(text("SELECT set_config('app.current_tenant_id', :t, true), "
                       "set_config('app.current_user_id', :u, true)"),
                  {"t": str(CLINIC_A), "u": str(messages.MA_USER)})
        replies = c.execute(text("SELECT * FROM admin.inbox_replies(:i)"),
                            {"i": sid(messages.MESSAGE_THREAD, 3)}).all()
    assert [(r.from_patient, r.to_patient, r.author_name) for r in replies] == [
        (True, True, None), (False, False, "Rowan318 Halvorsen64"),
        (False, True, "Tobias289 Lindqvist45")]


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_missing_threads_are_written_again_and_the_reset_checks_them(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """On a database without them (here: removed inside a transaction that is rolled back,
    triggers off, as only a fresh database is), the loader writes all three again; the
    reset's check names them when one is missing or closed."""
    _seeded(migrator_engine, monkeypatch)
    ids = {"ids": list(messages.thread_ids())}
    with admin_engine.connect() as conn:
        conn.execute(text("SET LOCAL session_replication_role = replica"))
        for table, column in (("work_item_reply", "work_item_id"),
                              ("work_item_event", "work_item_id"), ("work_item", "id")):
            conn.execute(text(f"DELETE FROM admin.{table} WHERE {column} = ANY(:ids)"),  # noqa: S608
                         ids)
        conn.execute(text("SET LOCAL session_replication_role = origin"))
        conn.execute(text("SET LOCAL ROLE shri_migrator"))
        with Session(bind=conn) as db:
            found = reset.summary(db)
            assert "0 of Linda Thompson's 3 message threads open" in reset.verify(db, found)
            assert messages.load_messages(db) == 3
            db.flush()
            assert not any("message threads" in p for p in reset.verify(db, found))
            db.execute(text("UPDATE admin.work_item SET status = 'cancelled' WHERE id = :t"),
                       {"t": sid(messages.MESSAGE_THREAD, 2)})
            assert "2 of Linda Thompson's 3 message threads open" in reset.verify(db, found)
        conn.rollback()                                     # nothing is kept
    assert len(_rows(admin_engine)["work_item"]) == 3


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_reset_loads_the_threads_after_linda(
        migrator_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """A reset restores them: its steps, in order, with the database steps stubbed."""
    monkeypatch.setenv("ENVIRONMENT", "test")
    calls: list[str] = []
    monkeypatch.setattr(reset, "require_empty", lambda _engine: None)
    monkeypatch.setattr(reset, "migrate", lambda: calls.append("migrate"))
    monkeypatch.setattr(reset, "load_demo", lambda _db: calls.append("demo"))
    for name in ("history", "results", "linda", "messages"):
        monkeypatch.setattr(getattr(reset, name), "run",
                            lambda _engine, name=name: calls.append(name))
    monkeypatch.setattr(reset, "summary", lambda _db: reset.ResetSummary("0031", 0, 0))
    monkeypatch.setattr(reset, "verify", lambda _db, _found: [])
    reset.reset(migrator_engine)
    assert calls == ["migrate", "demo", "history", "results", "linda", "messages"]
