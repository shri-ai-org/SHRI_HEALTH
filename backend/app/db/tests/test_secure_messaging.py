"""Migration 0031: secure messaging. A portal thread is a `patient-message` inbox item and its
messages are admin.work_item_reply rows, reached only through SECURITY DEFINER functions: four
for shri_portal (list, read, create, reply) and two for shri_app (reply, read replies). Run as
the real roles against the real database. Synthetic data only."""
from __future__ import annotations

import threading
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.db.tests.conftest import SERVICE_ROLES, SKIP_WITHOUT_DATABASE
from app.db.tests.test_portal_access import _as_patient, _book, chart, portal_engine

__all__ = ["chart", "portal_engine"]       # fixtures, used by name
pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

SUBJECT, BODY = "Question about my naproxen", "Should I take it with food?"
PORTAL_FUNCTIONS = {"admin.portal_message_threads(integer,integer)",
                    "admin.portal_message_thread(uuid)",
                    "admin.portal_create_message(text,text)",
                    "admin.portal_reply_to_thread(uuid,text)"}
STAFF_FUNCTIONS = {"admin.inbox_reply(uuid,text,boolean)", "admin.inbox_replies(uuid)"}


def _refusal(c: Connection, sql: str, params: dict[str, Any] | None = None
             ) -> tuple[str, str | None, str]:
    """(SQLSTATE, constraint, message) of a statement that must fail; the transaction goes on."""
    savepoint = c.begin_nested()
    with pytest.raises(DBAPIError) as err:
        c.execute(text(sql), params or {})
    savepoint.rollback()
    orig: Any = err.value.orig
    return orig.sqlstate, orig.diag.constraint_name, str(orig)


def _create(c: Connection, subject: str = SUBJECT, body: str = BODY) -> uuid.UUID:
    item: uuid.UUID = c.execute(text("SELECT admin.portal_create_message(:s, :b)"),
                                {"s": subject, "b": body}).scalar_one()
    return item


def _thread(c: Connection, thread: uuid.UUID) -> list[Any]:
    return list(c.execute(text("SELECT * FROM admin.portal_message_thread(:t)"),
                          {"t": thread}).all())


def _threads(c: Connection) -> list[Any]:
    return list(c.execute(text("SELECT * FROM admin.portal_message_threads(25, 0)")).all())


def _as_staff(c: Connection, chart: dict[str, Any], user: uuid.UUID | None = None
              ) -> Connection:
    c.execute(text("SELECT set_config('app.current_tenant_id', :t, true), "
                   "set_config('app.current_user_id', :u, true)"),
              {"t": str(chart["tenant"]), "u": str(user or chart["ctx"]["user"].id)})
    return c


def _staff_reply(c: Connection, item: uuid.UUID, body: str, to_patient: bool) -> uuid.UUID:
    reply: uuid.UUID = c.execute(text("SELECT admin.inbox_reply(:i, :b, :p)"),
                                 {"i": item, "b": body, "p": to_patient}).scalar_one()
    return reply


@pytest.fixture
def thread(portal_engine: Engine, chart: dict[str, Any]) -> Iterator[uuid.UUID]:
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        item = _create(c)
    yield item


