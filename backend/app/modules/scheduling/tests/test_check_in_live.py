"""Check-in and its undo against a live database (D16, D55, ADR-0011), as shri_app, with core's
tenant_db, facility filter, audit and idempotency (the key is required here) and Anand's encounter
helpers running for real. Today's appointments are written directly, at noon in the facility's
zone, because a same-day booking through the API depends on the time the tests run. Synthetic
data only."""

from __future__ import annotations

import datetime as dt
import os
import uuid
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.db.models import MAPPERS
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url

from .conftest import ZONE, Practice, local, setup_session

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
M = MAPPERS


def _sql(practice: Practice, sql: str, **params: Any) -> Any:
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        result = db.execute(text(sql), params).all() if sql.lstrip().upper().startswith(
            "SELECT") else db.execute(text(sql), params)
        db.commit()
        return result
    finally:
        db.close()
        admin.dispose()


def _today_appointment(practice: Practice, patient: str = "kaia",
                       facility: UUID | None = None) -> str:
    """A booked appointment today at noon, facility time, with its provider, room and reason."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        start = dt.datetime.combine(dt.datetime.now(ZoneInfo(ZONE)).date(), dt.time(12),
                                    ZoneInfo(ZONE))
        appt = M["appointment"](
            tenant_id=practice.clinic, status="booked", start=start,
            end=start + dt.timedelta(minutes=20), minutes_duration=20,
            subject_patient_id=practice.patients[patient],
            ext_appointment_type_id=practice.types["FU"],
            ext_facility_id=facility or practice.facility)
        appt.participant = [
            M["appointment_participant"](actor_patient_id=practice.patients[patient],
                                         status="accepted"),
            M["appointment_participant"](actor_practitioner_id=practice.provider,
                                         status="accepted"),
            M["appointment_participant"](actor_location_id=practice.room, status="accepted")]
        db.add(appt)
        db.flush()
        db.add(M["appointment_reason"](appointment_id=appt.id,
                                       reason_code_text="Follow-up on headaches."))
        appointment_id = str(appt.id)
        db.commit()
        return appointment_id
    finally:
        db.close()
        admin.dispose()


def _coverage(practice: Practice, patient: str = "kaia") -> UUID:
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        cov = M["coverage"](tenant_id=practice.clinic, status="active",
                            beneficiary_patient_id=practice.patients[patient],
                            subscriber_patient_id=practice.patients[patient],
                            relationship_code="self", order=1,
                            period_start=dt.date(2026, 1, 1))
        db.add(cov)
        db.flush()
        coverage_id: UUID = cov.id
        db.commit()
        return coverage_id
    finally:
        db.close()
        admin.dispose()


def _key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _check_in(client: Any, appointment_id: str, user: str = "fd", **body: Any) -> Any:
    return client(user).post(f"{API}/appointments/{appointment_id}/check-in", json=body,
                             headers=_key())


def _code(response: Any) -> str:
    code: str = response.json()["code"]
    return code


# ----------------------------------------------------------------------------------- check-in
def test_check_in_opens_the_encounter_and_records_eligibility(client: Any,
                                                              practice: Practice) -> None:
    coverage = _coverage(practice)
    appointment = _today_appointment(practice)
    done = _check_in(client, appointment)
    assert done.status_code == 200, done.text
    result = done.json()
    assert result["appointment"]["status"] == "checked-in"
    assert result["appointment"]["visitStatus"] == "checked-in"
    assert result["appointment"]["encounterId"] == result["encounterId"]
    assert done.headers["ETag"].startswith('"')
    encounter = _sql(practice, "SELECT status, appointment_id, ext_self_pay, ext_facility_id "
                     "FROM clinical.encounter WHERE id = :e", e=result["encounterId"])[0]
    assert tuple(encounter) == ("arrived", UUID(appointment), False, practice.facility)
    check = _sql(practice, "SELECT coverage_id, status, trigger, encounter_id FROM "
                 "admin.eligibility_check WHERE id = :c", c=result["eligibilityCheckId"])[0]
    assert tuple(check) == (coverage, "pending", "check-in", UUID(result["encounterId"]))
    board = client("ma").get(f"{API}/status-board", params={
        "facilityId": str(practice.facility), "view": "staff"}).json()["items"]
    assert [(b["visitStatus"], b["encounterId"]) for b in board] == [
        ("checked-in", result["encounterId"])]


def test_self_pay_needs_no_coverage(client: Any, practice: Practice) -> None:
    appointment = _today_appointment(practice, "marcus")
    refused = _check_in(client, appointment)
    assert refused.status_code == 422 and _code(refused) == "business-rule-violation"
    assert refused.json()["errors"][0] == {"in": "body", "pointer": "/selfPay",
                                           "code": "required"}
    done = _check_in(client, appointment, selfPay=True)
    assert done.status_code == 200, done.text
    assert "eligibilityCheckId" not in done.json()
    assert _sql(practice, "SELECT ext_self_pay FROM clinical.encounter WHERE id = :e",
                e=done.json()["encounterId"])[0][0] is True


def test_check_in_refuses(client: Any, practice: Practice) -> None:
    _coverage(practice)
    appointment = _today_appointment(practice)
    url = f"{API}/appointments/{appointment}/check-in"
    assert client("ma").post(url, json={}, headers=_key()).status_code == 403
    assert client("none").post(url, json={}, headers=_key()).status_code == 403
    missing_key = client("fd").post(url, json={})
    assert missing_key.status_code == 400 and _code(missing_key) == "idempotency-key-missing"
    assert client("fd").post(url, json={"selfPay": "maybe"}, headers=_key()).status_code == 422
    assert client("fd").post(url, json={"roomId": "x"}, headers=_key()).status_code == 422
    assert client("fd-b").post(url, json={}, headers=_key()).status_code == 404
    assert _check_in(client, appointment).status_code == 200
    twice = _check_in(client, appointment)
    assert twice.status_code == 409 and _code(twice) == "invalid-state-transition"
    assert twice.json()["currentState"] == "checked-in"


def test_check_in_is_same_day_only(client: Any, practice: Practice) -> None:
    _coverage(practice)
    booked = client("fd").post(f"{API}/appointments", json={
        "patientId": str(practice.patients["kaia"]), "providerId": str(practice.provider),
        "facilityId": str(practice.facility), "appointmentTypeId": str(practice.types["FU"]),
        "startAt": local(practice.day, 9)}).json()
    later = _check_in(client, booked["id"])
    assert later.status_code == 422 and later.json()["errors"][0] == {
        "in": "path", "name": "appointmentId", "code": "out-of-range"}


def test_check_in_at_another_facility_is_not_found(client: Any, practice: Practice) -> None:
    _coverage(practice)
    appointment = _today_appointment(practice, facility=practice.other_facility)
    assert _check_in(client, appointment).status_code == 404


def test_a_restricted_chart_checks_in_without_break_glass(client: Any,
                                                         practice: Practice) -> None:
    """SECURITY_MODEL §5.2 rule 2: check-in is a front-desk exception."""
    appointment = _today_appointment(practice, "restricted")
    done = _check_in(client, appointment, selfPay=True)
    assert done.status_code == 200, done.text
    assert done.json()["appointment"]["patient"]["restricted"] is True
    assert "reasonForVisit" not in done.json()["appointment"]


def test_a_merged_patient_cannot_check_in(client: Any, practice: Practice) -> None:
    appointment = _today_appointment(practice, "marcus")
    _sql(practice, "INSERT INTO clinical.patient_link (id, tenant_id, patient_id, "
         "other_patient_id, type) VALUES (:i, :t, :p, :o, 'replaced-by')",
         i=uuid.uuid4(), t=practice.clinic, p=practice.patients["marcus"],
         o=practice.patients["kaia"])
    merged = _check_in(client, appointment, selfPay=True)
    assert merged.status_code == 409 and _code(merged) == "patient-merged"


@pytest.mark.skipif(not os.environ.get("OPENBAO_TRANSIT_ADDR")
                    and os.environ.get("REQUIRE_OPENBAO") != "1",
                    reason="OPENBAO_TRANSIT_ADDR not set (the stored response is encrypted)")
def test_a_repeated_check_in_replays_the_first(client: Any, practice: Practice) -> None:
    appointment = _today_appointment(practice)
    key = _key()
    url = f"{API}/appointments/{appointment}/check-in"
    first = client("fd").post(url, json={"selfPay": True}, headers=key)
    assert first.status_code == 200, first.text
    replay = client("fd").post(url, json={"selfPay": True}, headers=key)
    assert replay.status_code == 200 and replay.headers["Idempotent-Replayed"] == "true"
    assert replay.json()["encounterId"] == first.json()["encounterId"]
    assert _sql(practice, "SELECT count(*) FROM clinical.encounter WHERE appointment_id = :a",
                a=appointment)[0][0] == 1  # opened once


# --------------------------------------------------------------------------------------- undo
def test_undo_returns_the_appointment_to_booked(client: Any, practice: Practice) -> None:
    _coverage(practice)
    appointment = _today_appointment(practice)
    checked = _check_in(client, appointment).json()
    undone = client("fd").post(f"{API}/appointments/{appointment}/undo-check-in",
                               json={"reason": "Checked in the wrong patient."})
    assert undone.status_code == 200, undone.text
    body = undone.json()
    assert body["status"] == "booked"
    assert "visitStatus" not in body and "encounterId" not in body  # db/CLAUDE.md, D55
    encounter = checked["encounterId"]
    assert _sql(practice, "SELECT status FROM clinical.encounter WHERE id = :e",
                e=encounter)[0][0] == "entered-in-error"
    provenance = _sql(practice, "SELECT activity_code, reason_text FROM clinical.provenance "
                      "WHERE target_id = :e", e=encounter)
    assert [tuple(p) for p in provenance] == [("NULLIFY", "Checked in the wrong patient.")]
    assert _sql(practice, "SELECT status FROM admin.eligibility_check WHERE id = :c",
                c=checked["eligibilityCheckId"])[0][0] == "pending"  # kept
    again = _check_in(client, appointment)
    assert again.status_code == 200 and again.json()["encounterId"] != encounter


def test_undo_refuses(client: Any, practice: Practice) -> None:
    appointment = _today_appointment(practice)
    url = f"{API}/appointments/{appointment}/undo-check-in"
    reason = {"reason": "Wrong patient."}
    not_yet = client("fd").post(url, json=reason)
    assert not_yet.status_code == 409 and not_yet.json()["currentState"] == "booked"
    _check_in(client, appointment, selfPay=True)
    assert client("ma").post(url, json=reason).status_code == 403
    assert client("fd").post(url, json={}).status_code == 422
    assert client("fd").post(url, json={"reason": ""}).status_code == 422
    assert client("fd-b").post(url, json=reason).status_code == 404


def test_undo_is_refused_after_rooming(client: Any, practice: Practice) -> None:
    appointment = _today_appointment(practice)
    _check_in(client, appointment, selfPay=True)
    _sql(practice, "INSERT INTO admin.visit_flow_event (id, tenant_id, appointment_id, step, "
         "occurred_at, location_id) VALUES (:i, :t, :a, 'roomed', now(), :r)",
         i=uuid.uuid4(), t=practice.clinic, a=appointment, r=practice.room)
    roomed = client("fd").post(f"{API}/appointments/{appointment}/undo-check-in",
                               json={"reason": "Wrong patient."})
    assert roomed.status_code == 409 and roomed.json()["currentState"] == "roomed"


def test_undo_is_refused_once_there_are_vitals(client: Any, practice: Practice) -> None:
    appointment = _today_appointment(practice)
    encounter = _check_in(client, appointment, selfPay=True).json()["encounterId"]
    _sql(practice, "INSERT INTO clinical.observation (id, tenant_id, status, code_system, "
         "code_code, subject_patient_id, encounter_id, effective_date_time) VALUES "
         "(:i, :t, 'final', 'http://loinc.org', '8867-4', :p, :e, now())",
         i=uuid.uuid4(), t=practice.clinic, p=practice.patients["kaia"], e=encounter)
    refused = client("fd").post(f"{API}/appointments/{appointment}/undo-check-in",
                                json={"reason": "Wrong patient."})
    assert refused.status_code == 409 and _code(refused) == "invalid-state-transition"
    assert _sql(practice, "SELECT status FROM clinical.encounter WHERE id = :e",
                e=encounter)[0][0] == "arrived"
