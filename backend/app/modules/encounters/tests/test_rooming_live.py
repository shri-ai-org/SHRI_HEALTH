"""Rooming against a live database (demo step 7), as shri_app, with core's tenant_db, facility
filter, chart check, audit and idempotency and Anand's helpers running for real: the encounter
opened at check-in is read, its reason for visit edited with If-Match, vitals recorded in the
units entered (D69) and listed. Uses scheduling's live fixtures (conftest.py). Synthetic data
only."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import (
    _check_in,
    _sql,
    _today_appointment,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
MERGE = {"Content-Type": "application/merge-patch+json"}
VITALS: dict[str, Any] = {"entries": [
    {"type": "blood-pressure", "bloodPressure": {"systolic": {"value": 142, "unit": "mm[Hg]"},
                                                 "diastolic": {"value": 88, "unit": "mm[Hg]"}}},
    {"type": "body-weight", "value": {"value": 182.4, "unit": "[lb_av]"}},
    {"type": "body-temperature", "value": {"value": 98.6, "unit": "[degF]"}},
]}


def _visit(client: Any, practice: Practice, patient: str = "kaia") -> str:
    """A checked-in visit today; its encounter."""
    appointment = _today_appointment(practice, patient)
    done = _check_in(client, appointment, selfPay=True)
    assert done.status_code == 200, done.text
    encounter: str = done.json()["encounterId"]
    return encounter


def test_the_workspace_after_check_in(client: Any, practice: Practice) -> None:
    encounter = _visit(client, practice)
    found = client("ma").get(f"{API}/encounters/{encounter}")
    assert found.status_code == 200, found.text
    body = found.json()
    assert body["status"] == "arrived" and body["class"] == "AMB"
    assert body["patientId"] == str(practice.patients["kaia"])
    assert body["facilityId"] == str(practice.facility)
    assert body["timeZone"] == "America/Chicago"
    assert body["reasons"] == [{"codings": [], "text": "Follow-up on headaches."}]
    assert body["participants"] == [{"role": "rendering",
                                     "practitionerId": str(practice.provider),
                                     "displayName": "Dr. Avery401 Lindqvist58"}]
    assert body["diagnoses"] == [] and body["vitals"] == [] and body["notes"] == []
    assert found.headers["ETag"].startswith('"')
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE entity_id = :e "
                "AND action = 'read' AND patient_id = :p", e=encounter,
                p=practice.patients["kaia"])[0][0] == 1
    assert client("fd").get(f"{API}/encounters/{encounter}").status_code == 403
    assert client("md-b").get(f"{API}/encounters/{encounter}").status_code == 404
    assert client("ma").get(f"{API}/encounters/nope").status_code == 422


def test_a_restricted_chart_needs_break_glass(client: Any, practice: Practice) -> None:
    encounter = _visit(client, practice, "restricted")
    refused = client("ma").get(f"{API}/encounters/{encounter}")
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    vitals = client("ma").post(f"{API}/encounters/{encounter}/vitals", json=VITALS)
    assert vitals.status_code == 403
    assert _sql(practice, "SELECT count(*) FROM clinical.observation WHERE encounter_id = :e",
                e=encounter)[0][0] == 0


def test_the_reason_for_visit_is_edited_with_if_match(client: Any, practice: Practice) -> None:
    encounter = _visit(client, practice)
    path = f"{API}/encounters/{encounter}"
    tag = client("ma").get(path).headers["ETag"]
    body = {"reasons": [{"text": "Headaches, worse in the morning."}]}
    assert client("ma").patch(path, json=body, headers=MERGE).status_code == 428
    stale = client("ma").patch(path, json=body, headers={"If-Match": '"999"', **MERGE})
    assert stale.status_code == 412 and stale.headers["ETag"] == tag
    done = client("ma").patch(path, json=body, headers={"If-Match": tag, **MERGE})
    assert done.status_code == 200, done.text
    assert done.json()["reasons"] == [{"codings": [],
                                       "text": "Headaches, worse in the morning."}]
    assert done.headers["ETag"] != tag
    assert client("ma").get(path).headers["ETag"] == done.headers["ETag"]
    room = client("ma").patch(path, json={"locationId": str(practice.room)},
                              headers={"If-Match": done.headers["ETag"], **MERGE})
    assert room.status_code == 403  # MA changes the reasons only (T52)
    moved = client("md").patch(path, json={"locationId": str(practice.room)},
                               headers={"If-Match": done.headers["ETag"], **MERGE})
    assert moved.status_code == 200, moved.text
    assert moved.json()["locationId"] == str(practice.room)
    assert client("fd").patch(path, json=body, headers={"If-Match": tag, **MERGE}
                              ).status_code == 403
    assert client("ma").patch(path, json={"reasons": "x"},
                              headers={"If-Match": tag, **MERGE}).status_code == 422


def test_vitals_are_stored_as_entered(client: Any, practice: Practice) -> None:
    encounter = _visit(client, practice)
    done = client("md").post(f"{API}/encounters/{encounter}/vitals", json=VITALS)
    assert done.status_code == 201, done.text
    vitals = done.json()["vitals"]
    assert [v["type"] for v in vitals] == ["blood-pressure", "body-weight", "body-temperature"]
    assert vitals[0]["bloodPressure"] == {"systolic": {"value": 142.0, "unit": "mm[Hg]"},
                                          "diastolic": {"value": 88.0, "unit": "mm[Hg]"}}
    assert vitals[1]["value"] == {"value": 182.4, "unit": "[lb_av]"}
    assert vitals[1]["recordedBy"]["displayName"] == "Dr. Rowan310 Sorensen77"
    assert all(v["status"] == "final" and v["entrySource"] == "clinician" for v in vitals)
    stored = _sql(practice, "SELECT value_quantity_value, value_quantity_unit FROM "
                  "clinical.observation WHERE id = :o", o=vitals[1]["id"])[0]
    assert (stored[0], stored[1]) == (Decimal("182.4"), "[lb_av]")  # D69: never converted
    workspace = client("ma").get(f"{API}/encounters/{encounter}").json()
    assert {v["id"] for v in workspace["vitals"]} == {v["id"] for v in vitals}
    trend = client("ma").get(f"{API}/patients/{practice.patients['kaia']}/vitals",
                             params={"type": "body-weight"})
    assert trend.status_code == 200 and [v["id"] for v in trend.json()["items"]] == [
        vitals[1]["id"]]
    paged = client("ma").get(f"{API}/patients/{practice.patients['kaia']}/vitals",
                             params={"limit": 2})
    assert len(paged.json()["items"]) == 2 and paged.json()["nextCursor"]
    # Clinical data now blocks undoing the check-in (D55).
    appointment = workspace["appointmentId"]
    undo = client("fd").post(f"{API}/appointments/{appointment}/undo-check-in",
                             json={"reason": "Wrong patient."})
    assert undo.status_code == 409


def test_vitals_refusals(client: Any, practice: Practice) -> None:
    encounter = _visit(client, practice)
    path = f"{API}/encounters/{encounter}/vitals"
    assert client("fd").post(path, json=VITALS).status_code == 403
    assert client("none").post(path, json=VITALS).status_code == 403
    assert client("md-b").post(path, json=VITALS).status_code == 404
    unit = client("ma").post(path, json={"entries": [
        {"type": "body-temperature", "value": {"value": 37, "unit": "degC"}}]})
    assert unit.status_code == 422 and unit.json()["errors"][0] == {
        "in": "body", "pointer": "/entries/0/value/unit", "code": "not-allowed-value"}
    assert client("ma").post(path, json={"entries": [{"type": "pulse"}]}).status_code == 422
    patient = practice.patients["kaia"]
    assert client("fd").get(f"{API}/patients/{patient}/vitals").status_code == 403
    assert client("md-b").get(f"{API}/patients/{patient}/vitals").status_code == 404
    restricted = client("ma").get(f"{API}/patients/{practice.patients['restricted']}/vitals")
    assert restricted.status_code == 403
    # After an undone check-in the encounter is entered in error: no vitals on it.
    appointment = client("ma").get(f"{API}/encounters/{encounter}").json()["appointmentId"]
    assert client("fd").post(f"{API}/appointments/{appointment}/undo-check-in",
                             json={"reason": "Wrong patient."}).status_code == 200
    closed = client("ma").post(path, json=VITALS)
    assert closed.status_code == 409 and closed.json()["currentState"] == "entered-in-error"
