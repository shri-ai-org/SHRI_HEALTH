"""The three eligibility operations on the fakes (fakes.py): each with success, permission denied
and validation errors, plus another clinic's records (404), a facility not the user's (404), a
restricted chart (403, then 200 with a grant) and the business rules. The same operations run
against the real tables, with core's idempotency and the outbox, in test_eligibility_live.py.
Synthetic data only."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS, FACILITY_A, FACILITY_B

from ..repository import BenefitRow
from .fakes import World

Client = Callable[[str], TestClient]
API = "/api/v1"
OTHER_FACILITY = UUID("fa000000-0000-4000-8000-0000000000ff")


def _code(response: Any) -> str:
    found: str = response.json()["code"]
    return found


def _setup(world: World) -> tuple[UUID, UUID, UUID]:
    patient = world.patient(CLINIC_A)
    coverage = world.coverage(CLINIC_A, patient)
    appointment = world.appointment(CLINIC_A, patient, FACILITY_A)
    return patient, coverage, appointment


def _benefit(kind: str, amount: str | None, *, period: str | None = None,
             level: str | None = "individual", network: str | None = "in",
             service: str | None = "30", percent: str | None = None) -> BenefitRow:
    return BenefitRow(benefit_type=kind, service_type_code=service, coverage_level=level,
                      network=network, time_period=period,
                      amount=Decimal(amount) if amount else None,
                      percent=Decimal(percent) if percent else None,
                      authorization_required=None, message=None)


ACTIVE_BENEFITS = (
    _benefit("copay", "60.00", period="visit", network="out", service="98"),
    _benefit("copay", "25.00", period="visit", service="98"),
    _benefit("deductible", "3000.00", period="calendar-year", level="family"),
    _benefit("deductible", "1500.00", period="calendar-year"),
    _benefit("deductible", "640.00", period="remaining"),
    _benefit("coinsurance", None, percent="20"),
)


# ------------------------------------------------------------------------ runEligibilityCheck
def test_run_queues_the_check_the_operation_and_the_270(as_user: Client, world: World,
                                                       app: FastAPI) -> None:
    patient, coverage, appointment = _setup(world)
    response = as_user("fd").post(f"{API}/eligibility-checks", json={
        "coverageId": str(coverage), "appointmentId": str(appointment)})
    assert response.status_code == 202, response.text
    operation = response.json()
    assert operation["kind"] == "eligibility.check" and operation["status"] == "queued"
    assert response.headers["Location"] == f"{API}/operations/{operation['id']}"
    assert response.headers["Retry-After"] == "2"
    [(check_id, operation_id)] = world.sent  # the 270 names the check and the operation
    assert str(operation_id) == operation["id"]
    _, row = world.checks[check_id]
    assert (row.trigger, row.status, row.appointment_id) == ("manual", "pending", appointment)
    assert world.service_types[check_id] == ("30",)  # health benefit plan coverage by default
    assert world.npis[check_id] == "1234567893" and check_id in world.linked
    assert world.audited == [[patient]]
    assert app.state.fake_sessions[-1].commits == 1


def test_run_without_an_appointment_uses_the_practice_npi(as_user: Client, world: World) -> None:
    patient = world.patient(CLINIC_A)
    coverage = world.coverage(CLINIC_A, patient)
    world.practice_npi = "1245319599"
    response = as_user("bil").post(f"{API}/eligibility-checks", json={
        "coverageId": str(coverage), "serviceTypeCodes": ["30", "98"]})
    assert response.status_code == 202, response.text
    [(check_id, _)] = world.sent
    assert world.service_types[check_id] == ("30", "98")
    assert world.npis[check_id] == "1245319599"
    assert world.checks[check_id][1].appointment_id is None


def test_run_permission_denied(as_user: Client, world: World) -> None:
    _, coverage, _ = _setup(world)
    for user in ("ma", "md", "none"):  # MA and MD read checks but don't run them
        response = as_user(user).post(f"{API}/eligibility-checks",
                                      json={"coverageId": str(coverage)})
        assert response.status_code == 403 and _code(response) == "permission-denied", user
    assert world.sent == []


def test_run_validation(as_user: Client, world: World) -> None:
    _, coverage, _ = _setup(world)
    for body in ({}, {"coverageId": "not-a-uuid"},
                 {"coverageId": str(coverage), "unexpected": True},
                 {"coverageId": str(coverage), "serviceTypeCodes": []},
                 {"coverageId": str(coverage), "serviceTypeCodes": ["thirty"]},
                 {"coverageId": str(coverage), "serviceTypeCodes": ["30"] * 11}):
        response = as_user("fd").post(f"{API}/eligibility-checks", json=body)
        assert response.status_code == 422 and _code(response) == "validation-failed", body
    assert world.sent == []


def test_run_not_found(as_user: Client, world: World) -> None:
    patient, coverage, _ = _setup(world)
    theirs = world.coverage(CLINIC_B, world.patient(CLINIC_B))
    elsewhere = world.appointment(CLINIC_A, patient, OTHER_FACILITY)
    for body in ({"coverageId": str(uuid4())}, {"coverageId": str(theirs)},
                 {"coverageId": str(coverage), "appointmentId": str(uuid4())},
                 {"coverageId": str(coverage), "appointmentId": str(elsewhere)}):
        response = as_user("fd").post(f"{API}/eligibility-checks", json=body)
        assert response.status_code == 404 and _code(response) == "not-found", body
    assert world.sent == []


def test_run_restricted_chart_needs_a_grant(as_user: Client, world: World) -> None:
    patient, coverage, _ = _setup(world)
    world.restricted.add(patient)
    body = {"coverageId": str(coverage)}
    refused = as_user("fd").post(f"{API}/eligibility-checks", json=body)
    assert refused.status_code == 403 and _code(refused) == "break-glass-required"
    world.grants.add((DEV_USERS["fd"].id, patient))
    assert as_user("fd").post(f"{API}/eligibility-checks", json=body).status_code == 202


def test_run_business_rules(as_user: Client, world: World) -> None:
    patient, coverage, appointment = _setup(world)
    other = world.patient(CLINIC_A)
    theirs = world.appointment(CLINIC_A, other, FACILITY_A)
    wrong = as_user("fd").post(f"{API}/eligibility-checks", json={
        "coverageId": str(coverage), "appointmentId": str(theirs)})
    assert wrong.status_code == 422 and _code(wrong) == "business-rule-violation"
    assert wrong.json()["errors"] == [{"in": "body", "pointer": "/appointmentId",
                                       "code": "invalid-reference"}]
    for inactive in (world.coverage(CLINIC_A, patient, status="cancelled"),
                     world.coverage(CLINIC_A, patient, end=date(2026, 10, 31))):
        ended = as_user("fd").post(f"{API}/eligibility-checks", json={
            "coverageId": str(inactive), "appointmentId": str(appointment)})
        assert ended.status_code == 422 and ended.json()["errors"][0]["pointer"] == "/coverageId"
    world.merged.add(patient)
    merged = as_user("fd").post(f"{API}/eligibility-checks", json={"coverageId": str(coverage)})
    assert merged.status_code == 409 and _code(merged) == "patient-merged"
    assert world.sent == []


# ------------------------------------------------------------------------ getEligibilityCheck
def test_get_a_complete_check_with_copay_and_deductible(as_user: Client, world: World) -> None:
    patient, coverage, appointment = _setup(world)
    check_id = world.check(CLINIC_A, coverage, appointment, status="active",
                           benefits=ACTIVE_BENEFITS)
    response = as_user("ma").get(f"{API}/eligibility-checks/{check_id}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["status"], body["coverageStatus"], body["planName"]) == (
        "complete", "active", "Test PPO")
    assert body["copay"] == {"value": "25.00", "currency": "USD"}  # in network, not 60.00
    assert body["deductible"] == {"value": "1500.00", "currency": "USD"}  # individual
    assert body["deductibleRemainingAmount"] == {"value": "640.00", "currency": "USD"}
    assert len(body["benefits"]) == 6 and body["benefits"][5]["percent"] == 20
    assert "errorCode" not in body and body["expiresAt"]
    assert response.headers["ETag"].startswith('"')
    assert world.audited == [[patient]]


def test_get_maps_each_status(as_user: Client, world: World) -> None:
    _, coverage, appointment = _setup(world)
    expected = {"pending": ("pending", None), "inactive": ("complete", "inactive"),
                "not-found": ("complete", "unknown"), "error": ("error", None),
                "timeout": ("error", None)}
    for stored, (status, coverage_status) in expected.items():
        check_id = world.check(CLINIC_A, coverage, appointment, status=stored)
        body = as_user("fd").get(f"{API}/eligibility-checks/{check_id}").json()
        assert (body["status"], body.get("coverageStatus")) == (status, coverage_status), stored
        assert ("errorCode" in body) is (status == "error")
        assert ("planName" in body) is (status == "complete")


def test_get_permission_denied_and_validation(as_user: Client, world: World) -> None:
    _, coverage, appointment = _setup(world)
    check_id = world.check(CLINIC_A, coverage, appointment)
    denied = as_user("none").get(f"{API}/eligibility-checks/{check_id}")
    assert denied.status_code == 403 and _code(denied) == "permission-denied"
    bad = as_user("fd").get(f"{API}/eligibility-checks/not-a-uuid")
    assert bad.status_code == 422 and _code(bad) == "validation-failed"


def test_get_not_found_and_restricted(as_user: Client, world: World) -> None:
    patient, coverage, appointment = _setup(world)
    check_id = world.check(CLINIC_A, coverage, appointment)
    assert as_user("md-b").get(f"{API}/eligibility-checks/{check_id}").status_code == 404
    assert as_user("fd").get(f"{API}/eligibility-checks/{uuid4()}").status_code == 404
    elsewhere = world.check(CLINIC_A, coverage, world.appointment(
        CLINIC_A, patient, FACILITY_B))
    assert as_user("fd").get(f"{API}/eligibility-checks/{elsewhere}").status_code == 404
    world.restricted.add(patient)
    refused = as_user("fd").get(f"{API}/eligibility-checks/{check_id}")
    assert refused.status_code == 403 and _code(refused) == "break-glass-required"
    assert world.audited == []  # nothing shown, nobody named


# ------------------------------------------------------------ listAppointmentEligibilityChecks
def test_list_newest_first_in_pages(as_user: Client, world: World) -> None:
    patient, coverage, appointment = _setup(world)
    ids = [world.check(CLINIC_A, coverage, appointment, minutes_ago=n) for n in (30, 20, 10)]
    world.check(CLINIC_A, coverage, None)  # not this appointment's
    path = f"{API}/appointments/{appointment}/eligibility-checks"
    first = as_user("fd").get(path, params={"limit": 2})
    assert first.status_code == 200, first.text
    assert [i["id"] for i in first.json()["items"]] == [str(ids[2]), str(ids[1])]
    cursor = first.json()["nextCursor"]
    second = as_user("fd").get(path, params={"limit": 2, "cursor": cursor}).json()
    assert [i["id"] for i in second["items"]] == [str(ids[0])] and "nextCursor" not in second
    assert world.audited == [[patient], [patient]]


def test_list_permission_denied_and_validation(as_user: Client, world: World) -> None:
    _, _, appointment = _setup(world)
    path = f"{API}/appointments/{appointment}/eligibility-checks"
    denied = as_user("dsp").get(path)
    assert denied.status_code == 403 and _code(denied) == "permission-denied"
    for params in ({"limit": 0}, {"limit": 101}, {"cursor": "not valid!"}):
        bad = as_user("fd").get(path, params=params)
        assert bad.status_code == 422 and _code(bad) == "validation-failed", params
    tampered = as_user("fd").get(path, params={"cursor": "eDoxMA"})  # "x:10"
    assert tampered.status_code == 400 and _code(tampered) == "invalid-cursor"
    assert as_user("fd").get(f"{API}/appointments/not-a-uuid/eligibility-checks"
                             ).status_code == 422


def test_list_not_found_and_restricted(as_user: Client, world: World) -> None:
    patient, coverage, appointment = _setup(world)
    world.check(CLINIC_A, coverage, appointment)
    path = f"{API}/appointments/{appointment}/eligibility-checks"
    assert as_user("md-b").get(path).status_code == 404
    elsewhere = world.appointment(CLINIC_A, patient, FACILITY_B)
    assert as_user("fd").get(f"{API}/appointments/{elsewhere}/eligibility-checks"
                             ).status_code == 404
    world.restricted.add(patient)
    refused = as_user("md").get(path)
    assert refused.status_code == 403 and _code(refused) == "break-glass-required"
    world.grants.add((DEV_USERS["md"].id, patient))
    assert len(as_user("md").get(path).json()["items"]) == 1
