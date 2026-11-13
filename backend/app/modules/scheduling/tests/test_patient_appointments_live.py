"""listPatientAppointments (#292) against the live database: newest first, paging, the optional
day range with no cap, the user's facilities only, another clinic, a restricted chart and the
permission. Synthetic data only."""

from __future__ import annotations

from typing import Any

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL

from .conftest import ZONE, Practice
from .facility_scope import appointment_today, staff
from .test_scheduling_live import _book

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"


def _history(client: Any, practice: Practice, user: str = "fd", patient: str = "kaia",
             **params: Any) -> Any:
    return client(user).get(f"{API}/patients/{practice.patients[patient]}/appointments",
                            params=params)


def test_a_patients_appointments_newest_first_paged_and_by_day(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    early = _book(client, practice, hour=9)
    middle = _book(client, practice, hour=11)
    late = _book(client, practice, hour=15)
    cancelled = client("fd").post(f"{API}/appointments/{middle['id']}/cancel",
                                  json={"reasonCode": "patient-request"})
    assert cancelled.status_code == 200
    _book(client, practice, patient="marcus", hour=10)  # another patient's
    found = _history(client, practice)
    assert found.status_code == 200, found.text
    body = found.json()
    assert [a["id"] for a in body["items"]] == [late["id"], middle["id"], early["id"]]
    assert body["items"][1]["status"] == "cancelled"  # kept, with its status
    assert body["timeZone"] == ZONE and "nextCursor" not in body
    first = _history(client, practice, limit=2)
    assert [a["id"] for a in first.json()["items"]] == [late["id"], middle["id"]]
    rest = _history(client, practice, limit=2, cursor=first.json()["nextCursor"])
    assert [a["id"] for a in rest.json()["items"]] == [early["id"]]
    day = practice.day.isoformat()
    assert len(_history(client, practice, dateFrom=day, dateTo=day).json()["items"]) == 3
    tomorrow = (practice.day.toordinal() + 1)
    later = practice.day.fromordinal(tomorrow).isoformat()
    assert _history(client, practice, dateFrom=later).json()["items"] == []
    assert len(_history(client, practice, dateTo=day).json()["items"]) == 3  # open start
    backwards = _history(client, practice, dateFrom=later, dateTo=day)
    assert backwards.status_code == 422 and backwards.json()["errors"] == [
        {"in": "query", "name": "dateTo", "code": "out-of-range"}]
    assert _history(client, practice, cursor="nope").status_code == 400


def test_a_patients_appointments_keep_to_the_users_facilities(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    p = practice
    staff(p, users, "fd-a2", "fd", facility=p.other_facility)
    mine = _book(client, p, hour=9)
    theirs = appointment_today(p, "kaia", facility=p.other_facility, provider=p.other_provider,
                               hour=14)
    at_a1 = [a["id"] for a in _history(client, p).json()["items"]]
    assert at_a1 == [mine["id"]] and theirs not in at_a1
    at_a2 = [a["id"] for a in _history(client, p, user="fd-a2").json()["items"]]
    assert at_a2 == [theirs]
    assert _history(client, p, user="fd-b").status_code == 404  # another clinic's patient
    assert _history(client, p, user="none").status_code == 403


def test_a_restricted_patients_appointments_need_break_glass(
        client: Any, practice: Practice) -> None:
    refused = _history(client, practice, patient="restricted")
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
