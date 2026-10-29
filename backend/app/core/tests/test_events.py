"""publish()'s rules and the stream's per-user filter, without a database (the database side is in
test_events_postgres.py). Synthetic IDs only."""

import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest

from app.core.db import TENANT_ID_INFO_KEY
from app.core.deps import CurrentUser
from app.core.events import (
    INTERNAL_ONLY,
    READ_PERMISSION,
    SOURCES,
    StoredEvent,
    deliverable,
    envelope,
    publish,
    reset_message,
    sse,
)
from app.core.permissions import is_known_permission

CLINIC = uuid4()
FACILITY, OTHER_FACILITY = uuid4(), uuid4()
SUBJECT = f"appointment/{uuid4()}"


class FakeSession:
    """Records publish()'s insert; enough for its checks."""

    def __init__(self, tenant: UUID | None = CLINIC) -> None:
        self.info: dict[str, Any] = {TENANT_ID_INFO_KEY: tenant} if tenant else {}
        self.params: dict[str, Any] | None = None

    async def execute(self, _statement: Any, params: dict[str, Any]) -> None:
        self.params = params


async def test_publish_adds_one_row_to_the_callers_transaction() -> None:
    db = FakeSession()
    event_id = await publish(db, "appointment.checked-in", SUBJECT,  # type: ignore[arg-type]
                             {"encounterId": str(uuid4()), "status": "arrived", "late": False},
                             facility_id=FACILITY)
    assert db.params is not None and db.params["id"] == event_id
    assert db.params["tenant"] == CLINIC and db.params["facility"] == FACILITY
    assert json.loads(db.params["data"])["status"] == "arrived"


@pytest.mark.parametrize(("type_", "subject", "data", "message"), [
    ("Appointment.CheckedIn", SUBJECT, {}, "family.action"),
    ("appointment", SUBJECT, {}, "family.action"),
    ("rocket.launched", SUBJECT, {}, "not in the catalogue"),
    ("appointment.booked", "appointment/not-a-uuid", {}, "<resource>/<uuid>"),
    ("appointment.booked", "Kaia Lindgren", {}, "<resource>/<uuid>"),
    ("appointment.booked", SUBJECT, {"name": "x" * 121}, "IDs or statuses"),
    ("appointment.booked", SUBJECT, {"count": -1}, "counts"),
    ("appointment.booked", SUBJECT, {"note": {"free": "text"}}, "only IDs"),
    ("appointment.booked", SUBJECT, {"score": 1.5}, "only IDs"),
    ("appointment.booked", SUBJECT, {"Bad Name": "x"}, "camelCase"),
    ("appointment.booked", SUBJECT, {f"m{n}": n for n in range(21)}, "more than 20"),
])
async def test_publish_refuses_anything_but_thin_events(
        type_: str, subject: str, data: dict[str, Any], message: str) -> None:
    db = FakeSession()
    with pytest.raises(ValueError, match=message):
        await publish(db, type_, subject, data)  # type: ignore[arg-type]
    assert db.params is None


async def test_publish_needs_a_clinic_session() -> None:
    with pytest.raises(RuntimeError, match="clinic session"):
        await publish(FakeSession(tenant=None), "appointment.booked", SUBJECT)  # type: ignore[arg-type]


async def test_a_target_role_must_be_a_role_code() -> None:
    with pytest.raises(ValueError, match="role code"):
        await publish(FakeSession(), "inbox.item-assigned", f"inbox-item/{uuid4()}",  # type: ignore[arg-type]
                      target_role_code="front desk")


# -------------------------------------------------------------------------------- the filter
def _user(*roles: str, facility: UUID = FACILITY, user_id: UUID | None = None) -> CurrentUser:
    return CurrentUser(id=user_id or uuid4(), organization_id=CLINIC, roles=frozenset(roles),
                       facility_ids=frozenset({facility}))


def _event(type_: str = "appointment.checked-in", subject: str = SUBJECT,
           **columns: Any) -> StoredEvent:
    return StoredEvent(seq=1, id=uuid4(), type=type_, subject=subject, data={"status": "x"},
                       created_at=datetime(2026, 11, 20, 15, 0, tzinfo=UTC), **columns)


def test_an_event_goes_to_users_who_may_read_its_subject() -> None:
    event = _event(facility_id=FACILITY)
    assert deliverable(event, _user("FD"))
    assert not deliverable(event, _user("SUP"))  # no appointments:read
    assert not deliverable(event, _user("DSP"))  # the shared display reads the board, not this


def test_an_event_at_another_facility_is_not_sent() -> None:
    assert not deliverable(_event(facility_id=OTHER_FACILITY), _user("FD"))
    assert deliverable(_event(facility_id=None), _user("FD"))  # practice-wide


def test_internal_events_never_reach_a_browser() -> None:
    patient = f"patient/{uuid4()}"
    for type_ in ("break-glass.granted", "patient.created", "file.scanned"):
        assert type_ in INTERNAL_ONLY
        assert not deliverable(_event(type_, patient), _user("FD", "ADM", "MD", "CO"))


def test_personal_events_go_to_their_target_only() -> None:
    me = uuid4()
    mine = _event("operation.completed", f"operation/{uuid4()}", target_user_id=me)
    assert deliverable(mine, _user("FD", user_id=me))
    assert not deliverable(mine, _user("FD", "ADM"))  # someone else, whatever their roles
    for_desk = _event("inbox.item-assigned", f"inbox-item/{uuid4()}", target_role_code="FD")
    assert deliverable(for_desk, _user("FD"))
    assert not deliverable(for_desk, _user("MA"))


def test_a_subject_without_a_read_rule_and_no_target_goes_to_nobody() -> None:
    assert not deliverable(_event("operation.completed", f"operation/{uuid4()}"), _user("ADM"))


def test_every_read_rule_names_a_known_permission_or_a_pending_one() -> None:
    pending = {"pre-registrations:read"}  # joins the catalogue with T47 (#110)
    unknown = {p for p in READ_PERMISSION.values() if not is_known_permission(p)}
    assert unknown <= pending, unknown


# ------------------------------------------------------------------------------ the envelope
def test_the_envelope_is_cloudevents_without_internal_attributes() -> None:
    event = _event(patient_id=uuid4(), target_user_id=uuid4(), facility_id=FACILITY)
    body = envelope(event, event.data)
    assert set(body) == {"specversion", "id", "type", "source", "subject", "time",
                         "datacontenttype", "data"}
    assert body["source"] == "/scheduling" and body["time"] == "2026-11-20T15:00:00Z"
    assert envelope(event, None)["data"] == {}  # a restricted chart: type and subject only


def test_every_family_has_a_module_source() -> None:
    assert all(source.startswith("/") for source in SOURCES.values())


def test_the_wire_format_is_server_sent_events() -> None:
    text = sse("abc", "appointment.booked", {"id": "abc"})
    assert text == 'id: abc\nevent: appointment.booked\ndata: {"id": "abc"}\n\n'
    assert "event: stream.reset" in reset_message()