def test_a_patient_starts_a_thread_routed_to_the_medical_assistants(
        portal_engine: Engine, admin_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    second = chart["ctx"]["facility"].__class__(location_id=chart["ctx"]["room"].id, code="WEST",
                                                name="West office", timezone="America/Denver")
    s.add(second)
    s.commit()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        visit = _book(c, chart)
    with admin_engine.begin() as c:                                # her visit is at the second
        c.execute(text("UPDATE clinical.appointment SET ext_facility_id = :f WHERE id = :a"),
                  {"f": second.id, "a": visit})
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        item = _create(c)
        (row,) = _threads(c)
        messages = _thread(c, item)
    assert (row.id, row.subject, row.status, row.last_message_from) == (
        item, SUBJECT, "open", "patient")
    assert [(m.author, m.author_name, m.body) for m in messages] == [("patient", None, BODY)]
    with admin_engine.begin() as c:
        work = c.execute(text(
            "SELECT w.*, r.code FROM admin.work_item w JOIN admin.role r "
            "ON r.id = w.assigned_role_id WHERE w.id = :i"), {"i": item}).one()
        events = c.execute(text("SELECT event, user_id FROM admin.work_item_event "
                                "WHERE work_item_id = :i"), {"i": item}).all()
        (note,) = c.execute(text("SELECT * FROM admin.event_log WHERE subject = :s"),
                            {"s": f"inbox-item/{item}"}).all()
    assert (work.item_type, work.status, work.title, work.body, work.patient_id, work.code,
            work.facility_id, work.assigned_user_id) == (
        "patient-message", "open", SUBJECT, None, chart["me"]["pt"].id, "MA", second.id, None)
    assert events == [("created", None)]
    # The notification names the item, its type and priority, and nothing the patient wrote.
    assert (note.type, note.target_role_code, note.facility_id, note.patient_id, note.data) == (
        "inbox.item-assigned", "MA", second.id, chart["me"]["pt"].id,
        {"itemType": "patient-message", "priority": "routine"})
    assert SUBJECT not in str(note._mapping) and BODY not in str(note._mapping)


def test_without_a_visit_the_thread_goes_to_the_clinics_first_facility(
        thread: uuid.UUID, admin_engine: Engine, chart: dict[str, Any]) -> None:
    with admin_engine.begin() as c:
        facility = c.execute(text("SELECT facility_id FROM admin.work_item WHERE id = :i"),
                             {"i": thread}).scalar_one()
    assert facility == chart["ctx"]["facility"].id


def test_a_patient_never_reaches_another_patients_thread(
        thread: uuid.UUID, portal_engine: Engine, chart: dict[str, Any]) -> None:
    with portal_engine.begin() as c:
        _as_patient(c, chart, "other")
        assert _threads(c) == [] and _thread(c, thread) == []
        assert _refusal(c, "SELECT admin.portal_reply_to_thread(:t, 'Hello')",
                        {"t": thread})[0] == "P0002"
        assert _thread(c, uuid.uuid4()) == []                      # the same as a missing one
        assert _refusal(c, "SELECT admin.portal_reply_to_thread(:t, 'Hello')",
                        {"t": uuid.uuid4()})[0] == "P0002"
    with portal_engine.begin() as c:                               # no session patient
        c.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                  {"t": str(chart["tenant"])})
        assert _threads(c) == [] and _thread(c, thread) == []
        assert _refusal(c, "SELECT admin.portal_create_message('Hello there', 'Hi')")[0] == (
            "P0002")


def test_the_portal_never_shows_a_staff_only_reply(
        thread: uuid.UUID, portal_engine: Engine, app_engine: Engine,
        chart: dict[str, Any]) -> None:
    with app_engine.begin() as c:
        _as_staff(c, chart)
        _staff_reply(c, thread, "Internal: check the last creatinine first.", False)
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert [m.body for m in _thread(c, thread)] == [BODY]
        assert _threads(c)[0].last_message_from == "patient"
    with app_engine.begin() as c:
        _as_staff(c, chart)
        _staff_reply(c, thread, "Yes, take it with food.", True)
        replies = c.execute(text("SELECT * FROM admin.inbox_replies(:i)"), {"i": thread}).all()
    assert [(r.from_patient, r.to_patient) for r in replies] == [
        (True, True), (False, False), (False, True)]
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        messages = _thread(c, thread)
        (row,) = _threads(c)
    assert [(m.author, m.author_name, m.body) for m in messages] == [
        ("patient", None, BODY), ("clinic", "Elena Rivera", "Yes, take it with food.")]
    assert row.last_message_from == "clinic"


def test_a_patient_replies_on_her_open_thread_and_its_holder_is_told(
        thread: uuid.UUID, portal_engine: Engine, admin_engine: Engine,
        chart: dict[str, Any]) -> None:
    user = chart["ctx"]["user"].id
    with admin_engine.begin() as c:                                # a medical assistant took it
        c.execute(text("UPDATE admin.work_item SET assigned_role_id = NULL, "
                       "assigned_user_id = :u WHERE id = :i"), {"u": user, "i": thread})
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        c.execute(text("SELECT admin.portal_reply_to_thread(:t, 'Thank you')"), {"t": thread})
        assert [m.body for m in _thread(c, thread)] == [BODY, "Thank you"]
    with admin_engine.begin() as c:
        (item,) = c.execute(text("SELECT count(*) FROM admin.work_item WHERE patient_id = :p"),
                            {"p": chart["me"]["pt"].id}).one()
        notes = c.execute(text("SELECT target_user_id, target_role_code, data FROM "
                               "admin.event_log WHERE subject = :s ORDER BY seq"),
                          {"s": f"inbox-item/{thread}"}).all()
        holder = c.execute(text("SELECT assigned_user_id FROM admin.work_item WHERE id = :i"),
                           {"i": thread}).scalar_one()
    assert item == 1 and holder == user                            # one item; the holder keeps it
    assert [(n.target_user_id, n.target_role_code) for n in notes] == [(None, "MA"), (user, None)]
    assert "Thank you" not in str(notes)


