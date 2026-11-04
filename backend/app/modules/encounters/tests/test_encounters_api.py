"""The rooming operations of the encounters API with the in-memory fakes (fakes.py): getEncounter,
updateEncounter, recordVitals, listPatientVitals and markVitalEnteredInError, each with a success,
a permission-denied and a validation-error case, plus their rules. Synthetic data only."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from app.core.deps import CLINIC_B, DEV_USERS, FACILITY_B

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
    empty = as_user("ma").post(path, json={"entries": []})  # valid; records nothing (#190)
    assert empty.status_code == 201 and empty.json() == {"vitals": []}
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


# -------------------------------------------------------------------- markVitalEnteredInError
def _recorded(as_user: Client, world: World, *, by: str = "ma") -> tuple[UUID, str]:
    """A visit's vitals, recorded by ``by``; the patient and the body weight's ID."""
    encounter = world.add_encounter()
    done = as_user("ma").post(f"{API}/encounters/{encounter}/vitals", json=ROOMING_VITALS)
    assert done.status_code == 201, done.text
    for v in done.json()["vitals"]:
        world.vital_owner[UUID(v["id"])] = DEV_USERS[by].id
    weight: str = done.json()["vitals"][1]["id"]
    return world.encounters[encounter].patient_id, weight


def test_mark_vital_entered_in_error(as_user: Client, world: World) -> None:
    patient, weight = _recorded(as_user, world)
    path = f"{API}/patients/{patient}/vitals/{weight}/entered-in-error"
    marked = as_user("md").post(path, json={"reason": "  Weight typed with an extra digit. "})
    assert marked.status_code == 200, marked.text
    assert marked.json()["id"] == weight and marked.json()["status"] == "entered-in-error"
    assert marked.headers["ETag"] == '"2"'
    assert world.provenance == [(UUID(weight), "Weight typed with an extra digit.")]
    listed = as_user("md").get(f"{API}/patients/{patient}/vitals").json()["items"]
    assert weight not in {v["id"] for v in listed}  # left out of the chart, kept
    kept = as_user("md").get(f"{API}/patients/{patient}/vitals",
                             params={"includeEnteredInError": "true"}).json()["items"]
    assert weight in {v["id"] for v in kept}
    again = as_user("md").post(path, json={"reason": "Twice."})
    assert again.status_code == 409 and again.json()["currentState"] == "entered-in-error"


def test_a_nurse_marks_only_her_own_vitals(as_user: Client, world: World) -> None:
    patient, theirs = _recorded(as_user, world, by="ma")
    path = f"{API}/patients/{patient}/vitals/{theirs}/entered-in-error"
    refused = as_user("rn").post(path, json={"reason": "Wrong patient."})
    assert refused.status_code == 403 and refused.json()["code"] == "permission-denied"
    patient, own = _recorded(as_user, world, by="rn")
    done = as_user("rn").post(f"{API}/patients/{patient}/vitals/{own}/entered-in-error",
                              json={"reason": "Wrong patient."})
    assert done.status_code == 200, done.text


def test_mark_vital_entered_in_error_refusals(as_user: Client, world: World) -> None:
    patient, weight = _recorded(as_user, world)
    path = f"{API}/patients/{patient}/vitals/{weight}/entered-in-error"
    body = {"reason": "Wrong patient."}
    assert as_user("ma").post(path, json=body).status_code == 403  # MA lacks the permission
    assert as_user("fd").post(path, json=body).status_code == 403
    assert as_user("none").post(path, json=body).status_code == 403
    assert as_user("md-b").post(path, json=body).status_code == 404  # clinic B
    for bad in ({}, {"reason": ""}, {"reason": "x" * 501}, {"reason": "ok", "extra": 1}):
        refused = as_user("md").post(path, json=bad)
        assert refused.status_code == 422 and refused.json()["code"] == "validation-failed", bad
    blank = as_user("md").post(path, json={"reason": "   "})
    assert blank.status_code == 422 and _errors(blank)[0]["pointer"] == "/reason"
    assert as_user("md").post(f"{API}/patients/{patient}/vitals/nope/entered-in-error",
                              json=body).status_code == 422
    other = world.add_encounter()
    stranger = world.encounters[other].patient_id
    wrong_patient = as_user("md").post(
        f"{API}/patients/{stranger}/vitals/{weight}/entered-in-error", json=body)
    assert wrong_patient.status_code == 404  # not this patient's vital
    unknown = as_user("md").post(f"{API}/patients/{patient}/vitals/{uuid4()}/entered-in-error",
                                 json=body)
    assert unknown.status_code == 404
    elsewhere_patient, elsewhere = _recorded(as_user, world)
    visit = next(v.encounter_id for v in world.vitals if v.id == UUID(elsewhere))
    assert visit is not None
    world.encounters[visit].facility_id = FACILITY_B  # the visit was at another facility
    at_b = as_user("md").post(
        f"{API}/patients/{elsewhere_patient}/vitals/{elsewhere}/entered-in-error", json=body)
    assert at_b.status_code == 404  # a visit at a facility not the user's (#180)
    world.restricted.add(patient)
    restricted = as_user("md").post(path, json=body)
    assert restricted.status_code == 403 and restricted.json()["code"] == "break-glass-required"
    assert world.provenance == []  # nothing was marked


# ------------------------------------------------------------------------- listPatientEncounters
def test_list_patient_encounters(as_user: Client, world: World) -> None:
    first = world.add_encounter(status="finished")
    patient = world.encounters[first].patient_id
    second = world.add_encounter(patient_id=patient, status="in-progress")
    wrong = world.add_encounter(patient_id=patient, status="entered-in-error")
    elsewhere = world.add_encounter(patient_id=patient, facility_id=FACILITY_B)
    path = f"{API}/patients/{patient}/encounters"
    found = as_user("md").get(path)
    assert found.status_code == 200, found.text
    ids = [e["id"] for e in found.json()["items"]]
    assert set(ids) == {str(first), str(second)}  # not entered in error, not another facility
    assert str(elsewhere) not in ids and "nextCursor" not in found.json()
    assert found.json()["items"][0]["class"] == "AMB"
    paged = as_user("md").get(path, params={"limit": 1})
    assert len(paged.json()["items"]) == 1 and paged.json()["nextCursor"]
    asked = as_user("md").get(path, params={"status": "entered-in-error"}).json()["items"]
    assert [e["id"] for e in asked] == [str(wrong)]


def test_list_patient_encounters_refusals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter()
    patient = world.encounters[encounter].patient_id
    path = f"{API}/patients/{patient}/encounters"
    assert as_user("fd").get(path).status_code == 403
    assert as_user("none").get(path).status_code == 403
    assert as_user("md-b").get(path).status_code == 404
    assert as_user("md").get(path, params={"status": "open"}).status_code == 422
    assert as_user("md").get(path, params={"limit": 0}).status_code == 422
    backwards = as_user("md").get(path, params={"dateFrom": "2026-11-03",
                                                "dateTo": "2026-11-01"})
    assert backwards.status_code == 422 and _errors(backwards)[0]["name"] == "dateTo"
    assert as_user("md").get(path, params={"cursor": "bm9wZQ"}).status_code == 400
    world.restricted.add(patient)
    refused = as_user("md").get(path)
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
