"""The patient portal's appointment reads against a live database (B8a, D84, D93; #269, #271):
the real app, portal_db as shri_portal with its own-chart policies, core's patient development
sign-in (X-Dev-Patient, D108) and core's audit. Two synthetic patients in one clinic
(portal_live.py). Synthetic data only."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.core.deps import DEV_USER_HEADER
from app.db.tests.conftest import TEST_DATABASE_URL

from .portal_live import API, PortalChart, audit_rows, portal_client
from .portal_live import portal_app as portal_app  # noqa: F401 (fixture)
from .portal_live import portal_chart as portal_chart  # noqa: F401 (fixture)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

URL = f"{API}/portal/me/appointments"


def _ids(r: Any) -> list[str]:
    assert r.status_code == 200, r.text
    return [item["id"] for item in r.json()["items"]]


def test_patient_a_sees_only_their_own_appointments(
        portal_app: TestClient, portal_chart: PortalChart) -> None:  # noqa: F811
    ids, a = portal_chart.ids, portal_client(portal_app, portal_chart, portal_chart.a)
    upcoming = a.get(URL)
    assert _ids(upcoming) == [str(ids["a-next"]), str(ids["a-cancelled"])]
    nxt = upcoming.json()["items"][0]
    assert nxt["status"] == "booked" and nxt["timeZone"] == "America/Chicago"
    assert nxt["provider"]["displayName"] == "Dr. Avery401 Lindqvist58"
    assert nxt["appointmentType"]["name"] == "Follow-up visit"
    assert nxt["reasonForVisit"] == "Follow-up on headaches."
    assert nxt["telehealth"] is False
    assert (nxt["canCancel"], nxt["canReschedule"]) == (True, False)  # 72 h; cut-offs 24 h, 96 h
    assert upcoming.json()["items"][1]["status"] == "cancelled"
    past = a.get(URL, params={"when": "past"})
    assert _ids(past)[0] == str(ids["a-past"])
    by_id = {item["id"]: item for item in past.json()["items"]}
    assert by_id[str(ids["a-past"])]["visitSummaryId"] == str(ids["a-avs"])
    every = set(_ids(upcoming)) | set(_ids(past))
    assert not every & {str(ids["b-next"]), str(ids["b-past"])}


def test_drafts_and_entered_in_error_appointments_are_not_shown(
        portal_app: TestClient, portal_chart: PortalChart) -> None:  # noqa: F811
    ids, a = portal_chart.ids, portal_client(portal_app, portal_chart, portal_chart.a)
    every = set(_ids(a.get(URL))) | set(_ids(a.get(URL, params={"when": "past"})))
    assert str(ids["a-proposed"]) not in every and str(ids["a-eie-appt"]) not in every
    for key in ("a-proposed", "a-eie-appt"):
        assert a.get(f"{URL}/{ids[key]}").status_code == 404


def test_a_draft_held_or_wrong_summary_is_never_linked(
        portal_app: TestClient, portal_chart: PortalChart) -> None:  # noqa: F811
    ids, a = portal_chart.ids, portal_client(portal_app, portal_chart, portal_chart.a)
    for key in ("a-draft-appt", "a-wrong-appt", "a-held-appt"):
        r = a.get(f"{URL}/{ids[key]}")
        assert r.status_code == 200, r.text
        assert "visitSummaryId" not in r.json()


def test_the_facility_address_is_shown(portal_app: TestClient,
                                       portal_chart: PortalChart) -> None:  # noqa: F811
    r = portal_client(portal_app, portal_chart, portal_chart.a).get(
        f"{URL}/{portal_chart.ids['a-next']}")
    assert r.status_code == 200, r.text
    assert r.json()["facility"]["address"] == {
        "lines": ["100 Test Lane"], "city": "Springfield", "state": "IL",
        "postalCode": "62701", "country": "US"}


def test_another_patients_appointment_is_404_like_a_missing_one(
        portal_app: TestClient, portal_chart: PortalChart) -> None:  # noqa: F811
    a = portal_client(portal_app, portal_chart, portal_chart.a)
    theirs = a.get(f"{URL}/{portal_chart.ids['b-next']}")
    missing = a.get(f"{URL}/{uuid4()}")
    assert theirs.status_code == missing.status_code == 404
    assert theirs.json()["code"] == missing.json()["code"] == "not-found"
    b = portal_client(portal_app, portal_chart, portal_chart.b)
    assert b.get(f"{URL}/{portal_chart.ids['b-next']}").status_code == 200
    assert b.get(f"{URL}/{portal_chart.ids['a-next']}").status_code == 404


def test_reads_are_audited_with_the_patient_as_actor(
        portal_app: TestClient, portal_chart: PortalChart) -> None:  # noqa: F811
    a = portal_client(portal_app, portal_chart, portal_chart.a)
    assert a.get(URL).status_code == 200
    assert a.get(f"{URL}/{portal_chart.ids['a-next']}").status_code == 200
    rows = audit_rows(portal_chart.practice.clinic)
    assert [(r.actor_type, r.actor_user_id, r.patient_id, r.category) for r in rows] == [
        ("patient", None, portal_chart.a, "phi-read")] * 2


@pytest.mark.parametrize("path", ["", "/{id}"])
def test_a_staff_session_is_refused(portal_app: TestClient, portal_chart: PortalChart,  # noqa: F811
                                    path: str) -> None:
    r = portal_app.get(URL + path.format(id=portal_chart.ids["a-next"]),
                       headers={DEV_USER_HEADER: "fd"})
    assert r.status_code == 401


def test_invalid_parameters_are_refused(portal_app: TestClient,
                                        portal_chart: PortalChart) -> None:  # noqa: F811
    a = portal_client(portal_app, portal_chart, portal_chart.a)
    assert a.get(URL, params={"when": "later"}).status_code == 422
    assert a.get(f"{URL}/not-a-uuid").status_code == 422