def test_a_closed_thread_takes_no_reply_and_stays_closed(
        thread: uuid.UUID, portal_engine: Engine, app_engine: Engine,
        chart: dict[str, Any]) -> None:
    with app_engine.begin() as c:
        _as_staff(c, chart)
        c.execute(text("UPDATE admin.work_item SET status = 'completed', completed_at = now(), "
                       "completed_by_user_id = :u WHERE id = :i"),
                  {"u": chart["ctx"]["user"].id, "i": thread})
        assert _refusal(c, "SELECT admin.inbox_reply(:i, 'More', true)", {"i": thread})[:2] == (
            "P0001", "inbox_item_closed")
        assert _refusal(c, "UPDATE admin.work_item SET status = 'open', completed_at = NULL "
                           "WHERE id = :i", {"i": thread})[:2] == (
            "P0001", "patient_message_unchanged")
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert _threads(c)[0].status == "closed"
        assert _refusal(c, "SELECT admin.portal_reply_to_thread(:t, 'Hello?')",
                        {"t": thread})[:2] == ("P0001", "portal_message_thread_closed")


def test_staff_never_write_as_the_patient_or_start_or_rewrite_her_thread(
        thread: uuid.UUID, app_engine: Engine, chart: dict[str, Any]) -> None:
    pt = chart["me"]["pt"].id
    with app_engine.begin() as c:
        _as_staff(c, chart)
        # No privilege on the reply table: a staff member can't write a patient's reply.
        assert _refusal(c, "INSERT INTO admin.work_item_reply (id, tenant_id, work_item_id, "
                           "author_patient_id, body, to_patient) VALUES (gen_random_uuid(), "
                           ":t, :i, :p, 'Forged', true)",
                        {"t": chart["tenant"], "i": thread, "p": pt})[0] == "42501"
        assert _refusal(c, "INSERT INTO admin.work_item (id, tenant_id, item_type, priority, "
                           "title, escalation_level, patient_id) VALUES (gen_random_uuid(), :t, "
                           "'patient-message', 4, 'Forged thread', 0, :p)",
                        {"t": chart["tenant"], "p": pt})[:2] == (
            "P0001", "patient_message_portal_only")
        assert _refusal(c, "UPDATE admin.work_item SET title = 'Changed' WHERE id = :i",
                        {"i": thread})[:2] == ("P0001", "patient_message_unchanged")
        # Its own reply is always the staff member's, whatever the arguments.
        reply = _staff_reply(c, thread, "Noted.", False)
        row = c.execute(text("SELECT * FROM admin.inbox_replies(:i) WHERE id = :r"),
                        {"i": thread, "r": reply}).one()
        assert (row.author_user_id, row.from_patient) == (chart["ctx"]["user"].id, False)


def test_a_staff_reply_needs_a_clinic_user_and_reaches_the_patient_only_on_her_thread(
        thread: uuid.UUID, app_engine: Engine, admin_engine: Engine,
        chart: dict[str, Any]) -> None:
    with app_engine.begin() as c:
        _as_staff(c, chart)
        task = c.execute(text("INSERT INTO admin.work_item (id, tenant_id, item_type, priority, "
                              "title, escalation_level, facility_id) VALUES (gen_random_uuid(), "
                              ":t, 'task', 4, 'Call the lab', 0, :f) RETURNING id"),
                         {"t": chart["tenant"], "f": chart["ctx"]["facility"].id}).scalar_one()
        assert _refusal(c, "SELECT admin.inbox_reply(:i, 'Done', true)", {"i": task})[:2] == (
            "P0001", "inbox_reply_to_patient_not_allowed")
        _staff_reply(c, task, "Done", False)
        assert _refusal(c, "SELECT admin.inbox_reply(:i, 'x', false)",
                        {"i": uuid.uuid4()})[0] == "P0002"
    with app_engine.begin() as c:
        _as_staff(c, chart, uuid.uuid4())                          # not a user of this clinic
        assert _refusal(c, "SELECT admin.inbox_reply(:i, 'x', false)", {"i": thread})[:2] == (
            "P0001", "inbox_reply_not_staff")


