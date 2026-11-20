"""The staff inbox (contract batch 3) against a live database: the real app as shri_app, core's
tenant_db, require(), audit, events and restricted-chart check, staff through the X-Dev-User
stand-in with real user_role rows, and patient messages started by the portal's own function
as shri_portal. Every endpoint has a success and a permission-denied test. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import json
import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.db.tests.audit_coverage import audit_problems, audit_rows, phi_in
from app.db.tests.conftest import sync_url
from app.modules.scheduling.tests.conftest import setup_session
from app.modules.scheduling.tests.portal_live import _appointment

from .conftest import (
    TEST_DATABASE_URL,
    Clinic,
    as_portal,
    owner,
    portal_message,
    work_item,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

INBOX = "/api/v1/inbox"
MESSAGES = "/api/v1/messages"
TITLE, BODY = "Recheck blood pressure today", "Please recheck it before discharge."
SUBJECT, ASK = "Question about my naproxen", "Should I take it with food?"


def _later(hours: int = 24) -> str:
    return (dt.datetime.now(dt.UTC) + dt.timedelta(hours=hours)).isoformat()


def _send(app: Any, c: Clinic, sender: str = "md", *, to: tuple[str, str] = ("user", "rn"),
          patient: str | None = "kaia", **extra: Any) -> Any:
    kind, who = to
    assignee = {"type": kind, "id": str(c.roles[who] if kind == "role" else c.id(who))}
    body = {"kind": "message", "assignee": assignee, "facilityId": str(c.practice.facility),
            "title": TITLE, "body": BODY,
            **({"patientId": str(c.practice.patients[patient])} if patient else {}), **extra}
    return app(sender).post(MESSAGES, json=body)


def _get(app: Any, who: str, item: str) -> Any:
    return app(who).get(f"{INBOX}/{item}")


def _patch(app: Any, who: str, item: str, body: dict[str, Any], tag: str | None) -> Any:
    headers = {"Content-Type": "application/merge-patch+json"}
    if tag is not None:
        headers["If-Match"] = tag
    return app(who).patch(f"{INBOX}/{item}", content=json.dumps(body), headers=headers)


def _events(item: str) -> list[Any]:
    return owner("SELECT type, target_user_id, target_role_code, data FROM admin.event_log "
                 "WHERE subject = :s ORDER BY seq", s=f"inbox-item/{item}")


def _audit(c: Clinic, user: str) -> list[Any]:
    return owner("SELECT action, outcome, category, patient_id, entity_type, entity_id, reason "
                 "FROM audit.audit_event WHERE tenant_id = :t AND actor_user_id = :u "
                 "ORDER BY id", t=c.clinic, u=c.id(user))


def _problem(response: Any) -> tuple[int, str, list[Any]]:
    found = response.json()
    return (response.status_code, found["code"],
            [e.get("pointer") or e.get("name") for e in found.get("errors", [])])


# ------------------------------------------------------------------------------ createMessage
def test_a_clinician_sends_a_message_to_a_nurse(client: Any, inbox: Clinic) -> None:
    c = inbox
    sent = _send(client, c)
    assert sent.status_code == 201, sent.text
    item = sent.json()
    assert sent.headers["Location"] == f"{INBOX}/{item['id']}"
    assert sent.headers["ETag"].startswith('"')
    assert (item["itemType"], item["status"], item["priority"], item["title"], item["body"]) == (
        "message", "open", "routine", TITLE, BODY)
    assert item["assignee"] == {"type": "user", "id": str(c.id("rn")),
                                "displayName": c.users["rn"].display_name}
    assert item["createdBy"]["id"] == str(c.id("md")) and item["restricted"] is False
    assert item["patient"]["id"] == str(c.practice.patients["kaia"])
    assert item["patient"]["name"]["family"] == "Lindgren118"
    assert [(e["event"], e["by"]["id"], e["assignee"]["id"]) for e in item["thread"]] == [
        ("created", str(c.id("md")), str(c.id("rn")))]
    # The nurse is told with the kind and priority only (D81), and the patient is audited.
    (event,) = _events(item["id"])
    assert (event.type, event.target_user_id, event.data) == (
        "inbox.item-assigned", c.id("rn"), {"itemType": "message", "priority": "routine"})
    (row,) = _audit(c, "md")
    assert (row.action, row.category, row.patient_id) == (
        "create", "phi-write", c.practice.patients["kaia"])


def test_a_task_about_an_appointment_goes_to_the_front_desk_queue(client: Any,
                                                                   inbox: Clinic) -> None:
    c = inbox
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, c.clinic)
    try:
        appt = _appointment(db, c.practice, c.practice.patients["kaia"],
                            dt.datetime.now(dt.UTC) + dt.timedelta(days=3), "booked").id
        other = _appointment(db, c.practice, c.practice.patients["marcus"],
                             dt.datetime.now(dt.UTC) + dt.timedelta(days=4), "booked").id
        db.commit()
    finally:
        db.close()
        admin.dispose()
    task: dict[str, Any] = {"kind": "task", "dueAt": _later(), "priority": "urgent",
            "subject": {"type": "appointment", "id": str(appt)}}
    sent = _send(client, c, to=("role", "FD"), **task)
    assert sent.status_code == 201, sent.text
    assert sent.json()["subject"] == {"type": "appointment", "id": str(appt)}
    assert sent.json()["assignee"]["type"] == "role"
    (event,) = _events(sent.json()["id"])
    assert (event.target_role_code, event.data["priority"]) == ("FD", "urgent")
    # The record must be the patient's (D80).
    wrong = _send(client, c, to=("role", "FD"), **(task | {
        "subject": {"type": "appointment", "id": str(other)}}))
    assert _problem(wrong) == (422, "business-rule-violation", ["/subject"])
    missing = _send(client, c, to=("role", "FD"), **(task | {
        "subject": {"type": "appointment", "id": str(uuid.uuid4())}}))
    assert missing.status_code == 404


def test_a_message_is_checked_before_it_is_sent(client: Any, inbox: Clinic) -> None:
    c = inbox
    cases: list[tuple[dict[str, Any], tuple[int, str, list[str]]]] = [
        ({"facilityId": str(c.practice.other_facility)}, (422, "business-rule-violation",
                                                           ["/facilityId"])),
        ({"dueAt": _later()}, (422, "business-rule-violation", ["/dueAt"])),  # on a message
        ({"kind": "task", "dueAt": _later(-1)}, (422, "business-rule-violation", ["/dueAt"])),
        ({"title": ""}, (422, "validation-failed", ["/title"])),
        ({"color": "red"}, (422, "validation-failed", ["/color"])),
    ]
    for extra, expected in cases:
        assert _problem(_send(client, c, **extra)) == expected, extra
    # A user who doesn't work at the facility, or can't read messages, isn't an assignee.
    targets: list[tuple[str, str]] = [("user", "md-north"), ("user", "dsp"), ("role", "DSP")]
    for to in targets:
        refused = _send(client, c, to=to)
        assert _problem(refused) == (422, "business-rule-violation", ["/assignee"]), to
    assert _send(client, c, to=("user", "md-b")).status_code == 404  # another clinic's
    assert owner("SELECT count(*) FROM admin.work_item WHERE tenant_id = :t",
                 t=c.clinic)[0][0] == 0


def test_a_message_about_a_restricted_chart_needs_break_glass(client: Any,
                                                              inbox: Clinic) -> None:
    c = inbox
    refused = _send(client, c, patient="restricted")
    assert _problem(refused)[:2] == (403, "break-glass-required")
    denied = [r for r in _audit(c, "md") if r.outcome == "denied"]
    assert [(r.action, r.patient_id) for r in denied] == [
        ("access-denied", c.practice.patients["restricted"])]


def test_only_a_sender_role_may_send(client: Any, inbox: Clinic) -> None:
    for who in ("dsp", "none"):
        assert _problem(_send(client, inbox, who))[:2] == (403, "permission-denied")


# -------------------------------------------------------------------- listInboxItems, summary
def test_each_user_sees_only_their_own_items(client: Any, inbox: Clinic) -> None:
    c = inbox
    item = _send(client, c).json()["id"]
    queued = _send(client, c, to=("role", "FD"), patient=None).json()["id"]

    def ids(who: str, **query: str) -> list[str]:
        return [i["id"] for i in client(who).get(INBOX, params=query).json()["items"]]

    assert ids("rn") == [item] and ids("rn", view="mine") == [item]
    assert ids("md") == [] and set(ids("md", view="sent")) == {item, queued}
    assert ids("fd") == [queued] and ids("fd", view="queue") == [queued]
    assert ids("fd", view="mine") == []
    assert set(ids("adm", view="facility")) == {item, queued}
    # Another facility, another clinic, another person's item: as if it didn't exist.
    for who in ("md-north", "md-b", "fd", "ma"):
        assert _get(client, who, item).status_code == 404, who
    assert ids("md-north") == [] and ids("md-b") == []
    # view=facility is for ADM only; a facility not theirs is 404.
    assert _problem(client("rn").get(INBOX, params={"view": "facility"})) == (
        422, "business-rule-violation", ["view"])
    assert client("rn").get(INBOX, params={
        "facilityId": str(c.practice.other_facility)}).status_code == 404
    # Filters and the audit row naming the patients listed.
    assert ids("rn", status="completed") == []
    assert ids("rn", priority="stat") == [] and ids("rn", priority="routine") == [item]
    assert ids("rn", itemType="task") == [] and ids("rn", itemType="message") == [item]
    assert ids("rn", patientId=str(c.practice.patients["marcus"])) == []
    assert ids("rn", dueBefore=_later()) == []
    reads = [r for r in _audit(c, "rn") if r.action == "read"]
    assert reads[0].patient_id == c.practice.patients["kaia"]


def test_the_list_is_ordered_and_paged(client: Any, inbox: Clinic) -> None:
    c = inbox
    routine = _send(client, c).json()["id"]
    stat = _send(client, c, priority="stat").json()["id"]
    due = _send(client, c, kind="task", dueAt=_later(2)).json()["id"]
    first = client("rn").get(INBOX, params={"limit": 2}).json()
    assert [i["id"] for i in first["items"]] == [stat, due]
    rest = client("rn").get(INBOX, params={"limit": 2, "cursor": first["nextCursor"]}).json()
    assert [i["id"] for i in rest["items"]] == [routine] and "nextCursor" not in rest
    assert "thread" not in first["items"][0]
    assert client("rn").get(INBOX, params={"cursor": "%%bad"}).status_code in (400, 422)


def test_the_summary_counts_the_assigned_view(client: Any, inbox: Clinic) -> None:
    c = inbox
    _send(client, c)
    _send(client, c, kind="task", dueAt=_later(1))
    _send(client, c, to=("role", "RN"), patient=None)
    _send(client, c, to=("user", "ma"))
    found = client("rn").get(f"{INBOX}/summary")
    assert found.status_code == 200
    assert found.json() == {"total": 3, "overdue": 0, "byType": [
        {"itemType": "message", "open": 2, "inProgress": 0, "onHold": 0, "overdue": 0},
        {"itemType": "task", "open": 1, "inProgress": 0, "onHold": 0, "overdue": 0}]}
    assert _audit(c, "rn") == []  # counts only: not audited


def test_reading_the_inbox_needs_inbox_read(client: Any, inbox: Clinic) -> None:
    item = _send(client, inbox).json()["id"]
    for path in (INBOX, f"{INBOX}/summary", f"{INBOX}/{item}"):
        for who in ("dsp", "none"):
            assert _problem(client(who).get(path))[:2] == (403, "permission-denied"), path


# ---------------------------------------------------------------------------- getInboxItem
def test_one_item_with_its_etag_and_the_patient_audited(client: Any, inbox: Clinic) -> None:
    c = inbox
    item = _send(client, c).json()["id"]
    found = _get(client, "rn", item)
    assert found.status_code == 200 and found.headers["ETag"].startswith('"')
    assert found.json()["thread"][0]["event"] == "created"
    (row,) = _audit(c, "rn")
    assert (row.action, row.category, row.patient_id, row.entity_type, row.entity_id) == (
        "read", "phi-read", c.practice.patients["kaia"], "inbox", item)


def test_a_kind_the_user_may_not_read_is_not_found(client: Any, inbox: Clinic) -> None:
    c = inbox
    cosign = work_item(c, item_type="cosign", title="Note to co-sign",
                       assigned_role_id=c.roles["ADM"], patient_id=c.practice.patients["kaia"])
    assert _get(client, "adm", str(cosign)).status_code == 404  # ADM lacks notes:read
    assert client("adm").get(INBOX, params={"view": "facility"}).json()["items"] == []


# ------------------------------------------------------------------------ restricted charts
def test_a_restricted_chart_is_masked_and_its_filter_refused(client: Any, inbox: Clinic) -> None:
    c = inbox
    restricted = c.practice.patients["restricted"]
    task = work_item(c, item_type="task", title="Call her about the biopsy",
                     body="Results are in.", assigned_role_id=c.roles["MA"],
                     patient_id=restricted, created_by_user_id=c.id("md"))
    listed = client("ma").get(INBOX).json()["items"]
    assert [(i["id"], i["restricted"], i["title"]) for i in listed] == [
        (str(task), True, "Item about a restricted chart")]
    assert "patient" not in listed[0] and "body" not in listed[0]
    one = _get(client, "ma", str(task)).json()
    assert "patient" not in one and "body" not in one and one["restricted"] is True
    assert [r.patient_id for r in _audit(c, "ma") if r.action == "read"] == [None, None]
    refused = client("ma").get(INBOX, params={"patientId": str(restricted)})
    assert _problem(refused)[:2] == (403, "break-glass-required")
    assert _audit(c, "ma")[-1].patient_id == restricted
    # With a break-glass grant the item shows everything.
    owner("INSERT INTO audit.break_glass_access (id, tenant_id, patient_id, user_id, "
          "reason_code, granted_at, expires_at) VALUES (gen_random_uuid(), :t, :p, :u, "
          "'emergency-care', now(), now() + interval '4 hours')",
          t=c.clinic, p=restricted, u=c.id("ma"))
    opened = _get(client, "ma", str(task)).json()
    assert (opened["restricted"], opened["title"], opened["body"]) == (
        False, "Call her about the biopsy", "Results are in.")


def test_a_restricted_patients_message_takes_staff_replies_only(client: Any,
                                                                inbox: Clinic) -> None:
    c = inbox
    restricted = c.practice.patients["restricted"]
    thread = str(portal_message(c.clinic, restricted, SUBJECT, ASK))
    item = _get(client, "ma", thread).json()
    assert (item["restricted"], item["title"]) == (True, "Item about a restricted chart")
    assert [("comment" not in e) for e in item["thread"]] == [True, True]
    refused = client("ma").post(f"{INBOX}/{thread}/replies",
                                json={"text": "Take it with food.", "toPatient": True})
    assert _problem(refused)[:2] == (403, "break-glass-required")
    assert _audit(c, "ma")[-1].patient_id == restricted
    staff = client("ma").post(f"{INBOX}/{thread}/replies", json={"text": "Flag for MD."})
    assert staff.status_code == 200, staff.text
    assert all("comment" not in e for e in staff.json()["thread"])
    assert _audit(c, "ma")[-1].patient_id == restricted  # a write names the patient
    seen = as_portal(c.clinic, restricted, "SELECT body FROM admin.portal_message_thread(:t)",
                     t=thread)
    assert [r.body for r in seen] == [ASK]


# --------------------------------------------------------------------------- updateInboxItem
def test_taking_an_item_from_the_queue_needs_the_current_etag(client: Any,
                                                              inbox: Clinic) -> None:
    c = inbox
    item = _send(client, c, to=("role", "FD")).json()["id"]
    tag = _get(client, "fd", item).headers["ETag"]
    assert _problem(_patch(client, "fd", item, {"assignee": {
        "type": "user", "id": str(c.id("fd"))}}, None))[:2] == (428, "precondition-required")
    taken = _patch(client, "fd", item, {"assignee": {"type": "user", "id": str(c.id("fd"))}},
                   tag)
    assert taken.status_code == 200, taken.text
    assert taken.json()["assignee"]["id"] == str(c.id("fd")) and taken.headers["ETag"] != tag
    assert [e["event"] for e in taken.json()["thread"]] == ["created", "assigned"]
    # A colleague with the old ETag is too late.
    late = _patch(client, "fd2", item, {"assignee": {"type": "user", "id": str(c.id("fd2"))}},
                  tag)
    assert _problem(late)[:2] == (412, "precondition-failed")
    assert "ETag" not in late.headers  # the item has left fd2's hands
    current = _patch(client, "fd2", item, {"status": "on-hold"}, taken.headers["ETag"])
    assert current.status_code == 404
    assert [(e.type, e.target_user_id) for e in _events(item)][-1] == (
        "inbox.item-assigned", c.id("fd"))
    assert _audit(c, "fd")[-1].patient_id == c.practice.patients["kaia"]


def test_only_the_assignee_changes_the_status(client: Any, inbox: Clinic) -> None:
    c = inbox
    item = _send(client, c).json()["id"]
    tag = _get(client, "md", item).headers["ETag"]
    by_sender = _patch(client, "md", item, {"status": "in-progress"}, tag)
    assert _problem(by_sender) == (422, "business-rule-violation", ["/status"])
    tag = _get(client, "rn", item).headers["ETag"]
    started = _patch(client, "rn", item, {"status": "in-progress"}, tag)
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "in-progress"
    step = started.json()["thread"][-1]
    assert (step["event"], step["fromStatus"], step["toStatus"]) == (
        "status-change", "open", "in-progress")
    # The sender may change the priority and the due time; nobody else may reassign.
    tag = started.headers["ETag"]
    urgent = _patch(client, "md", item, {"priority": "urgent", "dueAt": _later()}, tag)
    assert urgent.status_code == 200 and urgent.json()["priority"] == "urgent"
    assert _problem(_patch(client, "md", item, {"assignee": {
        "type": "user", "id": str(c.id("ma"))}}, urgent.headers["ETag"]))[:2] == (
        403, "permission-denied")
    assert _problem(_patch(client, "md", item, {"dueAt": _later(-2)},
                           urgent.headers["ETag"])) == (
        422, "business-rule-violation", ["/dueAt"])
    assert _problem(_patch(client, "md", item, {}, urgent.headers["ETag"]))[:2] == (
        422, "validation-failed")


def test_an_administrator_reassigns_at_their_facility(client: Any, inbox: Clinic) -> None:
    c = inbox
    item = _send(client, c).json()["id"]
    tag = _get(client, "adm", item).headers["ETag"]
    moved = _patch(client, "adm", item, {"assignee": {"type": "user", "id": str(c.id("ma"))}},
                   tag)
    assert moved.status_code == 200 and moved.json()["assignee"]["id"] == str(c.id("ma"))
    wrong = _patch(client, "adm", item, {"assignee": {"type": "user",
                                                       "id": str(c.id("md-north"))}},
                   moved.headers["ETag"])
    assert _problem(wrong) == (422, "business-rule-violation", ["/assignee"])


def test_updating_needs_inbox_update(client: Any, inbox: Clinic) -> None:
    item = _send(client, inbox).json()["id"]
    assert _problem(_patch(client, "dsp", item, {"status": "on-hold"}, '"1"'))[:2] == (
        403, "permission-denied")


# --------------------------------------------------------------------- complete and cancel
def test_the_assignee_completes_a_task(client: Any, inbox: Clinic) -> None:
    c = inbox
    item = _send(client, c, kind="task").json()["id"]
    assert _problem(client("md").post(f"{INBOX}/{item}/complete"))[:2] == (
        403, "permission-denied")
    done = client("rn").post(f"{INBOX}/{item}/complete", json={"comment": "Rechecked: 128/82."})
    assert done.status_code == 200, done.text
    found = done.json()
    assert found["status"] == "completed" and found["completedBy"]["id"] == str(c.id("rn"))
    assert found["completedAt"] and found["thread"][-1]["comment"] == "Rechecked: 128/82."
    assert [(e.type, e.target_user_id, e.data) for e in _events(item)][1:] == [
        ("inbox.item-completed", c.id("rn"), {"itemType": "task", "status": "completed"}),
        ("inbox.item-completed", c.id("md"), {"itemType": "task", "status": "completed"})]
    again = client("rn").post(f"{INBOX}/{item}/complete")
    assert _problem(again)[:2] == (409, "invalid-state-transition")
    assert again.json()["currentState"] == "completed"
    assert _audit(c, "rn")[-1].patient_id == c.practice.patients["kaia"]


def test_kinds_completed_by_their_action_are_refused(client: Any, inbox: Clinic) -> None:
    c = inbox
    for kind in ("cosign", "result-review", "unsigned-note"):
        item = work_item(c, item_type=kind, title="Work to do", assigned_user_id=c.id("md"),
                         patient_id=c.practice.patients["kaia"])
        refused = client("md").post(f"{INBOX}/{item}/complete")
        assert _problem(refused) == (422, "business-rule-violation", ["/itemType"]), kind
        assert refused.json()["detail"].startswith("This item is completed by")


def test_completing_needs_inbox_complete(client: Any, inbox: Clinic) -> None:
    item = _send(client, inbox).json()["id"]
    assert _problem(client("dsp").post(f"{INBOX}/{item}/complete"))[:2] == (
        403, "permission-denied")


def test_only_the_sender_cancels_a_message(client: Any, inbox: Clinic) -> None:
    c = inbox
    item = _send(client, c).json()["id"]
    wrong = {"reason": "Sent to the wrong person."}
    assert _problem(client("rn").post(f"{INBOX}/{item}/cancel", json=wrong))[:2] == (
        403, "permission-denied")
    cancelled = client("md").post(f"{INBOX}/{item}/cancel", json=wrong)
    assert cancelled.status_code == 200, cancelled.text
    found = cancelled.json()
    assert (found["status"], found["completedBy"]["id"]) == ("cancelled", str(c.id("md")))
    assert found["thread"][-1]["comment"] == "Sent to the wrong person."
    assert _events(item)[-1].data == {"itemType": "message", "status": "cancelled"}
    assert _problem(client("md").post(f"{INBOX}/{item}/cancel", json=wrong))[:2] == (
        409, "invalid-state-transition")
    cosign = work_item(c, item_type="cosign", title="Note to co-sign",
                       assigned_user_id=c.id("md"), created_by_user_id=c.id("md"))
    assert _problem(client("md").post(f"{INBOX}/{cosign}/cancel", json=wrong)) == (
        422, "business-rule-violation", ["/itemType"])
    assert _problem(client("dsp").post(f"{INBOX}/{item}/cancel", json=wrong))[:2] == (
        403, "permission-denied")


# --------------------------------------------------------------------------- replyToInboxItem
def test_replies_hand_a_message_between_sender_and_assignee(client: Any,
                                                            inbox: Clinic) -> None:
    c = inbox
    item = _send(client, c).json()["id"]
    answered = client("rn").post(f"{INBOX}/{item}/replies",
                                 json={"text": "Rechecked: 128/82 seated."})
    assert answered.status_code == 200, answered.text
    assert answered.json()["assignee"]["id"] == str(c.id("md"))
    assert [e["event"] for e in answered.json()["thread"]] == ["created", "comment", "assigned"]
    assert answered.json()["thread"][1]["by"]["id"] == str(c.id("rn"))
    back = client("md").post(f"{INBOX}/{item}/replies", json={"text": "Thanks, recheck at 6."})
    assert back.json()["assignee"]["id"] == str(c.id("rn"))
    kept = client("md").post(f"{INBOX}/{item}/replies",
                             json={"text": "One more thing.", "assignBack": False})
    assert kept.json()["assignee"]["id"] == str(c.id("rn"))
    # Someone else's reply never moves it.
    other = client("adm").post(f"{INBOX}/{item}/replies", json={"text": "Noted."})
    assert other.status_code == 200 and other.json()["assignee"]["id"] == str(c.id("rn"))
    handed = [(e.target_user_id, e.data) for e in _events(item)][1:]
    assert handed == [(c.id("md"), {"itemType": "message", "priority": "routine"}),
                      (c.id("rn"), {"itemType": "message", "priority": "routine"})]
    assert _audit(c, "rn")[-1].patient_id == c.practice.patients["kaia"]


def test_a_reply_to_the_patient_is_for_patient_messages_only(client: Any,
                                                             inbox: Clinic) -> None:
    c = inbox
    item = _send(client, c).json()["id"]
    refused = client("rn").post(f"{INBOX}/{item}/replies", json={"text": "Hi",
                                                                 "toPatient": True})
    assert _problem(refused) == (422, "validation-failed", ["/toPatient"])
    for who in ("dsp", "none"):
        assert _problem(client(who).post(f"{INBOX}/{item}/replies",
                                         json={"text": "Hi"}))[:2] == (403, "permission-denied")
    client("md").post(f"{INBOX}/{item}/cancel", json={"reason": "Not needed."})
    closed = client("rn").post(f"{INBOX}/{item}/replies", json={"text": "Too late?"})
    assert _problem(closed)[:2] == (409, "invalid-state-transition")


def test_staff_answer_a_patient_message_and_close_it(client: Any, inbox: Clinic) -> None:
    c = inbox
    kaia = c.practice.patients["kaia"]
    thread = str(portal_message(c.clinic, kaia, SUBJECT, ASK))
    listed = client("ma").get(INBOX).json()["items"]
    assert [(i["id"], i["itemType"], i["title"]) for i in listed] == [
        (thread, "patient-message", SUBJECT)]
    assert "createdBy" not in listed[0] and listed[0]["assignee"]["type"] == "role"
    note = client("ma").post(f"{INBOX}/{thread}/replies",
                             json={"text": "Internal: check her creatinine first."})
    assert note.status_code == 200, note.text
    assert note.json()["assignee"]["type"] == "role"  # a patient message is never handed back
    sent = client("ma").post(f"{INBOX}/{thread}/replies",
                             json={"text": "Yes, take it with food.", "toPatient": True})
    assert sent.status_code == 200, sent.text
    comments = [e for e in sent.json()["thread"] if e["event"] == "comment"]
    assert [(e.get("fromPatient"), e.get("toPatient"), "by" in e) for e in comments] == [
        (True, None, False), (None, None, True), (None, True, True)]
    seen = as_portal(c.clinic, kaia, "SELECT author, body FROM admin.portal_message_thread(:t)",
                     t=thread)
    assert [(r.author, r.body) for r in seen] == [
        ("patient", ASK), ("clinic", "Yes, take it with food.")]
    done = client("ma").post(f"{INBOX}/{thread}/complete")  # a holder of its role
    assert done.status_code == 200 and done.json()["status"] == "completed"
    status = as_portal(c.clinic, kaia, "SELECT status FROM admin.portal_message_threads(5, 0)")
    assert [r.status for r in status] == ["closed"]
    # No event carries a subject or a message (D81).
    everything = json.dumps([list(map(str, r)) for r in owner(
        "SELECT type, subject, data FROM admin.event_log WHERE tenant_id = :t", t=c.clinic)])
    for words in (SUBJECT, ASK, "creatinine", "food"):
        assert words not in everything
    assert [r.patient_id for r in _audit(c, "ma") if r.action != "read"] == [kaia] * 3


def test_another_role_cannot_close_a_patient_message(client: Any, inbox: Clinic) -> None:
    c = inbox
    thread = str(portal_message(c.clinic, c.practice.patients["kaia"], SUBJECT, ASK))
    tag = _get(client, "adm", thread).headers["ETag"]
    moved = _patch(client, "adm", thread, {"assignee": {"type": "user", "id": str(c.id("rn"))}},
                   tag)
    assert moved.status_code == 200
    assert _problem(client("ma").post(f"{INBOX}/{thread}/cancel",
                                      json={"reason": "Duplicate."}))[:2] == (404, "not-found")
    cancelled = client("rn").post(f"{INBOX}/{thread}/cancel", json={"reason": "Duplicate."})
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"


def test_a_merged_chart_takes_no_new_message(client: Any, inbox: Clinic) -> None:
    c = inbox
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, c.clinic)
    try:  # the merge's link, as merge_patients writes it (D103)
        db.execute(text("INSERT INTO clinical.patient_link (id, tenant_id, patient_id, "
                        "other_patient_id, type) VALUES (gen_random_uuid(), :t, :m, :k, "
                        "'replaced-by')"), {"t": c.clinic, "m": c.practice.patients["marcus"],
                                            "k": c.practice.patients["kaia"]})
        db.commit()
    finally:
        db.close()
        admin.dispose()
    assert _problem(_send(client, c, patient="marcus"))[:2] == (409, "patient-merged")


def test_one_idempotency_key_sends_one_message(client: Any, inbox: Clinic) -> None:
    c = inbox
    key = {"Idempotency-Key": str(uuid.uuid4())}
    body = {"kind": "message", "assignee": {"type": "user", "id": str(c.id("rn"))},
            "facilityId": str(c.practice.facility), "title": TITLE}
    first = client("md").post(MESSAGES, json=body, headers=key)
    again = client("md").post(MESSAGES, json=body, headers=key)
    assert first.status_code == 201 and again.status_code in (201, 409)
    assert owner("SELECT count(*) FROM admin.work_item WHERE tenant_id = :t",
                 t=c.clinic)[0][0] == 1


def test_every_inbox_write_is_audited_with_its_patient_and_no_patient_data(
        client: Any, inbox: Clinic) -> None:
    c = inbox
    kaia = c.practice.patients["kaia"]
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        sent = _send(client, c, kind="task")
        item = sent.json()["id"]
        tag = _get(client, "rn", item).headers["ETag"]
        steps = [
            ("createMessage", sent),
            ("updateInboxItem", _patch(client, "rn", item, {"status": "in-progress"}, tag)),
            ("replyToInboxItem", client("rn").post(f"{INBOX}/{item}/replies",
                                                   json={"text": "Done at 3pm."})),
            ("completeInboxItem", client("md").post(f"{INBOX}/{item}/complete")),
            ("cancelInboxItem", client("md").post(
                f"{INBOX}/{_send(client, c).json()['id']}/cancel",
                json={"reason": "Sent twice."})),
        ]
        for operation, response in steps:
            assert response.status_code in (200, 201), (operation, response.text)
            assert audit_problems(admin, response, operation, tenant=c.clinic,
                                  patient=kaia) == [], operation
            reasons = [r.reason for r in audit_rows(admin, response)]
            assert phi_in(reasons, ["Lindgren118", "Kaia401", TITLE, BODY]) == [], operation
    finally:
        admin.dispose()
