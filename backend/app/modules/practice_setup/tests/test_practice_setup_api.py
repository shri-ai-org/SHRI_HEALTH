"""The six practice-setup lists (practice-setup.yaml) on the in-memory repository (fakes.py).

Every route: success with the contract's field names, 401 and 403, an invalid cursor (400
`invalid-cursor`), the `active` filter, keyset paging with `nextCursor` absent on the last page,
and its own filters (`facilityId`, `providerId`, the payer search). The real SQL, row-level
security and tenant_db's `facilityId` check are in test_practice_setup_live.py. Synthetic data only.
"""

from collections.abc import Callable
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.core.deps import CLINIC_A, CLINIC_B

from .. import cursor
from ..cursor import Position
from . import fakes
from .fakes import World

Client = Callable[[str], TestClient]

# path, a user with its permission, the cursor kind
ROUTES = [
    ("/api/v1/facilities", "adm", "facilities"),
    ("/api/v1/providers", "adm", "providers"),
    ("/api/v1/appointment-types", "co", "appointment-types"),
    ("/api/v1/provider-schedules", "adm", "provider-schedules"),
    ("/api/v1/payers", "fd", "payers"),
    ("/api/v1/practice-payers", "adm", "practice-payers"),
]
PATHS = [path for path, _, _ in ROUTES]


@pytest.fixture
def seeded(world: World) -> dict[str, Any]:
    """Clinic A: three of everything, the last one inactive; clinic B: one of each."""
    a, b = world.clinic(CLINIC_A), world.clinic(CLINIC_B)
    a.facilities = [fakes.facility(f"Test Clinic {c}", active=c != "C", n=i)
                    for i, c in enumerate("ABC")]
    b.facilities = [fakes.facility("Other Clinic Site")]
    f1, f2 = a.facilities[0].id, a.facilities[1].id
    a.providers = [fakes.provider("Lowe58", [f1], n=1), fakes.provider("Kuhlman72", [f2], n=2),
                   fakes.provider("Gerard14", [f1, f2], active=False, n=3)]
    b.providers = [fakes.provider("Other", [b.facilities[0].id])]
    a.appointment_types = [fakes.appointment_type(t, active=t != "Telehealth")
                           for t in ("Follow-up visit", "New patient", "Telehealth")]
    b.appointment_types = [fakes.appointment_type("Other visit")]
    p1, p2 = a.providers[0].id, a.providers[1].id
    a.schedules = [fakes.schedule(p1, f1, n=1), fakes.schedule(p2, f2, n=2),
                   fakes.schedule(p1, f2, active=False, n=3)]
    b.schedules = [fakes.schedule(b.providers[0].id, b.facilities[0].id)]
    world.payers = [fakes.payer("Test Health Plan", external_id="TEST01"),
                    fakes.payer("Test Medicare", payer_type="medicare", external_id="TEST02"),
                    fakes.payer("Retired Test Plan", active=False)]
    a.practice_payers = [fakes.practice_payer(p, active=p.active) for p in world.payers]
    b.practice_payers = [fakes.practice_payer(world.payers[0])]
    return {"a": a, "b": b}


def code(response: Any) -> str:
    value: str = response.json()["code"]
    return value


def walk(client: TestClient, path: str, **params: Any) -> list[dict[str, Any]]:
    """Every item of a list, page by page."""
    items: list[dict[str, Any]] = []
    query = dict(params)
    while True:
        response = client.get(path, params=query)
        assert response.status_code == 200, response.text
        body = response.json()
        items += body["items"]
        if "nextCursor" not in body:
            return items
        assert len(body["items"]) == query["limit"]
        query["cursor"] = body["nextCursor"]


# ----------------------------------------------------------------------------------- success
def test_facilities_in_the_contracts_shape(as_user: Client, seeded: dict[str, Any]) -> None:
    response = as_user("adm").get("/api/v1/facilities")
    assert response.status_code == 200, response.text
    body = response.json()
    assert "nextCursor" not in body
    assert [f["name"] for f in body["items"]] == ["Test Clinic A", "Test Clinic B",
                                                  "Test Clinic C"]
    first = body["items"][0]
    assert first == {
        "id": str(seeded["a"].facilities[0].id), "code": "A", "name": "Test Clinic A",
        "timeZone": "America/Chicago",
        "address": {"lines": ["200 Test Avenue"], "city": "Springfield", "state": "IL",
                    "postalCode": "62702", "country": "US"},
        "phone": "+12175550110", "npi": "1234567893", "placeOfServiceCode": "11",
        "billingLocation": True, "active": True,
        "createdAt": "2026-10-26T13:00:00Z", "updatedAt": "2026-10-26T13:00:00Z",
    }


