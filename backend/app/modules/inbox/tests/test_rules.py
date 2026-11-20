"""The inbox's pure rules, without a database: the priority mapping, If-Match, the restricted
view (D37), the thread's order and the hand-back. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import replace
from typing import Any

import pytest

from app.core.deps import CurrentUser
from app.core.errors import PreconditionFailed, PreconditionRequired

from .. import service
from ..repository import PRIORITY_STORED, EventRow, ItemRow, ReplyRow, priority_code, version_of

T0 = dt.datetime(2026, 11, 20, 15, 0, tzinfo=dt.UTC)
MD, RN, FD = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
CLINIC, FACILITY = uuid.uuid4(), uuid.uuid4()


def _user(user_id: uuid.UUID, *roles: str) -> CurrentUser:
    return CurrentUser(id=user_id, organization_id=CLINIC, roles=frozenset(roles),
                       facility_ids=frozenset({FACILITY}))


def _row(**changes: Any) -> ItemRow:
    base = ItemRow(
        id=uuid.uuid4(), item_type="message", status="open", priority=4, title="Recheck BP",
        body="Before discharge.", assigned_user_id=RN, assigned_user_name="RN Tester",
        assigned_role_id=None, assigned_role_code=None, assigned_role_name=None,
        facility_id=FACILITY, due_at=None, escalation_level=0, escalated_at=None,
        completed_at=None, completed_by_user_id=None, completed_by_name=None,
        patient_id=uuid.uuid4(), encounter_id=uuid.uuid4(), subject_type=None, subject_id=None,
        created_by_user_id=MD, created_by_name="MD Tester", created_at=T0, updated_at=T0,
        overdue=False)
    return replace(base, **changes)


def _event(event: str, at: dt.datetime, *, by: uuid.UUID | None = None,
           to: uuid.UUID | None = None, comment: str | None = None) -> EventRow:
    return EventRow(event=event, from_status=None, to_status=None, assigned_user_id=to,
                    assigned_name="Someone" if to else None, comment=comment, occurred_at=at,
                    user_id=by, user_name="Someone" if by else None)


def test_priorities_are_stored_stat_first() -> None:
    assert PRIORITY_STORED == {"stat": 1, "asap": 2, "urgent": 3, "routine": 4}
    assert [priority_code(n) for n in (1, 2, 3, 4, 5)] == [
        "stat", "asap", "urgent", "routine", "routine"]


def test_the_etag_is_the_exact_update_time() -> None:
    assert version_of(T0 + dt.timedelta(microseconds=7)) - version_of(T0) == 7
    assert service.if_match_version(service.etag(version_of(T0))) == version_of(T0)
    with pytest.raises(PreconditionRequired):
        service.if_match_version(None)
    for bad in ('W/"1"', "1", '"x"'):
        with pytest.raises(PreconditionFailed):
            service.if_match_version(bad)


def test_a_restricted_item_shows_nothing_of_the_chart() -> None:
    row = _row()
    item = service.to_item(row, open_chart=False)
    assert (item.restricted, item.title, item.body, item.encounter_id, item.patient) == (
        True, service.RESTRICTED_TITLE, None, None, None)
    system = service.to_item(_row(item_type="cosign", title="Note to co-sign"),
                             open_chart=False)
    assert system.title == "Note to co-sign"  # system titles never name a patient
    assert service.to_item(row, open_chart=True).body == "Before discharge."
    assert service.to_item(_row(patient_id=None), open_chart=False).restricted is False
    events = [_event("created", T0, by=MD, to=RN),
              _event("status-change", T0 + dt.timedelta(minutes=1), by=RN, comment="Done.")]
    assert [e.comment for e in service.thread_of(row, events, [], open_chart=False)] == [
        None, None]


def test_a_patient_message_has_no_sender_and_closes_with_its_time() -> None:
    row = _row(item_type="patient-message", created_by_user_id=uuid.uuid4(), status="cancelled",
               completed_by_user_id=FD, completed_by_name="FD Tester",
               updated_at=T0 + dt.timedelta(hours=1))
    item = service.to_item(row, open_chart=True)
    assert item.created_by is None
    assert (item.completed_at, item.completed_by and item.completed_by.id) == (
        T0 + dt.timedelta(hours=1), FD)


def test_the_thread_is_oldest_first_with_a_reply_before_its_hand_back() -> None:
    row = _row(assigned_user_id=MD)
    events = [_event("created", T0, by=MD, to=RN),
              _event("assigned", T0 + dt.timedelta(minutes=5), by=RN, to=MD)]
    replies = [ReplyRow(id=uuid.uuid4(), author_user_id=RN, author_name="RN Tester",
                        from_patient=False, to_patient=False, body="128/82",
                        created_at=T0 + dt.timedelta(minutes=5)),
               ReplyRow(id=uuid.uuid4(), author_user_id=None, author_name=None,
                        from_patient=True, to_patient=True, body="Thanks",
                        created_at=T0 + dt.timedelta(minutes=9))]
    thread = service.thread_of(row, events, replies, open_chart=True)
    assert [(e.event, e.comment) for e in thread] == [
        ("created", None), ("comment", "128/82"), ("assigned", None), ("comment", "Thanks")]
    assert thread[3].by is None and thread[3].from_patient is True
    assert thread[3].to_patient is None


def test_a_role_assignee_shows_on_the_last_assignment() -> None:
    role = uuid.uuid4()
    row = _row(assigned_user_id=None, assigned_role_id=role, assigned_role_code="FD",
               assigned_role_name="Front desk")
    thread = service.thread_of(row, [_event("created", T0, by=MD)], [], open_chart=True)
    assert thread[0].assignee is not None and thread[0].assignee.id == role


def test_a_reply_hands_the_item_to_the_other_party() -> None:
    created = [_event("created", T0, by=MD, to=RN)]
    with_rn = _row()
    assert service.hand_back_to(_user(RN, "RN"), with_rn, created) == MD
    assert service.hand_back_to(_user(MD, "MD"), with_rn, created) is None  # already with RN
    with_md = _row(assigned_user_id=MD)
    handed = [*created, _event("assigned", T0 + dt.timedelta(minutes=1), by=RN, to=MD)]
    assert service.hand_back_to(_user(MD, "MD"), with_md, handed) == RN
    assert service.hand_back_to(_user(FD, "FD"), with_rn, created) is None  # a third party
    queued = _row(assigned_user_id=None, assigned_role_code="FD")
    assert service.hand_back_to(_user(FD, "FD"), queued, created) == MD
    # From a role queue back to the sender, then the sender answers the one who replied.
    from_queue = [_event("created", T0, by=MD),
                  _event("assigned", T0 + dt.timedelta(minutes=1), by=FD, to=MD)]
    assert service.hand_back_to(_user(MD, "MD"), with_md, from_queue) == FD
    assert service.hand_back_to(_user(RN, "RN"), _row(item_type="patient-message"),
                                created) is None


def test_each_kind_is_read_with_its_own_permission() -> None:
    assert service.readable_kinds(_user(FD, "FD")) == [
        "document-review", "eligibility", "fax-indexing", "message", "patient-message", "task"]
    assert "result-review" not in service.readable_kinds(_user(FD, "ADM"))
    assert service.readable_kinds(_user(FD, "DSP")) == []
    assert set(service.COMPLETED_BY_ACTION) <= set(service.KIND_PERMISSION)
