"""The follow-up request against a live database (D98, demo step 10), as shri_app, with core's
tenant_db, chart check, audit and the database's own rules (shri_follow_up_guard, the touch
trigger that moves the encounter's version) running for real: set, replace, withdraw. The
front desk's side (decline, the revisit, check-out) is in scheduling's test_check_out_live.py.
Synthetic data only."""

from __future__ import annotations

from typing import Any

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import _sql
from app.modules.scheduling.tests.test_check_in_live import checked_in_visit as _visit_at

from .test_rooming_live import _visit

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"


def _etag(client: Any, encounter: str) -> str:
    tag: str = client("md").get(f"{API}/encounters/{encounter}").headers["ETag"]
    return tag


def test_the_clinician_asks_replaces_and_withdraws(client: Any, practice: Practice,
                                                   users: dict[str, CurrentUser]) -> None:
    encounter = _visit(client, practice)
    path = f"{API}/encounters/{encounter}/follow-up"
    before = _etag(client, encounter)
    asked = client("md").put(path, headers={"If-Match": before}, json={
        "interval": {"value": 2, "unit": "week"}, "appointmentTypeId": str(practice.types["FU"]),
        "providerId": str(practice.provider), "note": "  Recheck blood pressure.  "})
    assert asked.status_code == 200, asked.text
    body = asked.json()
    assert body["status"] == "open" and body["note"] == "Recheck blood pressure."
    assert body["requestedBy"] == str(users["md"].id)
    assert asked.headers["ETag"] != before and asked.headers["ETag"] == _etag(client, encounter)
    stale = client("md").put(path, headers={"If-Match": before},
                             json={"interval": {"value": 1, "unit": "month"}})
    assert stale.status_code == 412 and stale.headers["ETag"] == asked.headers["ETag"]
    replaced = client("md").put(path, headers={"If-Match": asked.headers["ETag"]},
                                json={"interval": {"value": 1, "unit": "month"}})
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["interval"] == {"value": 1, "unit": "month"}
    assert "note" not in replaced.json() and "providerId" not in replaced.json()
    workspace = client("md").get(f"{API}/encounters/{encounter}").json()
    assert workspace["followUp"]["interval"] == {"value": 1, "unit": "month"}
    withdraw = f"{path}/withdraw"
    nurse = client("ma").post(withdraw, json={"reason": "No."},
                              headers={"If-Match": replaced.headers["ETag"]})
    assert nurse.status_code == 403  # not the clinician who asked
    done = client("md").post(withdraw, json={"reason": "Results were normal."},
                             headers={"If-Match": replaced.headers["ETag"]})
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "withdrawn"
    assert done.json()["withdrawnReason"] == "Results were normal."
    final = client("md").put(path, headers={"If-Match": done.headers["ETag"]},
                             json={"interval": {"value": 1, "unit": "week"}})
    assert final.status_code == 409 and final.json()["currentState"] == "withdrawn"
    rows = _sql(practice, "SELECT status, status_reason, interval_value FROM "
                "clinical.encounter_follow_up WHERE encounter_id = :e", e=encounter)
    assert [tuple(r) for r in rows] == [("withdrawn", "Results were normal.", 1)]
    snapshots = _sql(practice, "SELECT snapshot -> '_children' -> 'encounter_follow_up' -> 0 "
                     "->> 'status' FROM clinical.fhir_resource_history WHERE resource_type = "
                     "'Encounter' AND resource_id = :e ORDER BY version_id", e=encounter)
    statuses = [s[0] for s in snapshots if s[0]]  # the encounter's history keeps each change
    assert statuses[-1] == "withdrawn" and "open" in statuses
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE entity_id = :e AND "
                "patient_id = :p AND action = 'update'", e=encounter,
                p=practice.patients["kaia"])[0][0] >= 2


def test_set_follow_up_refusals(client: Any, practice: Practice) -> None:
    encounter = _visit(client, practice)
    path = f"{API}/encounters/{encounter}/follow-up"
    tag = {"If-Match": _etag(client, encounter)}
    ask = {"interval": {"value": 3, "unit": "month"}}
    assert client("fd").put(path, json=ask, headers=tag).status_code == 403
    assert client("ma").put(path, json=ask, headers=tag).status_code == 403  # T52
    assert client("md-b").put(path, json=ask, headers=tag).status_code == 404
    assert client("md").put(path, json=ask).status_code == 428
    assert client("md").put(path, json={"interval": {"value": 400, "unit": "day"}},
                            headers=tag).status_code == 422
    unknown = client("md").put(path, headers=tag, json={
        **ask, "appointmentTypeId": str(practice.provider), "providerId": str(practice.room)})
    assert unknown.status_code == 422
    assert [e["pointer"] for e in unknown.json()["errors"]] == ["/appointmentTypeId",
                                                               "/providerId"]
    assert _sql(practice, "SELECT count(*) FROM clinical.encounter_follow_up WHERE "
                "encounter_id = :e", e=encounter)[0][0] == 0
    _, restricted = _visit_at(client, practice, "restricted", hour=14)
    refused = client("md").put(f"{API}/encounters/{restricted}/follow-up", json=ask,
                               headers={"If-Match": '"1"'})
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