def test_providers_in_the_contracts_shape(as_user: Client, seeded: dict[str, Any]) -> None:
    body = as_user("co").get("/api/v1/providers").json()
    assert [p["name"]["family"] for p in body["items"]] == ["Lowe58", "Kuhlman72", "Gerard14"]
    first = body["items"][0]
    assert first["name"] == {"family": "Lowe58", "given": ["Test"], "prefix": "Dr."}
    assert first["qualifications"] == [{
        "code": {"system": "http://terminology.hl7.org/CodeSystem/v2-0360", "code": "MD"},
        "licenseNumber": "TEST-LIC-0042", "state": "IL", "startDate": "2015-07-01"}]
    assert first["specialties"][0]["code"] == "207R00000X"
    assert first["facilityIds"] == [str(seeded["a"].facilities[0].id)]
    assert {k: first[k] for k in ("npi", "gender", "phone", "email", "active")} == {
        "npi": "1245319599", "gender": "female", "phone": "+12175550120",
        "email": "test.provider@example.com", "active": True}


def test_appointment_types_in_the_contracts_shape(as_user: Client,
                                                  seeded: dict[str, Any]) -> None:
    body = as_user("adm").get("/api/v1/appointment-types").json()
    assert [t["name"] for t in body["items"]] == ["Follow-up visit", "New patient", "Telehealth"]
    first = body["items"][0]
    assert {k: first[k] for k in ("defaultDurationMinutes", "color", "allowOverlap",
                                  "maxOverbook", "requiresEligibilityCheck", "telehealth",
                                  "newPatient")} == {
        "defaultDurationMinutes": 20, "color": "#2E7D32", "allowOverlap": False,
        "maxOverbook": 1, "requiresEligibilityCheck": True, "telehealth": False,
        "newPatient": False}
    assert "defaultNoteTemplateId" not in first


def test_provider_schedules_in_the_contracts_shape(as_user: Client,
                                                   seeded: dict[str, Any]) -> None:
    body = as_user("adm").get("/api/v1/provider-schedules").json()
    assert len(body["items"]) == 3
    first = body["items"][0]
    assert first["providerId"] == str(seeded["a"].providers[0].id)
    assert first["facilityId"] == str(seeded["a"].facilities[0].id)
    rule = first["availabilityRules"][0]
    assert {k: v for k, v in rule.items() if k != "id"} == {
        "dayOfWeek": "tue", "startTime": "08:00", "endTime": "12:00", "slotMinutes": 20,
        "appointmentTypeIds": [], "startDate": "2026-11-01"}
    exception = first["exceptions"][0]
    assert {k: v for k, v in exception.items() if k != "id"} == {
        "startAt": "2026-11-24T14:00:00Z", "endAt": "2026-11-24T18:00:00Z",
        "available": False, "reason": "Conference"}


def test_payers_in_the_contracts_shape(as_user: Client, seeded: dict[str, Any]) -> None:
    body = as_user("fd").get("/api/v1/payers").json()
    assert [p["name"] for p in body["items"]] == ["Retired Test Plan", "Test Health Plan",
                                                  "Test Medicare"]
    plan = body["items"][1]
    assert plan["payerType"] == "commercial"
    assert plan["clearinghouseIds"] == [{"clearinghouse": "waystar",
                                         "externalPayerId": "TEST01"}]
    assert (plan["supportsEligibility"], plan["supportsClaimStatus"], plan["supportsEra"]) == (
        True, True, True)


