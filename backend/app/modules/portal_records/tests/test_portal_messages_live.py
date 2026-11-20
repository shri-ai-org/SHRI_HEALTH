"""The patient portal's secure messages (#398: listPortalMessageThreads, createPortalMessage,
getPortalMessageThread, replyToPortalMessageThread) against a live database: the real app, the
portal as ``shri_portal`` through migration 0031's functions, the patient development sign-in
(X-Dev-Patient, D108), core's audit and Idempotency-Key. Staff replies go through
``admin.inbox_reply`` as ``shri_app``, as the inbox service sends them. Synthetic data only."""

from __future__ import annotations

import uuid
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.deps import DEV_PATIENT_CLINIC_HEADER, DEV_PATIENT_HEADER, DEV_USER_HEADER
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests.conftest import setup_session
from app.modules.scheduling.tests.portal_live import PortalChart, audit_rows

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1/portal/me/messages"
SUBJECT, BODY = "Question about my naproxen", "Should I take it with food?"


def _me(chart: PortalChart, patient: UUID | None = None) -> dict[str, str]:
    return {DEV_PATIENT_HEADER: str(patient or chart.a),
            DEV_PATIENT_CLINIC_HEADER: str(chart.practice.clinic)}


def _key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _start(app: Any, chart: PortalChart, subject: str = SUBJECT, body: str = BODY,
           headers: dict[str, str] | None = None) -> Any:
    return app.post(API, json={"subject": subject, "body": body},
                    headers=_me(chart) | (headers or _key()))


def _reply(app: Any, chart: PortalChart, thread: str, body: str,
           patient: UUID | None = None) -> Any:
    return app.post(f"{API}/{thread}/replies", json={"body": body},
                    headers=_me(chart, patient) | _key())


