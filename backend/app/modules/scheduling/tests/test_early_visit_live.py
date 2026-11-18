"""A visit can be checked in, roomed and started at any time on its own day, before its booked
time (the demo's 24-hour clinic, #85, 17 Nov). Check-in and "arrived" only need the visit's day
in the facility's zone (scheduling/service.py check_in, record_status); rooming and with-provider
have no time rule. These tests pin that. Synthetic data only."""

from __future__ import annotations

import datetime as dt
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from app.db.tests.conftest import TEST_DATABASE_URL

from .conftest import ZONE, Practice
from .test_check_in_live import _check_in, _today_appointment

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
LATE_HOUR = 23  # booked at 23:00 facility time, so the test runs before it


def _later_today(practice: Practice) -> str:
    if dt.datetime.now(ZoneInfo(ZONE)).hour >= LATE_HOUR:
        pytest.skip("runs before 23:00 facility time, so the visit is still ahead")
    return _today_appointment(practice, hour=LATE_HOUR)


def _status(client: Any, appointment_id: str, user: str, **body: Any) -> Any:
    return client(user).post(f"{API}/appointments/{appointment_id}/status", json=body)


def test_a_visit_is_checked_in_roomed_and_started_before_its_booked_time(
        client: Any, practice: Practice) -> None:
    appointment = _later_today(practice)
    checked_in = _check_in(client, appointment, selfPay=True)
    assert checked_in.status_code == 200, checked_in.text
    roomed = _status(client, appointment, "ma", status="roomed",
                     roomLocationId=str(practice.room))
    assert roomed.status_code == 200, roomed.text
    assert roomed.json()["visitStatus"] == "roomed"
    started = _status(client, appointment, "md", status="with-provider")
    assert started.status_code == 200, started.text
    assert started.json()["visitStatus"] == "with-provider"


def test_arrival_is_recorded_before_the_booked_time(client: Any, practice: Practice) -> None:
    appointment = _later_today(practice)
    arrived = _status(client, appointment, "fd", status="arrived")
    assert arrived.status_code == 200, arrived.text
    checked_in = _check_in(client, appointment, selfPay=True)
    assert checked_in.status_code == 200, checked_in.text


def test_permission_denied_for_a_role_that_does_not_room(client: Any, practice: Practice) -> None:
    appointment = _later_today(practice)
    assert _check_in(client, appointment, selfPay=True).status_code == 200
    denied = _status(client, appointment, "fd", status="roomed",
                     roomLocationId=str(practice.room))
    assert denied.status_code == 403
