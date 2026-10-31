"""The patient portal's visit summaries against a live database (B8a, D84, D86, D90, D93; #278,
#279): the real app, portal_db as shri_portal with its own-chart policies and
``admin.portal_held_items()``, core's patient development sign-in (X-Dev-Patient, D108) and
core's audit. Two synthetic patients in one clinic (scheduling's portal_live.py). Synthetic data
only."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.core.deps import DEV_USER_HEADER
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.portal_live import API, PortalChart, audit_rows, portal_client
from app.modules.scheduling.tests.portal_live import (  # noqa: F401 (fixtures)
    portal_app as portal_app,
)
from app.modules.scheduling.tests.portal_live import (  # noqa: F401 (fixtures)
    portal_chart as portal_chart,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

URL = f"{API}/portal/me/visit-summaries"


def _items(r: Any) -> list[dict[str, Any]]:
    assert r.status_code == 200, r.text
    return list(r.json()["items"])


def test_patient_a_lists_their_released_and_held_summaries_only(
        portal_app: TestClient, portal_chart: PortalChart) -> None:  # noqa: F811
    ids = portal_chart.ids
    items = _items(portal_client(portal_app, portal_chart, portal_chart.a).get(URL))
    assert [i["id"] for i in items] == [str(ids["a-avs"]), str(ids["a-held-avs"])]
    available, held = items
    assert available["releaseStatus"] == "available"
    assert available["providerDisplayName"] == "Dr. Avery401 Lindqvist58"
    assert available["facilityName"] == "Main office (synthetic)"
    assert "availableAt" in available
    assert held == {"id": str(ids["a-held-avs"]), "visitDate": held["visitDate"],
                    "releaseStatus": "held"}


def test_drafts_and_entered_in_error_summaries_are_not_shown(
        portal_app: TestClient, portal_chart: PortalChart) -> None:  # noqa: F811
    ids, a = portal_chart.ids, portal_client(portal_app, portal_chart, portal_chart.a)
    listed = {i["id"] for i in _items(a.get(URL))}
    for key in ("a-draft-avs", "a-wrong-avs"):
        assert str(ids[key]) not in listed
        assert a.get(f"{URL}/{ids[key]}").status_code == 404


def test_patient_a_never_sees_patient_b_summaries(
        portal_app: TestClient, portal_chart: PortalChart) -> None:  # noqa: F811
    ids = portal_chart.ids
    a = portal_client(portal_app, portal_chart, portal_chart.a)
    assert str(ids["b-avs"]) not in {i["id"] for i in _items(a.get(URL))}
    theirs, missing = a.get(f"{URL}/{ids['b-avs']}"), a.get(f"{URL}/{uuid4()}")
    assert theirs.status_code == missing.status_code == 404
    assert theirs.json()["code"] == missing.json()["code"] == "not-found"
    b = portal_client(portal_app, portal_chart, portal_chart.b)
    assert [i["id"] for i in _items(b.get(URL))] == [str(ids["b-avs"])]  # A's hold isn't B's
    assert b.get(f"{URL}/{ids['a-held-avs']}").status_code == 404


def test_one_summary_and_a_held_one(portal_app: TestClient,
                                    portal_chart: PortalChart) -> None:  # noqa: F811
    ids, a = portal_chart.ids, portal_client(portal_app, portal_chart, portal_chart.a)
    r = a.get(f"{URL}/{ids['a-avs']}")
    assert r.status_code == 200 and r.json()["releaseStatus"] == "available"
    held = a.get(f"{URL}/{ids['a-held-avs']}")
    assert held.status_code == 200 and set(held.json()) == {"id", "visitDate", "releaseStatus"}


def test_reads_are_audited_with_the_patient_as_actor(
        portal_app: TestClient, portal_chart: PortalChart) -> None:  # noqa: F811
    assert portal_client(portal_app, portal_chart, portal_chart.a).get(URL).status_code == 200
    rows = audit_rows(portal_chart.practice.clinic)
    assert [(r.actor_type, r.patient_id, r.category) for r in rows] == [
        ("patient", portal_chart.a, "phi-read")]


@pytest.mark.parametrize("path", ["", "/{id}"])
def test_a_staff_session_is_refused(portal_app: TestClient, portal_chart: PortalChart,  # noqa: F811
                                    path: str) -> None:
    r = portal_app.get(URL + path.format(id=portal_chart.ids["a-avs"]),
                       headers={DEV_USER_HEADER: "md"})
    assert r.status_code == 401