def test_a_message_is_limited_in_size_and_rate(
        thread: uuid.UUID, portal_engine: Engine, chart: dict[str, Any]) -> None:
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        for subject, body, refused in (
                ("Hi", BODY, "message_subject_invalid"),
                ("x" * 201, BODY, "message_subject_invalid"),
                ("   \t ", BODY, "message_subject_invalid"), (SUBJECT, "", "message_body_invalid"),
                (SUBJECT, "x" * 4001, "message_body_invalid"),
                (SUBJECT, " \n\t  ", "message_body_invalid")):
            state, constraint, message = _refusal(
                c, "SELECT admin.portal_create_message(:s, :b)", {"s": subject, "b": body})
            # Refused before any write, naming only the rule: never the row, as a CHECK would.
            assert (state, constraint) == ("P0001", refused) and BODY not in message
            assert SUBJECT not in message
        assert _refusal(c, "SELECT admin.portal_reply_to_thread(:t, '   ')",
                        {"t": thread})[:2] == ("P0001", "message_body_invalid")
        for n in range(4):                                         # the thread's first is one
            c.execute(text("SELECT admin.portal_reply_to_thread(:t, :b)"),
                      {"t": thread, "b": f"Reply {n}"})
        assert _refusal(c, "SELECT admin.portal_reply_to_thread(:t, 'Sixth')",
                        {"t": thread})[:2] == ("P0001", "portal_message_rate_limited")
        assert _refusal(c, "SELECT admin.portal_create_message(:s, 'Sixth')",
                        {"s": SUBJECT})[:2] == ("P0001", "portal_message_rate_limited")


def test_a_patient_sends_at_most_twenty_messages_a_day(
        thread: uuid.UUID, portal_engine: Engine, admin_engine: Engine,
        chart: dict[str, Any]) -> None:
    with admin_engine.begin() as c:                                # 19 more, earlier today
        c.execute(text(
            "INSERT INTO admin.work_item_reply (id, tenant_id, work_item_id, author_patient_id, "
            "body, to_patient, created_at) SELECT gen_random_uuid(), :t, :i, :p, 'Earlier', true, "
            "now() - interval '2 hours' FROM generate_series(1, 19)"),
            {"t": chart["tenant"], "i": thread, "p": chart["me"]["pt"].id})
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert _refusal(c, "SELECT admin.portal_reply_to_thread(:t, 'More')",
                        {"t": thread})[:2] == ("P0001", "portal_message_daily_cap")


def test_an_inactive_chart_starts_no_thread(portal_engine: Engine, admin_engine: Engine,
                                            chart: dict[str, Any]) -> None:
    with admin_engine.begin() as c:
        c.execute(text("UPDATE clinical.patient SET active = false WHERE id = :p"),
                  {"p": chart["me"]["pt"].id})
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert _refusal(c, "SELECT admin.portal_create_message(:s, 'Hi')", {"s": SUBJECT})[:2] == (
            "P0001", "portal_message_chart_inactive")


def test_messages_never_change_for_any_role(thread: uuid.UUID, admin_engine: Engine,
                                            chart: dict[str, Any]) -> None:
    with admin_engine.begin() as c:
        for role in ("postgres", "shri_migrator"):                 # the superuser, the owner
            c.execute(text(f"SET LOCAL ROLE {role}"))
            c.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                      {"t": str(chart["tenant"])})
            for sql in ("UPDATE admin.work_item_reply SET body = 'Changed' "
                        "WHERE work_item_id = :i",
                        "DELETE FROM admin.work_item_reply WHERE work_item_id = :i"):
                assert _refusal(c, sql, {"i": thread})[:2] == ("P0001", None), (role, sql)