def test_practice_payers_in_the_contracts_shape(as_user: Client,
                                                seeded: dict[str, Any]) -> None:
    body = as_user("adm").get("/api/v1/practice-payers").json()
    assert [p["payer"]["name"] for p in body["items"]] == ["Retired Test Plan",
                                                           "Test Health Plan", "Test Medicare"]
    plan = body["items"][1]
    assert plan["payerId"] == plan["payer"]["id"]
    assert plan["payer"]["payerType"] == "commercial"
    assert plan["enrollments"] == [
        {"transaction": "270", "clearinghouse": "waystar", "status": "not-required"},
        {"transaction": "837P", "clearinghouse": "waystar", "status": "approved",
         "submittedAt": "2026-10-26T13:01:00Z", "approvedAt": "2026-10-26T13:02:00Z"}]


def test_another_clinics_rows_are_not_listed(as_user: Client, seeded: dict[str, Any]) -> None:
    mine = {str(f.id) for f in seeded["a"].facilities}
    assert {f["id"] for f in as_user("adm").get("/api/v1/facilities").json()["items"]} == mine


# ----------------------------------------------------------------------------------- refusals
@pytest.mark.parametrize("path", PATHS)
def test_without_a_session_is_401(as_user: Client, path: str) -> None:
    client = as_user("adm")
    del client.headers["X-Dev-User"]
    response = client.get(path)
    assert response.status_code == 401 and code(response) == "unauthenticated"


@pytest.mark.parametrize("path, user", [(p, u) for p in PATHS for u in ("md", "none")]
                         + [("/api/v1/payers", "co"), ("/api/v1/facilities", "fd"),
                            ("/api/v1/practice-payers", "bil")])
def test_a_role_without_the_permission_is_403(as_user: Client, seeded: dict[str, Any],
                                              path: str, user: str) -> None:
    response = as_user(user).get(path)
    assert response.status_code == 403 and code(response) == "permission-denied"


@pytest.mark.parametrize("path", PATHS)
def test_the_permission_is_checked_before_the_cursor(as_user: Client, path: str) -> None:
    response = as_user("md").get(path, params={"cursor": "bm90LWEtY3Vyc29y"})
    assert response.status_code == 403


def _forged(payload: dict[str, Any]) -> str:
    import base64
    import json
    raw = json.dumps(payload).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


@pytest.mark.parametrize("path, user, kind", ROUTES)
@pytest.mark.parametrize("bad", ["bm90LWEtY3Vyc29y", "A", "e30", "W10"])
def test_a_malformed_cursor_is_400(as_user: Client, path: str, user: str, kind: str,
                                   bad: str) -> None:
    response = as_user(user).get(path, params={"cursor": bad})
    assert response.status_code == 400, response.text
    assert code(response) == "invalid-cursor"


@pytest.mark.parametrize("path, user, kind", ROUTES)
def test_another_lists_cursor_is_400(as_user: Client, path: str, user: str, kind: str) -> None:
    other = "payers" if kind != "payers" else "facilities"
    foreign = cursor.encode(Position(kind=other, key="Test",  # type: ignore[arg-type]
                                     id=uuid4()))
    response = as_user(user).get(path, params={"cursor": foreign})
    assert response.status_code == 400 and code(response) == "invalid-cursor"


@pytest.mark.parametrize("path, user, kind", ROUTES)
def test_a_wrongly_typed_cursor_is_400(as_user: Client, path: str, user: str, kind: str) -> None:
    for payload in ({"v": 1, "k": kind, "s": 7, "i": str(uuid4())},
                    {"v": 1, "k": kind, "s": "x", "i": "not-a-uuid"},
                    {"v": True, "k": kind, "s": "x", "i": str(uuid4())},
                    {"v": 1, "k": kind, "s": "x", "i": str(uuid4()), "extra": 1}):
        response = as_user(user).get(path, params={"cursor": _forged(payload)})
        assert response.status_code == 400, payload
        assert code(response) == "invalid-cursor"


@pytest.mark.parametrize("path, user, kind", ROUTES)
@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 101}, {"cursor": "not valid!"},
                                    {"active": "maybe"}])
def test_invalid_parameters_are_422(as_user: Client, path: str, user: str, kind: str,
                                    params: dict[str, Any]) -> None:
    response = as_user(user).get(path, params=params)
    assert response.status_code == 422 and code(response) == "validation-failed"


