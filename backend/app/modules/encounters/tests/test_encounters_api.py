"""The rooming operations of the encounters API with the in-memory fakes (fakes.py): getEncounter,
updateEncounter, recordVitals and listPatientVitals, each with a success, a permission-denied and
a validation-error case, plus their rules. Synthetic data only."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient

from app.core.deps import CLINIC_B, FACILITY_B

from .fakes import DOCTOR, ROOM, World

Client = Callable[[str], TestClient]
API = "/api/v1"
MERGE = {"Content-Type": "application/merge-patch+json"}
ROOMING_VITALS: dict[str, Any] = {
    "effectiveAt": "2026-10-01T15:06:00Z",  # in the past whenever this runs
    "entries": [
        {"type": "blood-pressure", "bloodPressure": {"systolic": {"value": 142, "unit": "mm[Hg]"},
                                                     "diastolic": {"value": 88,
                                                                   "unit": "mm[Hg]"}}},
        {"type": "body-weight", "value": {"value": 182.4, "unit": "[lb_av]"}},
        {"type": "body-temperature", "value": {"value": 98.6, "unit": "[degF]"}},
    ],
}


def _errors(response: Any) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = response.json()["errors"]
    return errors


# ------------------------------------------------------------------------------ getEncounter
def test_get_encounter(as_user: Client, world: World) -> None:
    encounter = world.add_encounter()
    found = as_user("ma").get(f"{API}/encounters/{encounter}")
    assert found.status_code == 200, found.text
    body = found.json()
    assert body["id"] == str(encounter) and body["status"] == "arrived" and body["class"] == "AMB"
    assert body["diagnoses"] == [] and body["vitals"] == [] and body["notes"] == []
    assert found.headers["ETag"] == '"1"'
    assert world.audited == [world.encounters[encounter].patient_id]


def test_get_encounter_refusals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter()
    assert as_user("fd").get(f"{API}/encounters/{encounter}").status_code == 403  # no read
    assert as_user("none").get(f"{API}/encounters/{encounter}").status_code == 403
    assert as_user("md-b").get(f"{API}/encounters/{encounter}").status_code == 404  # clinic B
    bad = as_user("ma").get(f"{API}/encounters/not-a-uuid")
    assert bad.status_code == 422 and bad.json()["code"] == "validation-failed"
    elsewhere = world.add_encounter(facility_id=FACILITY_B)
    assert as_user("ma").get(f"{API}/encounters/{elsewhere}").status_code == 404
    restricted = world.add_encounter()
    world.restricted.add(world.encounters[restricted].patient_id)
    refused = as_user("md").get(f"{API}/encounters/{restricted}")
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    other_clinic = world.add_encounter(clinic=CLINIC_B)
    assert as_user("ma").get(f"{API}/encounters/{other_clinic}").status_code == 404


# --------------------------------------------------------------------------- updateEncounter
def test_ma_records_the_reason_for_visit(as_user: Client, world: World) -> None:
    encounter = world.add_encounter()
    path = f"{API}/encounters/{encounter}"
    done = as_user("ma").patch(path, json={"reasons": [{"text": "Headache for 3 days."}]},
                               headers={"If-Match": '"1"', **MERGE})
    assert done.status_code == 200, done.text
    assert done.json()["reasons"] == [{"codings": [], "text": "Headache for 3 days."}]
    assert done.headers["ETag"] == '"2"'
    cleared = as_user("ma").patch(path, json={"reasons": None},
                                  headers={"If-Match": '"2"', **MERGE})
    assert cleared.status_code == 200 and "reasons" not in cleared.json()


def test_md_moves_the_room_and_sets_the_participants(as_user: Client, world: World) -> None:
    encounter = world.add_encounter()
    done = as_user("md").patch(f"{API}/encounters/{encounter}", json={
        "locationId": str(ROOM),
        "participants": [{"role": "rendering", "practitionerId": str(DOCTOR)}]},
        headers={"If-Match": '"1"', **MERGE})
    assert done.status_code == 200, done.text
    assert done.json()["locationId"] == str(ROOM)
    assert done.json()["participants"] == [{"role": "rendering", "practitionerId": str(DOCTOR)}]


def test_update_encounter_refusals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter()
    path = f"{API}/encounters/{encounter}"
    body = {"reasons": [{"text": "Cough."}]}
    tag = {"If-Match": '"1"', **MERGE}
    assert as_user("fd").patch(path, json=body, headers=tag).status_code == 403
    assert as_user("none").patch(path, json=body, headers=tag).status_code == 403
    room = as_user("ma").patch(path, json={"locationId": str(ROOM)}, headers=tag)
    assert room.status_code == 403 and room.json()["code"] == "permission-denied"  # T52
    assert as_user("ma").patch(path, json=body, headers=MERGE).status_code == 428
    stale = as_user("ma").patch(path, json=body, headers={"If-Match": '"7"', **MERGE})
    assert stale.status_code == 412 and stale.headers["ETag"] == '"1"'
    unknown = as_user("ma").patch(path, json={"status": "finished"}, headers=tag)
    assert unknown.status_code == 422 and unknown.json()["code"] == "validation-failed"
    two = as_user("ma").patch(path, json={"reasons": [{"codings": [
        {"system": "http://snomed.info/sct", "code": "25064002"},
        {"system": "http://snomed.info/sct", "code": "21522001"}]}]}, headers=tag)
    assert two.status_code == 422 and _errors(two)[0]["pointer"] == "/reasons/0/codings/1"
    unregistered = as_user("ma").patch(path, json={"reasons": [{"codings": [
        {"system": "http://example.org/local", "code": "X1"}]}]}, headers=tag)
    assert unregistered.status_code == 422
    assert _errors(unregistered)[0]["code"] == "invalid-reference"
    nowhere = as_user("md").patch(path, json={"locationId": str(DOCTOR)}, headers=tag)
    assert nowhere.status_code == 422 and _errors(nowhere)[0]["pointer"] == "/locationId"
    twice = as_user("md").patch(path, json={"participants": [
        {"role": "rendering", "practitionerId": str(DOCTOR)},
        {"role": "rendering", "practitionerId": str(DOCTOR)}]}, headers=tag)
    assert twice.status_code == 422 and _errors(twice)[0]["code"] == "conflicting-fields"
    world.encounters[encounter].status = "finished"
    closed = as_user("md").patch(path, json=body, headers=tag)
    assert closed.status_code == 409 and closed.json()["currentState"] == "finished"


# ------------------------------------------------------------------------------ recordVitals
def test_record_vitals_keeps_the_units_as_entered(as_user: Client, world: World) -> None:
    encounter = world.add_encounter()
    done = as_user("ma").post(f"{API}/encounters/{encounter}/vitals", json=ROOMING_VITALS)
    assert done.status_code == 201, done.text
    vitals = done.json()["vitals"]
    assert [v["type"] for v in vitals] == ["blood-pressure", "body-weight", "body-temperature"]
    assert vitals[0]["bloodPressure"]["systolic"] == {"value": 142, "unit": "mm[Hg]"}
    assert "value" not in vitals[0]
    assert vitals[1]["value"] == {"value": 182.4, "unit": "[lb_av]"}  # D69: not converted
    assert vitals[2]["value"] == {"value": 98.6, "unit": "[degF]"}
    assert world.audited == [world.encounters[encounter].patient_id]


def test_record_vitals_refusals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter()
    path = f"{API}/encounters/{encounter}/vitals"
    assert as_user("fd").post(path, json=ROOMING_VITALS).status_code == 403
    assert as_user("none").post(path, json=ROOMING_VITALS).status_code == 403
    unknown = as_user("ma").post(path, json={"entries": [{"type": "pulse"}]})
    assert unknown.status_code == 422 and unknown.json()["code"] == "validation-failed"
    cases = [
        ({"type": "body-weight", "value": {"value": 82, "unit": "lb"}},
         "/entries/0/value/unit", "not-allowed-value"),
        ({"type": "heart-rate", "value": {"value": 72, "unit": "/min"},
          "bloodPressure": {"systolic": {"value": 1, "unit": "mm[Hg]"},
                            "diastolic": {"value": 1, "unit": "mm[Hg]"}}},
         "/entries/0/bloodPressure", "conflicting-fields"),
        ({"type": "blood-pressure", "value": {"value": 120, "unit": "mm[Hg]"}},
         "/entries/0/value", "conflicting-fields"),
        ({"type": "heart-rate"}, "/entries/0/value", "required"),
    ]
    for entry, pointer, code in cases:
        refused = as_user("ma").post(path, json={"entries": [entry]})
        assert refused.status_code == 422, entry
        assert refused.json()["code"] == "business-rule-violation"
        assert {"in": "body", "pointer": pointer, "code": code} in _errors(refused), entry
    pulse = {"type": "heart-rate", "value": {"value": 72, "unit": "/min"}}
    twice = as_user("ma").post(path, json={"entries": [pulse, pulse]})
    assert twice.status_code == 422 and _errors(twice)[0]["pointer"] == "/entries/1/type"
    future = as_user("ma").post(path, json={"effectiveAt": "2999-01-01T00:00:00Z",
                                            "entries": [pulse]})
    assert future.status_code == 422 and _errors(future)[0]["pointer"] == "/effectiveAt"
    assert as_user("ma").post(path, json={"entries": []}).status_code == 422
    world.encounters[encounter].status = "finished"
    closed = as_user("ma").post(path, json={"entries": [pulse]})
    assert closed.status_code == 409 and closed.json()["currentState"] == "finished"


# ------------------------------------------------------------------------- listPatientVitals
def test_list_patient_vitals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter()
    patient = world.encounters[encounter].patient_id
    as_user("ma").post(f"{API}/encounters/{encounter}/vitals", json=ROOMING_VITALS)
    path = f"{API}/patients/{patient}/vitals"
    first = as_user("md").get(path, params={"limit": 2})
    assert first.status_code == 200, first.text
    assert len(first.json()["items"]) == 2 and first.json()["nextCursor"]
    rest = as_user("md").get(path, params={"limit": 2, "cursor": first.json()["nextCursor"]})
    assert len(rest.json()["items"]) == 1 and "nextCursor" not in rest.json()
    weight = as_user("md").get(path, params={"type": "body-weight"}).json()["items"]
    assert [v["type"] for v in weight] == ["body-weight"]


def test_list_patient_vitals_refusals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter()
    patient = world.encounters[encounter].patient_id
    path = f"{API}/patients/{patient}/vitals"
    assert as_user("fd").get(path).status_code == 403
    assert as_user("none").get(path).status_code == 403
    assert as_user("md-b").get(path).status_code == 404
    assert as_user("md").get(path, params={"type": "pulse"}).status_code == 422
    backwards = as_user("md").get(path, params={"dateFrom": "2026-11-03",
                                                "dateTo": "2026-11-01"})
    assert backwards.status_code == 422 and _errors(backwards)[0]["name"] == "dateTo"
    assert as_user("md").get(path, params={"cursor": "bm9wZQ"}).status_code == 400
    world.restricted.add(patient)
    refused = as_user("md").get(path)
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