def test_only_the_functions_reach_the_messages(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        for role in SERVICE_ROLES:
            for table in ("admin.work_item_reply",) + (
                    ("admin.work_item", "admin.work_item_event") if role == "shri_portal"
                    else ()):
                assert not c.execute(text(
                    "SELECT has_table_privilege(:r, :t, 'SELECT') OR has_table_privilege(:r, :t, "
                    "'INSERT') OR has_table_privilege(:r, :t, 'UPDATE') OR "
                    "has_table_privilege(:r, :t, 'DELETE')"), {"r": role, "t": table}).scalar(), (
                    role, table)
        assert c.execute(text("SELECT relforcerowsecurity FROM pg_class WHERE oid = "
                              "'admin.work_item_reply'::regclass")).scalar()
        rows = c.execute(text(
            "SELECT p.oid::regprocedure::text AS name, p.prosecdef, p.proconfig, "
            "pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl FROM pg_proc p "
            "WHERE p.oid::regprocedure::text = ANY(:names)"),
            {"names": sorted(PORTAL_FUNCTIONS | STAFF_FUNCTIONS)}).all()
        assert {r.name for r in rows} == PORTAL_FUNCTIONS | STAFF_FUNCTIONS
        for r in rows:
            assert r.prosecdef and r.owner == "shri_migrator", r.name
            assert r.proconfig == ["search_path=pg_catalog, pg_temp"], r.name
            assert not any(e.startswith("=") for e in r.acl.strip("{}").split(",")), r.name
            mine = "shri_portal" if r.name in PORTAL_FUNCTIONS else "shri_app"
            for role in SERVICE_ROLES:
                assert c.execute(text("SELECT has_function_privilege(:r, :f, 'EXECUTE')"),
                                 {"r": role, "f": r.name}).scalar() == (role == mine), (
                    role, r.name)


def test_the_portal_lists_threads_latest_first_in_pages(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    created = []
    for subject in ("First question", "Second question"):          # two transactions, two times
        with portal_engine.begin() as c:
            _as_patient(c, chart)
            created.append(_create(c, subject))
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        ids = [r.id for r in _threads(c)]
        page = c.execute(text("SELECT id FROM admin.portal_message_threads(1, 1)")).all()
    assert ids == created[::-1] and [r.id for r in page] == [created[0]]


def test_the_checks_on_the_table_hold_even_without_the_functions(
        thread: uuid.UUID, admin_engine: Engine, chart: dict[str, Any]) -> None:
    """The owner (as the definer runs) still can't store a blank or oversized message."""
    for body in ("", "   ", "x" * 4001):
        with admin_engine.begin() as c:
            c.execute(text("SET LOCAL ROLE shri_migrator"))
            c.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                      {"t": str(chart["tenant"])})
            assert _refusal(c, "INSERT INTO admin.work_item_reply (id, tenant_id, work_item_id, "
                               "author_patient_id, body, to_patient) VALUES (gen_random_uuid(), "
                               ":t, :i, :p, :b, true)",
                            {"t": chart["tenant"], "i": thread, "p": chart["me"]["pt"].id,
                             "b": body})[:2] == ("23514", "ck_work_item_reply_body")


def test_two_sessions_at_once_never_pass_the_rate_limit_together(
        thread: uuid.UUID, portal_engine: Engine, admin_engine: Engine,
        chart: dict[str, Any]) -> None:
    """Four of five messages are used. Two real connections send at the same moment: the second
    waits on the per-patient lock until the first commits, then counts five and is refused."""
    for n in range(3):
        with portal_engine.begin() as c:
            _as_patient(c, chart)
            c.execute(text("SELECT admin.portal_reply_to_thread(:t, :b)"),
                      {"t": thread, "b": f"Reply {n}"})
    first = portal_engine.connect()
    first_tx = first.begin()
    _as_patient(first, chart)
    first.execute(text("SELECT admin.portal_reply_to_thread(:t, 'Fifth')"), {"t": thread})
    outcome: dict[str, Any] = {}

    def second() -> None:
        with portal_engine.connect() as c, c.begin():
            _as_patient(c, chart)
            try:
                c.execute(text("SELECT admin.portal_reply_to_thread(:t, 'Sixth')"),
                          {"t": thread})
                outcome["result"] = "written"
            except DBAPIError as error:
                outcome["result"] = getattr(error.orig, "sqlstate", None)
                outcome["constraint"] = getattr(getattr(error.orig, "diag", None),
                                                "constraint_name", None)

    racer = threading.Thread(target=second)
    racer.start()
    racer.join(timeout=2)
    assert racer.is_alive()                                    # held on the patient's lock
    first_tx.commit()
    first.close()
    racer.join(timeout=10)
    assert outcome == {"result": "P0001", "constraint": "portal_message_rate_limited"}
    with admin_engine.connect() as c:
        assert c.execute(text("SELECT count(*) FROM admin.work_item_reply WHERE work_item_id = :i"),
                         {"i": thread}).scalar_one() == 5
