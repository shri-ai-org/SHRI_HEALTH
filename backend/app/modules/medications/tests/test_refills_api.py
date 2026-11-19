"""Refill requests (#400) on the fakes (fakes.py, refill_fakes.py): the patient's request from the
portal and their list, the staff list and the prescriber's answer, each with success, permission
denied and validation errors, plus another patient's or clinic's records (404), a restricted
chart, the facility filter, an answered request (409), a note (refused), the decline reason codes
and the approved draft through the safety check and sign-and-send. The same operations against
the real tables are in test_refills_live.py. Synthetic data only."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import permissions
from app.core.deps import (
    CLINIC_A,
    CLINIC_B,
    DEV_PATIENT_CLINIC_HEADER,
    DEV_PATIENT_HEADER,
    DEV_USERS,
    FACILITY_A,
    FACILITY_B,
)
from app.db import fhir_store as fs

from .fakes import World
from .refill_fakes import Refills
from .test_medications_api import _check, _draft, _etag, _sign

Client = Callable[[str], TestClient]
API = "/api/v1"
MINE = f"{API}/portal/me/refill-requests"
STAFF = f"{API}/refill-requests"
VISIT = "needs-visit"  # a decline reason code (fs.REFILL_DECLINE_REASONS)


def _key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _patient(app: FastAPI, patient: UUID, clinic: UUID = CLINIC_A) -> TestClient:
    c = TestClient(app, raise_server_exceptions=False)
    c.headers.update({DEV_PATIENT_HEADER: str(patient), DEV_PATIENT_CLINIC_HEADER: str(clinic)})
    return c


def _signed(as_user: Client, world: World, patient: UUID, facility: UUID | None = FACILITY_A,
            **extra: Any) -> str:
    """A signed prescription, written in a visit at ``facility`` (None: outside any visit)."""
    if facility is not None:
        extra["encounterId"] = str(world.encounter(CLINIC_A, patient, FACILITY_A))
    rx = _draft(as_user, world, patient, **extra)
    _check(as_user, rx)
    signed = _sign(as_user, rx["id"], _etag(as_user, rx["id"]))
    assert signed.status_code == 200, signed.text
    if facility not in (None, FACILITY_A):  # md works at A only: as if written at another
        world.put(replace(world.row(UUID(rx["id"])), facility_id=facility))
    return str(rx["id"])


def _ask(app: FastAPI, patient: UUID, rx: str, **body: Any) -> Any:
    return _patient(app, patient).post(MINE, json={"prescriptionId": rx, **body},
                                       headers=_key())


def _requested(app: FastAPI, as_user: Client, world: World, patient: UUID | None = None,
               **kw: Any) -> tuple[UUID, str, str]:
    patient = patient or world.patient(CLINIC_A)
    rx = _signed(as_user, world, patient, **kw)
    asked = _ask(app, patient, rx)
    assert asked.status_code == 201, asked.text
    return patient, rx, asked.json()["id"]


def _errors(response: Any) -> list[tuple[str, str]]:
    return [(e.get("pointer", e.get("name")), e["code"]) for e in response.json()["errors"]]


# ------------------------------------------------------------------ createPortalRefillRequest
def test_a_patient_asks_to_refill_their_own_prescription(app: FastAPI, as_user: Client,
                                                         world: World, refills: Refills) -> None:
    patient = world.patient(CLINIC_A)
    rx = _signed(as_user, world, patient)
    asked = _ask(app, patient, rx, note="   ")  # blank: no note
    assert asked.status_code == 201, asked.text
    assert asked.headers["Location"] == MINE
    body = asked.json()
    assert (body["prescriptionId"], body["status"]) == (rx, "requested")
    assert body["display"] == "amoxicillin 500 MG Oral Capsule"
    assert body["dosageText"] == "1 capsule by mouth three times daily for 10 days"
    assert body["requestedAt"] and "respondedAt" not in body and "newPrescriptionId" not in body
    stored = refills.row(UUID(body["id"]))
    assert (stored.patient_id, stored.status) == (patient, "active")
    assert refills.notes[stored.id] is None
    assert refills.events == [(
        "refill-request.received", f"refill-request/{body['id']}",
        {"refillRequestId": body["id"], "prescriptionId": rx, "patientId": str(patient),
         "status": "requested"},
        {"facility_id": FACILITY_A, "patient_id": patient})]
    assert app.state.fake_sessions[-1].commits == 1


def test_asking_for_another_patients_or_a_missing_prescription_is_404(
        app: FastAPI, as_user: Client, world: World, refills: Refills) -> None:
    mine, theirs = world.patient(CLINIC_A), world.patient(CLINIC_A)
    rx = _signed(as_user, world, theirs)
    draft = _draft(as_user, world, mine)["id"]
    for target in (rx, str(uuid4()), draft):  # another's, none, a draft the portal never sees
        refused = _ask(app, mine, target)
        assert refused.status_code == 404, refused.text
        assert refused.json()["code"] == "not-found"
    elsewhere = _patient(app, theirs, CLINIC_B).post(MINE, json={"prescriptionId": rx},
                                                     headers=_key())
    assert elsewhere.status_code == 404  # the same patient ID in another clinic
    assert refills.rows == {} and refills.events == []


def test_asking_refuses_what_cant_be_refilled(app: FastAPI, as_user: Client, world: World,
                                              refills: Refills) -> None:
    patient = world.patient(CLINIC_A)
    rx = _signed(as_user, world, patient)
    world.put(replace(world.row(UUID(rx)), status="completed"))
    finished = _ask(app, patient, rx)
    assert finished.status_code == 409
    assert finished.json()["code"] == "invalid-state-transition"
    assert _errors(finished) == [("/prescriptionId", "not-active")]

    for schedule in ("CII", "CIV"):  # no controlled substance from the portal (0028)
        world.schedules["308191"] = schedule
        controlled = _signed(as_user, world, patient)
        refused = _ask(app, patient, controlled)
        assert refused.status_code == 409 and _errors(refused) == [("/prescriptionId",
                                                                    "not-refillable")]
    del world.schedules["308191"]

    open_rx = _signed(as_user, world, patient)
    assert _ask(app, patient, open_rx).status_code == 201
    again = _ask(app, patient, open_rx)  # a second key: an open request already
    assert again.status_code == 409 and _errors(again) == [("/prescriptionId",
                                                            "refill-already-requested")]
    assert len(refills.rows) == 1 and len(refills.events) == 1


def test_asking_with_a_note_is_refused(app: FastAPI, as_user: Client, world: World,
                                       refills: Refills) -> None:
    patient = world.patient(CLINIC_A)
    rx = _signed(as_user, world, patient)
    refused = _ask(app, patient, rx, note="Down to my last week of capsules.")
    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "validation-failed"
    assert _errors(refused) == [("/note", "not-allowed-value")]
    assert refills.rows == {} and refills.events == []


@pytest.mark.parametrize("body", [{}, {"prescriptionId": "not-a-uuid"},
                                  {"prescriptionId": str(uuid4()), "note": "x" * 501},
                                  {"prescriptionId": str(uuid4()), "unknown": 1}])
def test_asking_validates_the_body(app: FastAPI, world: World, body: dict[str, Any]) -> None:
    refused = _patient(app, world.patient(CLINIC_A)).post(MINE, json=body, headers=_key())
    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "validation-failed"


def test_only_a_patient_session_holding_the_permission_may_ask(
        app: FastAPI, as_user: Client, world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    patient = world.patient(CLINIC_A)
    rx = _signed(as_user, world, patient)
    staff = as_user("md").post(MINE, json={"prescriptionId": rx}, headers=_key())
    assert staff.status_code in (401, 403), staff.text  # a staff session isn't a patient's
    monkeypatch.setattr(permissions, "PATIENT_PERMISSIONS",
                        permissions.PATIENT_PERMISSIONS - {"portal-refill-requests:create"})
    refused = _ask(app, patient, rx)
    assert refused.status_code == 403 and refused.json()["code"] == "permission-denied"


# ------------------------------------------------------------------- listPortalRefillRequests
def test_my_refill_requests_newest_first_and_only_mine(app: FastAPI, as_user: Client,
                                                       world: World) -> None:
    patient, first_rx, first = _requested(app, as_user, world)
    _, _, second = _requested(app, as_user, world, patient)
    _requested(app, as_user, world)  # another patient's
    me = _patient(app, patient)
    found = me.get(MINE)
    assert found.status_code == 200, found.text
    assert [i["id"] for i in found.json()["items"]] == [second, first]
    page = me.get(MINE, params={"limit": 1}).json()
    assert [i["id"] for i in page["items"]] == [second] and page["nextCursor"]
    rest = me.get(MINE, params={"limit": 1, "cursor": page["nextCursor"]}).json()
    assert [i["id"] for i in rest["items"]] == [first] and "nextCursor" not in rest
    assert rest["items"][0]["prescriptionId"] == first_rx
    assert "note" not in rest["items"][0]  # the patient's own words stay with the practice


def test_my_refill_requests_refuse(app: FastAPI, as_user: Client, world: World,
                                   monkeypatch: pytest.MonkeyPatch) -> None:
    me = _patient(app, world.patient(CLINIC_A))
    for params in ({"limit": 0}, {"limit": 101}):
        assert me.get(MINE, params=params).status_code == 422, params
    assert me.get(MINE, params={"cursor": "bm90LWFuLW9mZnNldA"}).status_code == 400
    assert as_user("md").get(MINE).status_code in (401, 403)
    monkeypatch.setattr(permissions, "PATIENT_PERMISSIONS",
                        permissions.PATIENT_PERMISSIONS - {"portal-records:read"})
    refused = me.get(MINE)
    assert refused.status_code == 403 and refused.json()["code"] == "permission-denied"


# ---------------------------------------------------------------------- listRefillRequests
def test_the_staff_list_open_first_oldest_first_at_the_users_facilities(
        app: FastAPI, as_user: Client, world: World, refills: Refills) -> None:
    kaia, _, oldest = _requested(app, as_user, world)
    _, _, outside_visit = _requested(app, as_user, world, facility=None)
    _requested(app, as_user, world, facility=FACILITY_B)  # nobody's here: not listed
    other = world.patient(CLINIC_B)  # another clinic's request
    theirs = refills.add(CLINIC_B, other, uuid4())
    found = as_user("md").get(STAFF)
    assert found.status_code == 200, found.text
    items = found.json()["items"]
    assert [i["id"] for i in items] == [oldest, outside_visit]
    first = items[0]
    assert (first["type"], first["status"], first["restricted"]) == ("renewal", "requested",
                                                                      False)
    assert first["patientId"] == first["patient"]["id"] == str(kaia)
    assert first["display"] == "amoxicillin 500 MG Oral Capsule"
    assert "note" not in first  # a request carries no free text (0028)
    assert "respondedAt" not in first and "respondedBy" not in first
    assert world.audited[-1] == [kaia, UUID(items[1]["patientId"])]  # every patient returned
    page = as_user("md").get(STAFF, params={"limit": 1}).json()
    assert [i["id"] for i in page["items"]] == [oldest] and page["nextCursor"]
    assert as_user("md").get(STAFF, params={"status": "approved"}).json()["items"] == []
    assert [i["id"] for i in as_user("md-b").get(STAFF).json()["items"]] == [str(theirs)]


def test_the_staff_list_leaves_a_restricted_charts_clinical_fields_out(
        app: FastAPI, as_user: Client, world: World) -> None:
    patient, _, request_id = _requested(app, as_user, world)
    world.restricted.add(patient)
    (item,) = as_user("ma").get(STAFF).json()["items"]
    assert item["restricted"] is True and item["id"] == request_id
    assert item["patientId"] == str(patient) and item["prescriptionId"] and item["requestedAt"]
    for hidden in ("patient", "display", "dosageText", "note"):
        assert hidden not in item, hidden
    assert world.audited[-1] == [patient]
    world.grants.add((DEV_USERS["ma"].id, patient))
    (opened,) = as_user("ma").get(STAFF).json()["items"]
    assert opened["restricted"] is False and opened["display"] and opened["patient"]


def test_the_staff_list_refuses(as_user: Client) -> None:
    for user in ("fd", "bil"):
        refused = as_user(user).get(STAFF)
        assert refused.status_code == 403 and refused.json()["code"] == "permission-denied"
    assert as_user("md").get(STAFF, params={"status": "open"}).status_code == 422
    assert as_user("md").get(STAFF, params={"limit": 101}).status_code == 422
    assert as_user("md").get(STAFF, params={"cursor": "bm90LWFuLW9mZnNldA"}).status_code == 400


# ------------------------------------------------------------------ respondToRefillRequest
def _respond(as_user: Client, request_id: str, user: str = "md", **body: Any) -> Any:
    return as_user(user).post(f"{STAFF}/{request_id}/respond", json=body, headers=_key())


def test_approving_writes_a_draft_the_prescriber_checks_signs_and_sends(
        app: FastAPI, as_user: Client, world: World, refills: Refills) -> None:
    patient, rx, request_id = _requested(app, as_user, world)
    approved = _respond(as_user, request_id, decision="approve")
    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert (body["status"], body["restricted"], body["patientId"]) == ("approved", False,
                                                                       str(patient))
    assert body["respondedAt"] and body["respondedBy"] == {
        "id": str(DEV_USERS["md"].id), "displayName": "Dr. Avery Lindqvist MD"}
    assert "declineReason" not in body
    new_id = UUID(body["newPrescriptionId"])
    assert refills.priors[new_id] == UUID(rx) and world.audited[-1] == [patient]
    assert app.state.fake_sessions[-1].commits == 1

    old, new = world.row(UUID(rx)), world.row(new_id)
    assert new.status == "draft" and new.encounter_id is None and new.patient_id == patient
    for name in ("drug", "dosage_text", "quantity_value", "quantity_unit", "days_supply",
                 "refills", "substitution_allowed", "pharmacy_id"):
        assert getattr(new, name) == getattr(old, name), name
    assert new.note_to_pharmacy is None

    # The patient sees the answer; the new prescription once it's signed (a draft is not theirs
    # to see yet).
    (mine,) = _patient(app, patient).get(MINE).json()["items"]
    assert mine["status"] == "approved" and mine["respondedAt"]
    assert "newPrescriptionId" not in mine
    checked = as_user("md").post(f"{API}/prescriptions/{new_id}/safety-check")
    assert checked.status_code == 200, checked.text
    sent = _sign(as_user, str(new_id), _etag(as_user, str(new_id)))
    assert sent.status_code == 200 and sent.json()["transmission"]["status"] == "queued"
    assert world.sent[-1] == new_id  # through the outbox, as any prescription (D25)
    (mine,) = _patient(app, patient).get(MINE).json()["items"]
    assert mine["newPrescriptionId"] == str(new_id)
    listed = as_user("md").get(STAFF, params={"status": "approved"}).json()["items"]
    assert [i["newPrescriptionId"] for i in listed] == [str(new_id)]


def test_approving_keeps_the_draft_within_its_schedule_and_drops_a_closed_pharmacy(
        app: FastAPI, as_user: Client, world: World) -> None:
    _, rx, request_id = _requested(app, as_user, world, refills=8)
    world.schedules["308191"] = "CIII"  # rescheduled since: at most 5 refills
    world.pharmacies[world.row(UUID(rx)).pharmacy_id] = False  # type: ignore[index]
    approved = _respond(as_user, request_id, decision="approve").json()
    new = world.row(UUID(approved["newPrescriptionId"]))
    assert (new.refills, new.dea_schedule, new.pharmacy_id) == (5, "CIII", None)


def test_declining_stores_the_reason_the_patient_sees(app: FastAPI, as_user: Client,
                                                      world: World, refills: Refills) -> None:
    patient, _, request_id = _requested(app, as_user, world)
    reason = fs.REFILL_DECLINE_REASONS[VISIT]  # the code's words, never the clinician's
    declined = _respond(as_user, request_id, user="app", decision="decline",
                        reason=f"  {VISIT} ")
    assert declined.status_code == 200, declined.text
    body = declined.json()
    assert (body["status"], body["declineReason"]) == ("declined", reason)
    assert "newPrescriptionId" not in body and body["respondedBy"]["id"] == str(
        DEV_USERS["app"].id)
    assert refills.row(UUID(request_id)).status == "cancelled"
    (mine,) = _patient(app, patient).get(MINE).json()["items"]
    assert (mine["status"], mine["declineReason"]) == ("declined", reason)
    assert as_user("md").get(STAFF).json()["items"] == []  # no longer open
    assert [i["id"] for i in as_user("md").get(STAFF, params={"status": "declined"}).json()[
        "items"]] == [request_id]


def test_an_answered_request_is_409_with_its_state(app: FastAPI, as_user: Client,
                                                   world: World) -> None:
    _, _, request_id = _requested(app, as_user, world)
    assert _respond(as_user, request_id, decision="decline", reason=VISIT).status_code == 200
    again = _respond(as_user, request_id, decision="decline", reason="contact-the-office")
    assert again.status_code == 409
    assert again.json()["code"] == "invalid-state-transition"
    assert again.json()["currentState"] == "declined"


def test_only_md_and_app_may_answer(app: FastAPI, as_user: Client, world: World,
                                    refills: Refills) -> None:
    patient, _, request_id = _requested(app, as_user, world)
    for user in ("rn", "ma", "fd"):
        refused = _respond(as_user, request_id, user=user, decision="decline", reason=VISIT)
        assert refused.status_code == 403, user
        assert refused.json()["code"] == "permission-denied"
    # D110 comes first: RN is refused before anything is read, even for no such request.
    assert _respond(as_user, str(uuid4()), user="rn", decision="approve").status_code == 403
    session = _patient(app, patient).post(f"{STAFF}/{request_id}/respond",
                                          json={"decision": "approve"}, headers=_key())
    assert session.status_code in (401, 403)  # a patient session isn't staff
    assert refills.row(UUID(request_id)).status == "active"


@pytest.mark.parametrize(("body", "pointer", "code"), [
    ({"decision": "decline"}, "/reason", "required"),
    ({"decision": "decline", "reason": "   no  "}, "/reason", "not-allowed-value"),
    ({"decision": "decline", "reason": "Please book a visit first."}, "/reason",
     "not-allowed-value"),  # free text: only the listed codes (fs.REFILL_DECLINE_REASONS)
    ({"decision": "decline", "reason": "NEEDS-VISIT"}, "/reason", "not-allowed-value"),
    ({"decision": "approve", "reason": VISIT}, "/reason", "conflicting-fields"),
])
def test_answering_checks_the_reason(app: FastAPI, as_user: Client, world: World,
                                     body: dict[str, Any], pointer: str, code: str) -> None:
    _, _, request_id = _requested(app, as_user, world)
    refused = _respond(as_user, request_id, **body)
    assert refused.status_code == 422, refused.text
    assert _errors(refused) == [(pointer, code)]


@pytest.mark.parametrize("body", [{}, {"decision": "maybe"}, {"decision": "decline",
                                                              "reason": "no"},
                                  {"decision": "decline", "reason": "x" * 501},
                                  {"decision": "approve", "extra": True}])
def test_answering_validates_the_body(app: FastAPI, as_user: Client, world: World,
                                      body: dict[str, Any]) -> None:
    _, _, request_id = _requested(app, as_user, world)
    refused = _respond(as_user, request_id, **body)
    assert refused.status_code == 422 and refused.json()["code"] == "validation-failed"


def test_answering_finds_only_the_users_requests(app: FastAPI, as_user: Client, world: World,
                                                 refills: Refills) -> None:
    _, _, request_id = _requested(app, as_user, world)
    for user, target in (("md", str(uuid4())), ("md-b", request_id)):
        refused = _respond(as_user, target, user=user, decision="decline", reason=VISIT)
        assert refused.status_code == 404 and refused.json()["code"] == "not-found"
    _, _, elsewhere = _requested(app, as_user, world, facility=FACILITY_B)
    assert _respond(as_user, elsewhere, decision="decline",
                    reason=VISIT).status_code == 404
    patient, _, restricted = _requested(app, as_user, world)
    world.restricted.add(patient)
    refused = _respond(as_user, restricted, decision="decline", reason=VISIT)
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    assert {r.status for _, r in refills.rows.values()} == {"active"}