def _staff(chart: PortalChart, sql: str, **params: Any) -> Any:
    """As shri_app with a staff user of the clinic, as the inbox service runs."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, chart.practice.clinic)
    try:
        user = db.execute(text(
            "INSERT INTO admin.app_user (id, tenant_id, keycloak_subject, username, "
            "display_name) VALUES (gen_random_uuid(), :t, :k, :u, 'Maria Okafor (MA)') "
            "RETURNING id"), {"t": chart.practice.clinic, "k": str(uuid.uuid4()),
                              "u": f"ma.{uuid.uuid4().hex[:8]}"}).scalar_one()
        db.execute(text("SET LOCAL ROLE shri_app"))
        db.execute(text("SELECT set_config('app.current_user_id', :u, true)"), {"u": str(user)})
        result = db.execute(text(sql), params)
        found = result.all() if sql.lstrip().upper().startswith("SELECT") else []
        db.commit()
        return found
    finally:
        db.close()
        admin.dispose()


def _owner(sql: str, **params: Any) -> list[Any]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.begin() as c:
            return list(c.execute(text(sql), params))
    finally:
        admin.dispose()


def test_a_patient_starts_reads_and_lists_her_thread_and_each_step_is_audited(
        portal_app: Any, portal_chart: PortalChart) -> None:
    chart = portal_chart
    before = len(audit_rows(chart.practice.clinic))
    created = _start(portal_app, chart)
    assert created.status_code == 201, created.text
    thread = created.json()
    assert created.headers["Location"] == f"{API}/{thread['id']}"
    assert (thread["subject"], thread["status"], thread["lastMessageFrom"]) == (
        SUBJECT, "open", "patient")
    assert [(m["author"], m["body"]) for m in thread["messages"]] == [("patient", BODY)]
    assert "authorName" not in thread["messages"][0]
    listed = portal_app.get(API, headers=_me(chart))
    assert listed.status_code == 200
    assert [t["id"] for t in listed.json()["items"]] == [thread["id"]]
    assert "messages" not in listed.json()["items"][0]                 # no text in the list
    read = portal_app.get(f"{API}/{thread['id']}", headers=_me(chart))
    assert read.status_code == 200 and read.json()["messages"] == thread["messages"]
    rows = audit_rows(chart.practice.clinic)[before:]
    assert [(r.actor_type, r.patient_id, r.category) for r in rows] == [
        ("patient", chart.a, "phi-write"), ("patient", chart.a, "phi-read"),
        ("patient", chart.a, "phi-read")]
    # The clinic is told with no text: the item's type and priority only (D81).
    (note,) = _owner("SELECT type, target_role_code, data FROM admin.event_log "
                     "WHERE subject = :s", s=f"inbox-item/{thread['id']}")
    assert (note.type, note.target_role_code) == ("inbox.item-assigned", "MA")
    assert SUBJECT not in str(note.data) and BODY not in str(note.data)


def test_another_patients_thread_is_not_found(portal_app: Any,
                                              portal_chart: PortalChart) -> None:
    chart = portal_chart
    thread = _start(portal_app, chart).json()["id"]
    theirs = _me(chart, chart.b)
    assert portal_app.get(f"{API}/{thread}", headers=theirs).status_code == 404
    assert portal_app.get(f"{API}/{uuid.uuid4()}", headers=theirs).status_code == 404
    assert _reply(portal_app, chart, thread, "Hello", chart.b).status_code == 404
    assert portal_app.get(API, headers=theirs).json()["items"] == []


def test_the_patient_reads_replies_sent_to_her_and_never_a_staff_note(
        portal_app: Any, portal_chart: PortalChart) -> None:
    chart = portal_chart
    thread = _start(portal_app, chart).json()["id"]
    _staff(chart, "SELECT admin.inbox_reply(:i, 'Internal: check her creatinine first.', false)",
           i=thread)
    _staff(chart, "SELECT admin.inbox_reply(:i, 'Yes, take it with food.', true)", i=thread)
    read = portal_app.get(f"{API}/{thread}", headers=_me(chart)).json()
    assert [(m["author"], m.get("authorName"), m["body"]) for m in read["messages"]] == [
        ("patient", None, BODY), ("clinic", "Maria Okafor (MA)", "Yes, take it with food.")]
    assert read["lastMessageFrom"] == "clinic"
    replied = _reply(portal_app, chart, thread, "Thank you")
    assert replied.status_code == 200, replied.text
    assert [m["body"] for m in replied.json()["messages"]][-1] == "Thank you"
    assert "Internal" not in replied.text


def test_a_closed_thread_takes_no_reply(portal_app: Any, portal_chart: PortalChart) -> None:
    chart = portal_chart
    thread = _start(portal_app, chart).json()["id"]
    _staff(chart, "UPDATE admin.work_item SET status = 'cancelled' WHERE id = :i", i=thread)
    refused = _reply(portal_app, chart, thread, "Hello?")
    assert (refused.status_code, refused.json()["code"]) == (409, "invalid-state-transition")
    assert portal_app.get(f"{API}/{thread}", headers=_me(chart)).json()["status"] == "closed"


def test_a_patient_is_limited_to_five_messages_in_ten_minutes(
        portal_app: Any, portal_chart: PortalChart) -> None:
    chart = portal_chart
    thread = _start(portal_app, chart).json()["id"]
    for n in range(4):
        assert _reply(portal_app, chart, thread, f"Reply {n}").status_code == 200
    refused = _reply(portal_app, chart, thread, "Sixth")
    assert (refused.status_code, refused.json()["code"]) == (429, "rate-limited")
    assert int(refused.headers["Retry-After"]) > 0
    assert "Sixth" not in refused.text


def test_a_message_is_checked_against_the_contract(portal_app: Any,
                                                   portal_chart: PortalChart) -> None:
    chart = portal_chart
    for body in ({"subject": "Hi", "body": BODY}, {"subject": SUBJECT, "body": ""},
                 {"subject": SUBJECT, "body": "x" * 4001},
                 {"subject": SUBJECT, "body": BODY, "attachment": "x"}):
        refused = portal_app.post(API, json=body, headers=_me(chart) | _key())
        assert (refused.status_code, refused.json()["code"]) == (422, "validation-failed")
    assert portal_app.get(API, headers=_me(chart)).json()["items"] == []


def test_one_idempotency_key_starts_one_thread(portal_app: Any,
                                               portal_chart: PortalChart) -> None:
    chart = portal_chart
    key = _key()
    first, again = _start(portal_app, chart, headers=key), _start(portal_app, chart, headers=key)
    # Core keeps the key; its stored replay needs the key service, which this test app lacks,
    # so the second answer is core's (409 in progress, or the replay), never a second thread.
    assert first.status_code == 201 and again.status_code in (201, 409)
    assert len(portal_app.get(API, headers=_me(chart)).json()["items"]) == 1


def test_only_a_patient_session_reaches_the_messages(portal_app: Any,
                                                     portal_chart: PortalChart) -> None:
    chart = portal_chart
    assert portal_app.get(API).status_code == 401
    assert portal_app.post(API, json={"subject": SUBJECT, "body": BODY},
                           headers=_key()).status_code == 401
    staff = {DEV_USER_HEADER: "md"}                                     # a staff stand-in
    assert portal_app.get(API, headers=staff).status_code == 401
    assert _owner("SELECT count(*) FROM admin.work_item WHERE tenant_id = :t "
                  "AND item_type = 'patient-message'", t=chart.practice.clinic)[0][0] == 0