# ------------------------------------------------------------------------------- filters, paging
@pytest.mark.parametrize("path, user, kind", ROUTES)
def test_the_active_filter(as_user: Client, seeded: dict[str, Any], path: str, user: str,
                           kind: str) -> None:
    everything = as_user(user).get(path).json()["items"]
    active = as_user(user).get(path, params={"active": "true"}).json()["items"]
    inactive = as_user(user).get(path, params={"active": "false"}).json()["items"]
    assert len(everything) == 3 and len(active) == 2 and len(inactive) == 1
    assert all(i["active"] for i in active) and not inactive[0]["active"]
    assert {i["id"] for i in active + inactive} == {i["id"] for i in everything}


@pytest.mark.parametrize("path, user, kind", ROUTES)
def test_keyset_paging_walks_every_row_once(as_user: Client, seeded: dict[str, Any],
                                            path: str, user: str, kind: str) -> None:
    everything = as_user(user).get(path).json()["items"]
    for limit in (1, 2, 3):
        paged = walk(as_user(user), path, limit=limit)
        assert [i["id"] for i in paged] == [i["id"] for i in everything]


def test_providers_by_facility(as_user: Client, seeded: dict[str, Any]) -> None:
    f1, f2, f3 = (str(f.id) for f in seeded["a"].facilities)
    by = {f: {p["name"]["family"] for p in as_user("adm").get(
        "/api/v1/providers", params={"facilityId": f}).json()["items"]} for f in (f1, f2, f3)}
    assert by == {f1: {"Lowe58", "Gerard14"}, f2: {"Kuhlman72", "Gerard14"}, f3: set()}
    active_at_f1 = as_user("adm").get("/api/v1/providers",
                                      params={"facilityId": f1, "active": "true"}).json()
    assert [p["name"]["family"] for p in active_at_f1["items"]] == ["Lowe58"]


def test_a_provider_with_no_active_role_is_listed_with_no_facilities(
        as_user: Client, seeded: dict[str, Any]) -> None:
    seeded["a"].providers.append(fakes.provider("Unplaced", [], n=4))
    items = as_user("adm").get("/api/v1/providers", params={"limit": 10}).json()["items"]
    unplaced = [p for p in items if p["name"]["family"] == "Unplaced"]
    assert len(unplaced) == 1 and unplaced[0]["facilityIds"] == []
    f1 = str(seeded["a"].facilities[0].id)
    at_f1 = as_user("adm").get("/api/v1/providers", params={"facilityId": f1}).json()["items"]
    assert "Unplaced" not in {p["name"]["family"] for p in at_f1}


def test_provider_schedules_by_provider_and_facility(as_user: Client,
                                                     seeded: dict[str, Any]) -> None:
    a = seeded["a"]
    p1, f2 = str(a.providers[0].id), str(a.facilities[1].id)

    def ids(**params: str) -> list[str]:
        items = as_user("adm").get("/api/v1/provider-schedules", params=params).json()["items"]
        return [s["id"] for s in items]

    assert ids(providerId=p1) == [str(a.schedules[0].id), str(a.schedules[2].id)]
    assert ids(facilityId=f2) == [str(a.schedules[1].id), str(a.schedules[2].id)]
    assert ids(providerId=p1, facilityId=f2) == [str(a.schedules[2].id)]
    assert ids(providerId=p1, facilityId=f2, active="true") == []
    assert ids(providerId=str(uuid4())) == []


def test_payer_search(as_user: Client, seeded: dict[str, Any]) -> None:
    def names(**params: str) -> list[str]:
        response = as_user("bil").get("/api/v1/payers", params=params)
        assert response.status_code == 200, response.text
        return [p["name"] for p in response.json()["items"]]

    assert names(payerName="health") == ["Test Health Plan"]
    assert names(externalPayerId="TEST02") == ["Test Medicare"]
    assert names(payerType="medicare") == ["Test Medicare"]
    assert names(payerName="plan", active="true") == ["Test Health Plan"]
    assert names(externalPayerId="NOPE") == []
    for bad in ({"payerName": "x"}, {"payerType": "medical"}, {"externalPayerId": "x" * 41}):
        response = as_user("bil").get("/api/v1/payers", params=bad)
        assert response.status_code == 422, bad
