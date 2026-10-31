"""The medication list and prescription operations on the fakes (fakes.py): each with success,
permission denied and validation errors, plus another clinic's records (404), a restricted chart
(403, then 200 with a grant), If-Match, and the signing refusals. The same operations run against
the real tables, with core's idempotency, audit and outbox, in test_medications_live.py.
Synthetic data only."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS, FACILITY_A, FACILITY_B
from app.db.models.systems import RXNORM

from .fakes import AMOXICILLIN, World

Client = Callable[[str], TestClient]
API = "/api/v1"
AMOX = {"codings": [{"system": RXNORM, "code": "308191",
                     "display": "amoxicillin 500 MG Oral Capsule"}],
        "text": "Amoxicillin 500 mg capsule"}
LISIN = {"codings": [{"system": RXNORM, "code": "314076",
                      "display": "lisinopril 10 MG Oral Tablet"}]}


def _code(response: Any) -> str:
    found: str = response.json()["code"]
    return found


def _pointers(response: Any) -> list[tuple[str, str]]:
    return [(e.get("pointer", e.get("name")), e["code"]) for e in response.json()["errors"]]


def _draft_body(world: World, patient: UUID, **extra: Any) -> dict[str, Any]:
    return {"patientId": str(patient), "medication": AMOX,
            "dosageText": "1 capsule by mouth three times daily for 10 days",
            "quantity": {"value": 30, "unit": "capsule"}, "daysSupply": 10, "refills": 0,
            "substitutionAllowed": True, "pharmacyId": str(world.pharmacy()), **extra}


def _draft(as_user: Client, world: World, patient: UUID | None = None, **extra: Any
           ) -> dict[str, Any]:
    patient = patient or world.patient(CLINIC_A)
    response = as_user("md").post(f"{API}/prescriptions", json=_draft_body(world, patient,
                                                                           **extra))
    assert response.status_code == 201, response.text
    found: dict[str, Any] = response.json()
    return found


def _check(as_user: Client, rx: dict[str, Any]) -> dict[str, Any]:
    response = as_user("md").post(f"{API}/prescriptions/{rx['id']}/safety-check")
    assert response.status_code == 200, response.text
    found: dict[str, Any] = response.json()
    return found


def _sign(as_user: Client, rx_id: str, etag: str, user: str = "md") -> Any:
    return as_user(user).post(f"{API}/prescriptions/{rx_id}/sign-and-send",
                              headers={"If-Match": etag, "Idempotency-Key": str(uuid4())})


def _etag(as_user: Client, rx_id: str) -> str:
    found: str = as_user("md").get(f"{API}/prescriptions/{rx_id}").headers["ETag"]
    return found


# --------------------------------------------------------------------------- listMedications
def test_list_shows_reported_and_signed_active_first(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    stopped = world.entry(CLINIC_A, patient, status="stopped")
    reported = world.entry(CLINIC_A, patient)
    rx = _draft(as_user, world, patient)
    _check(as_user, rx)
    assert _sign(as_user, rx["id"], '"1"').status_code == 200
    response = as_user("ma").get(f"{API}/patients/{patient}/medications")
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [i["id"] for i in items] == [rx["id"], str(reported), str(stopped)]
    assert (items[0]["source"], items[0]["prescriptionId"]) == ("prescription", rx["id"])
    assert items[1]["source"] == "reported" and "prescriptionId" not in items[1]
    only = as_user("ma").get(f"{API}/patients/{patient}/medications",
                             params={"status": "stopped"}).json()["items"]
    assert [i["id"] for i in only] == [str(stopped)]


def test_list_pages(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    for _ in range(3):
        world.entry(CLINIC_A, patient)
    first = as_user("md").get(f"{API}/patients/{patient}/medications", params={"limit": 2})
    assert len(first.json()["items"]) == 2 and first.json()["nextCursor"]
    second = as_user("md").get(f"{API}/patients/{patient}/medications",
                               params={"limit": 2, "cursor": first.json()["nextCursor"]})
    assert len(second.json()["items"]) == 1 and "nextCursor" not in second.json()
    bad = as_user("md").get(f"{API}/patients/{patient}/medications", params={"cursor": "zzzz"})
    assert bad.status_code == 400 and _code(bad) == "invalid-cursor"


def test_list_permission_denied(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    for user in ("fd", "none", "bil"):
        response = as_user(user).get(f"{API}/patients/{patient}/medications")
        assert response.status_code == 403 and _code(response) == "permission-denied"


def test_list_validation_errors(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    for params in ({"status": "entered-in-error"}, {"limit": 0}, {"limit": 101}):
        response = as_user("md").get(f"{API}/patients/{patient}/medications", params=params)
        assert response.status_code == 422, params
    assert as_user("md").get(f"{API}/patients/not-a-uuid/medications").status_code == 422


def test_list_another_clinic_and_a_restricted_chart(as_user: Client, world: World) -> None:
    other = world.patient(CLINIC_B)
    assert as_user("md").get(f"{API}/patients/{other}/medications").status_code == 404
    restricted = world.patient(CLINIC_A)
    world.restricted.add(restricted)
    blocked = as_user("md").get(f"{API}/patients/{restricted}/medications")
    assert blocked.status_code == 403 and _code(blocked) == "break-glass-required"
    world.grants.add((DEV_USERS["md"].id, restricted))
    assert as_user("md").get(f"{API}/patients/{restricted}/medications").status_code == 200


# -------------------------------------------------------------------------- recordMedication
def test_record_a_reported_medication(as_user: Client, world: World, app: FastAPI) -> None:
    patient = world.patient(CLINIC_A)
    response = as_user("ma").post(f"{API}/patients/{patient}/medications", json={
        "medication": LISIN, "dosageText": "1 tablet by mouth once daily", "note": "  "})
    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["source"], body["status"], body["patientId"]) == ("reported", "active",
                                                                   str(patient))
    assert body["medication"]["codings"][0]["code"] == "314076" and "note" not in body
    assert response.headers["Location"] == f"{API}/patients/{patient}/medications"
    assert app.state.fake_sessions[-1].commits == 1
    text_only = as_user("ma").post(f"{API}/patients/{patient}/medications",
                                   json={"medication": {"text": "Fish oil"},
                                         "status": "stopped"})
    assert text_only.status_code == 201 and text_only.json()["status"] == "stopped"


def test_record_permission_denied(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    for user in ("fd", "none"):
        response = as_user(user).post(f"{API}/patients/{patient}/medications",
                                      json={"medication": LISIN})
        assert response.status_code == 403 and _code(response) == "permission-denied"


def test_record_validation_errors(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    url = f"{API}/patients/{patient}/medications"
    for body, where in (
            ({}, None), ({"medication": LISIN, "extra": 1}, None),
            ({"medication": {}}, ("/medication", "required")),
            ({"medication": {"codings": [{"system": "http://snomed.info/sct", "code": "1"}]}},
             ("/medication/codings/0/system", "not-allowed-value")),
            ({"medication": {"codings": LISIN["codings"] * 2}},
             ("/medication/codings", "too-long")),
            ({"medication": LISIN, "status": "entered-in-error"}, None),
            ({"medication": LISIN, "dosageText": "x" * 501}, None)):
        response = as_user("ma").post(url, json=body)
        assert response.status_code == 422, body
        if where:
            assert _pointers(response) == [where]


def test_record_for_a_merged_or_unknown_patient(as_user: Client, world: World) -> None:
    merged = world.patient(CLINIC_A)
    world.merged.add(merged)
    response = as_user("ma").post(f"{API}/patients/{merged}/medications",
                                  json={"medication": LISIN})
    assert response.status_code == 409 and _code(response) == "patient-merged"
    other = world.patient(CLINIC_B)
    assert as_user("ma").post(f"{API}/patients/{other}/medications",
                              json={"medication": LISIN}).status_code == 404


# ------------------------------------------------------------------------ createPrescription
def test_create_a_draft(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    visit = world.encounter(CLINIC_A, patient, FACILITY_A)
    response = as_user("md").post(f"{API}/prescriptions",
                                  json=_draft_body(world, patient, encounterId=str(visit)))
    assert response.status_code == 201, response.text
    rx = response.json()
    assert (rx["status"], rx["transmission"], rx["alerts"]) == ("draft", {"status": "not-sent"},
                                                                [])
    assert rx["quantity"] == {"value": 30.0, "unit": "capsule"} and rx["encounterId"] == str(visit)
    assert "safetyCheckedAt" not in rx and "signedAt" not in rx
    assert response.headers["ETag"] == '"1"'
    assert response.headers["Location"] == f"{API}/prescriptions/{rx['id']}"
    assert world.audited == [[patient]]


def test_create_permission_denied(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    for user in ("ma", "fd", "none"):
        response = as_user(user).post(f"{API}/prescriptions", json=_draft_body(world, patient))
        assert response.status_code == 403 and _code(response) == "permission-denied", user
    # RN holds prescriptions:create but isn't MD or APP (D110).
    response = as_user("rn").post(f"{API}/prescriptions", json=_draft_body(world, patient))
    assert response.status_code == 403 and _code(response) == "permission-denied"


def test_create_validation_errors(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    for extra, where in (
            ({"refills": 12}, None), ({"daysSupply": 0}, None),
            ({"quantity": {"value": 0, "unit": "capsule"}}, None),
            ({"quantity": {"value": 1.2345, "unit": "capsule"}}, None),
            ({"noteToPharmacy": "x" * 211}, None), ({"unknown": True}, None),
            ({"medication": {"codings": [{"system": RXNORM, "code": "999999"}]}},
             ("/medication/codings/0/code", "invalid-reference"))):
        response = as_user("md").post(f"{API}/prescriptions",
                                      json=_draft_body(world, patient, **extra))
        assert response.status_code == 422, extra
        if where:
            assert _pointers(response) == [where]
    no_patient = _draft_body(world, patient)
    del no_patient["patientId"]
    assert as_user("md").post(f"{API}/prescriptions", json=no_patient).status_code == 422


def test_create_business_rules(as_user: Client, world: World) -> None:
    patient, other = world.patient(CLINIC_A), world.patient(CLINIC_A)
    theirs = world.encounter(CLINIC_A, other, FACILITY_A)
    closed = world.encounter(CLINIC_A, patient, FACILITY_A, status="finished")
    elsewhere = world.encounter(CLINIC_A, patient, UUID(int=7))
    for visit, where in ((theirs, ("/encounterId", "invalid-reference")),
                         (closed, ("/encounterId", "not-allowed-value"))):
        response = as_user("md").post(f"{API}/prescriptions", json=_draft_body(
            world, patient, encounterId=str(visit)))
        assert response.status_code == 422 and _pointers(response) == [where]
    assert as_user("md").post(f"{API}/prescriptions", json=_draft_body(
        world, patient, encounterId=str(elsewhere))).status_code == 404  # not the user's
    inactive = as_user("md").post(f"{API}/prescriptions", json=_draft_body(
        world, patient, pharmacyId=str(world.pharmacy(active=False))))
    assert _pointers(inactive) == [("/pharmacyId", "not-allowed-value")]
    assert as_user("md").post(f"{API}/prescriptions", json=_draft_body(
        world, patient, pharmacyId=str(uuid4()))).status_code == 404
    world.schedules["308191"] = "CII"  # no refills on Schedule II (21 CFR 1306)
    response = as_user("md").post(f"{API}/prescriptions", json=_draft_body(world, patient,
                                                                           refills=1))
    assert _pointers(response) == [("/refills", "out-of-range")]
    world.merged.add(patient)
    merged = as_user("md").post(f"{API}/prescriptions", json=_draft_body(world, patient))
    assert merged.status_code == 409 and _code(merged) == "patient-merged"
    assert as_user("md").post(f"{API}/prescriptions", json=_draft_body(
        world, world.patient(CLINIC_B))).status_code == 404


# ------------------------------------------------------------------------- getPrescription
def test_get_a_prescription(as_user: Client, world: World) -> None:
    rx = _draft(as_user, world)
    response = as_user("ma").get(f"{API}/prescriptions/{rx['id']}")
    assert response.status_code == 200 and response.json()["id"] == rx["id"]
    assert response.headers["ETag"] == '"1"'
    assert as_user("md-b").get(f"{API}/prescriptions/{rx['id']}").status_code == 404


def test_get_permission_denied_and_validation(as_user: Client, world: World) -> None:
    rx = _draft(as_user, world)
    for user in ("fd", "none"):
        response = as_user(user).get(f"{API}/prescriptions/{rx['id']}")
        assert response.status_code == 403 and _code(response) == "permission-denied"
    assert as_user("md").get(f"{API}/prescriptions/not-a-uuid").status_code == 422


def test_get_a_restricted_chart(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    rx = _draft(as_user, world, patient)
    world.restricted.add(patient)
    blocked = as_user("ma").get(f"{API}/prescriptions/{rx['id']}")
    assert blocked.status_code == 403 and _code(blocked) == "break-glass-required"


# ----------------------------------------------------------------------- updatePrescription
def test_update_a_draft(as_user: Client, world: World) -> None:
    rx = _draft(as_user, world)
    _check(as_user, rx)
    response = as_user("md").patch(f"{API}/prescriptions/{rx['id']}", json={
        "daysSupply": 7, "quantity": {"value": 21, "unit": "capsule"}, "noteToPharmacy": None},
        headers={"If-Match": '"1"'})
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["daysSupply"], body["quantity"]["value"]) == (7, 21.0)
    assert response.headers["ETag"] == '"2"' and "safetyCheckedAt" not in body  # check again


def test_update_permission_denied(as_user: Client, world: World) -> None:
    rx = _draft(as_user, world)
    for user in ("ma", "none"):
        response = as_user(user).patch(f"{API}/prescriptions/{rx['id']}",
                                       json={"refills": 1}, headers={"If-Match": '"1"'})
        assert response.status_code == 403 and _code(response) == "permission-denied"


def test_update_validation_and_preconditions(as_user: Client, world: World) -> None:
    rx = _draft(as_user, world)
    url = f"{API}/prescriptions/{rx['id']}"
    for body in ({}, {"refills": -1}, {"medication": None}, {"status": "active"}):
        assert as_user("md").patch(url, json=body, headers={"If-Match": '"1"'}
                                   ).status_code == 422, body
    missing = as_user("md").patch(url, json={"refills": 1})
    assert missing.status_code == 428 and _code(missing) == "precondition-required"
    stale = as_user("md").patch(url, json={"refills": 1}, headers={"If-Match": '"9"'})
    assert stale.status_code == 412 and stale.headers["ETag"] == '"1"'
    _check(as_user, rx)
    assert _sign(as_user, rx["id"], '"1"').status_code == 200
    locked = as_user("md").patch(url, json={"refills": 1}, headers={"If-Match": '"2"'})
    assert locked.status_code == 409 and _code(locked) == "record-locked"


# ------------------------------------------------------------ markPrescriptionEnteredInError
def test_enter_a_draft_in_error(as_user: Client, world: World) -> None:
    rx = _draft(as_user, world)
    response = as_user("md").post(f"{API}/prescriptions/{rx['id']}/entered-in-error",
                                  json={"reason": "Started on the wrong patient."})
    assert response.status_code == 200 and response.json()["status"] == "entered-in-error"
    again = as_user("md").post(f"{API}/prescriptions/{rx['id']}/entered-in-error",
                               json={"reason": "Twice."})
    assert again.status_code == 409 and again.json()["currentState"] == "entered-in-error"


def test_enter_in_error_permission_and_validation(as_user: Client, world: World) -> None:
    rx = _draft(as_user, world)
    url = f"{API}/prescriptions/{rx['id']}/entered-in-error"
    for user in ("ma", "none"):
        assert as_user(user).post(url, json={"reason": "No."}).status_code == 403
    for body in ({}, {"reason": ""}, {"reason": "x" * 501}):
        assert as_user("md").post(url, json=body).status_code == 422, body
    blank = as_user("md").post(url, json={"reason": "   "})
    assert _pointers(blank) == [("/reason", "too-short")]


# -------------------------------------------------------------------- checkPrescriptionSafety
def test_safety_check_raises_allergy_and_duplicate_alerts(as_user: Client,
                                                          world: World) -> None:
    world.ingredients |= {"308191": frozenset({"723"}), "7980": frozenset({"723"})}
    patient = world.patient(CLINIC_A)
    allergy = world.allergy(patient, "723", "amoxicillin")
    world.allergy(patient, "723", "amoxicillin (refuted)", verification="refuted")
    duplicate = world.entry(CLINIC_A, patient, drug=AMOXICILLIN)
    world.entry(CLINIC_A, patient)  # lisinopril: no shared ingredient
    rx = _draft(as_user, world, patient)
    result = _check(as_user, rx)
    kinds = {a["kind"]: a for a in result["alerts"]}
    assert set(kinds) == {"allergy", "duplicate-medication"}
    assert (kinds["allergy"]["severity"], kinds["allergy"]["overrideRequired"],
            kinds["allergy"]["allergyId"]) == ("high", True, str(allergy))
    assert (kinds["duplicate-medication"]["severity"],
            kinds["duplicate-medication"]["overrideRequired"],
            kinds["duplicate-medication"]["medicationId"]) == ("warning", False, str(duplicate))
    after = as_user("md").get(f"{API}/prescriptions/{rx['id']}")
    assert after.headers["ETag"] == '"1"'  # the check is not a new version (A58)
    assert after.json()["alerts"] == result["alerts"] and after.json()["safetyCheckedAt"]


def test_safety_check_permission_and_state(as_user: Client, world: World) -> None:
    rx = _draft(as_user, world)
    url = f"{API}/prescriptions/{rx['id']}/safety-check"
    for user in ("ma", "fd", "none"):
        assert as_user(user).post(url).status_code == 403, user
    assert as_user("md").post(f"{API}/prescriptions/not-a-uuid/safety-check").status_code == 422
    as_user("md").post(f"{API}/prescriptions/{rx['id']}/entered-in-error",
                       json={"reason": "Wrong drug."})
    done = as_user("md").post(url)
    assert done.status_code == 409 and done.json()["currentState"] == "entered-in-error"


# ------------------------------------------------------------------------------ overrideAlert
def _allergic_draft(as_user: Client, world: World) -> tuple[dict[str, Any], str]:
    world.ingredients |= {"308191": frozenset({"723"})}
    patient = world.patient(CLINIC_A)
    world.allergy(patient, "723", "amoxicillin")
    rx = _draft(as_user, world, patient)
    [alert] = _check(as_user, rx)["alerts"]
    return rx, alert["id"]


def test_override_an_alert(as_user: Client, world: World) -> None:
    rx, alert_id = _allergic_draft(as_user, world)
    response = as_user("md").post(f"{API}/alerts/{alert_id}/override",
                                  json={"reason": "  Tolerated amoxicillin in 2024.  "})
    assert response.status_code == 200, response.text
    override = response.json()["override"]
    assert override["reason"] == "Tolerated amoxicillin in 2024."
    assert override["overriddenBy"] == str(DEV_USERS["md"].id)
    twice = as_user("md").post(f"{API}/alerts/{alert_id}/override", json={"reason": "Again."})
    assert twice.status_code == 409 and twice.json()["currentState"] == "overridden"
    assert as_user("md-b").post(f"{API}/alerts/{alert_id}/override",
                                json={"reason": "Not mine."}).status_code == 404


def test_override_permission_and_validation(as_user: Client, world: World) -> None:
    _, alert_id = _allergic_draft(as_user, world)
    url = f"{API}/alerts/{alert_id}/override"
    for user in ("rn", "ma", "none"):
        assert as_user(user).post(url, json={"reason": "Because."}).status_code == 403, user
    for body in ({}, {"reason": "ab"}, {"reason": "x" * 501}):
        assert as_user("md").post(url, json=body).status_code == 422, body
    blank = as_user("md").post(url, json={"reason": "   a  "})
    assert _pointers(blank) == [("/reason", "too-short")]


# -------------------------------------------------------------------- signAndSendPrescription
def test_sign_and_send(as_user: Client, world: World, app: FastAPI) -> None:
    rx, alert_id = _allergic_draft(as_user, world)
    as_user("md").post(f"{API}/alerts/{alert_id}/override", json={"reason": "Tolerated it."})
    response = _sign(as_user, rx["id"], '"1"')
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["status"], body["transmission"]["status"]) == ("active", "queued")
    assert body["prescriberId"] == str(DEV_USERS["md"].id) and body["signedAt"]
    assert response.headers["ETag"] == '"2"'
    assert world.sent == [UUID(rx["id"])]
    assert [e[0] for e in world.events] == ["prescription.signed",
                                            "prescription.transmission-updated"]
    assert world.events[1][2] == {"transmissionStatus": "queued"}
    assert app.state.fake_sessions[-1].commits == 1
    again = _sign(as_user, rx["id"], '"2"')
    assert again.status_code == 409 and again.json()["currentState"] == "active"


def test_sign_refusals(as_user: Client, world: World) -> None:
    rx = _draft(as_user, world, dosageText=None, pharmacyId=None)
    response = _sign(as_user, rx["id"], '"1"')
    assert response.status_code == 422 and _code(response) == "business-rule-violation"
    assert _pointers(response) == [("/dosageText", "required"), ("/pharmacyId", "required"),
                                   ("/alerts", "safety-check-stale")]
    rx, _ = _allergic_draft(as_user, world)
    assert _pointers(_sign(as_user, rx["id"], '"1"')) == [("/alerts/0", "override-required")]
    # A change after the check makes it stale again.
    as_user("md").patch(f"{API}/prescriptions/{rx['id']}", json={"refills": 1},
                        headers={"If-Match": '"1"'})
    assert _pointers(_sign(as_user, rx["id"], '"2"')) == [("/alerts", "safety-check-stale")]
    assert world.sent == [] and world.events == []


def test_sign_permission_and_preconditions(as_user: Client, world: World) -> None:
    rx = _draft(as_user, world)
    _check(as_user, rx)
    for user in ("rn", "ma", "none"):
        assert _sign(as_user, rx["id"], '"1"', user=user).status_code == 403, user
    url = f"{API}/prescriptions/{rx['id']}/sign-and-send"
    missing = as_user("md").post(url, headers={"Idempotency-Key": str(uuid4())})
    assert missing.status_code == 428
    stale = _sign(as_user, rx["id"], '"5"')
    assert stale.status_code == 412 and stale.headers["ETag"] == '"1"'
    assert as_user("md").post(f"{API}/prescriptions/not-a-uuid/sign-and-send", headers={
        "If-Match": '"1"', "Idempotency-Key": str(uuid4())}).status_code == 422
    assert world.sent == []


def test_a_facility_not_the_users(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    visit = world.encounter(CLINIC_A, patient, FACILITY_A)
    rx = _draft(as_user, world, patient, encounterId=str(visit))
    world.encounters[visit] = (CLINIC_A, world.encounters[visit][1].__class__(
        visit, patient, "in-progress", FACILITY_B))
    world.put(world.row(UUID(rx["id"])).__class__(**{
        **world.row(UUID(rx["id"])).__dict__, "facility_id": FACILITY_B}))
    assert as_user("md").get(f"{API}/prescriptions/{rx['id']}").status_code == 404


# ------------------------------------------------------------- D110: MD and APP prescribe
def test_rn_is_refused_on_every_prescribing_operation(as_user: Client, world: World) -> None:
    """D110 (for the clinical advisors to confirm, Q21): RN holds each permission in core's
    catalogue but is refused with 403 permission-denied, even when linked to a practitioner, so
    the role rule, not the practitioner link, refuses; nothing is read for the audit or written."""
    world.practitioners[DEV_USERS["rn"].id] = DEV_USERS["rn"].id
    rx, alert_id = _allergic_draft(as_user, world)
    before = (dict(world.prescriptions), list(world.audited), list(world.sent))
    url = f"{API}/prescriptions/{rx['id']}"
    rn = as_user("rn")
    refused = {
        "createPrescription": rn.post(f"{API}/prescriptions",
                                      json=_draft_body(world, world.patient(CLINIC_A))),
        "updatePrescription": rn.patch(url, json={"refills": 1}, headers={"If-Match": '"1"'}),
        "checkPrescriptionSafety": rn.post(f"{url}/safety-check"),
        "overrideAlert": rn.post(f"{API}/alerts/{alert_id}/override",
                                 json={"reason": "Tolerated it."}),
        "signAndSendPrescription": _sign(as_user, rx["id"], '"1"', user="rn"),
        "markPrescriptionEnteredInError": rn.post(f"{url}/entered-in-error",
                                                  json={"reason": "Wrong drug."}),
    }
    for operation, response in refused.items():
        assert response.status_code == 403, (operation, response.text)
        assert _code(response) == "permission-denied", operation
    assert (dict(world.prescriptions), list(world.audited), list(world.sent)) == before
    assert as_user("rn").get(url).status_code == 200  # reading stays open to RN


def test_md_and_app_both_prescribe(as_user: Client, world: World) -> None:
    """D110: APP drafts, edits, checks, overrides, signs and sends, and marks a draft wrong,
    as MD does (MD's own runs are the tests above)."""
    world.ingredients |= {"308191": frozenset({"723"})}
    patient = world.patient(CLINIC_A)
    world.allergy(patient, "723", "amoxicillin")
    app = as_user("app")
    created = app.post(f"{API}/prescriptions", json=_draft_body(world, patient))
    assert created.status_code == 201, created.text
    url = f"{API}/prescriptions/{created.json()['id']}"
    edited = app.patch(url, json={"refills": 1}, headers={"If-Match": '"1"'})
    assert edited.status_code == 200, edited.text
    checked = app.post(f"{url}/safety-check")
    assert checked.status_code == 200, checked.text
    [alert] = checked.json()["alerts"]
    overridden = app.post(f"{API}/alerts/{alert['id']}/override",
                          json={"reason": "Tolerated it."})
    assert overridden.status_code == 200, overridden.text
    signed = _sign(as_user, created.json()["id"], '"2"', user="app")
    assert signed.status_code == 200, signed.text
    other = app.post(f"{API}/prescriptions", json=_draft_body(world, patient))
    wrong = app.post(f"{API}/prescriptions/{other.json()['id']}/entered-in-error",
                     json={"reason": "Wrong drug."})
    assert wrong.status_code == 200 and wrong.json()["status"] == "entered-in-error"
