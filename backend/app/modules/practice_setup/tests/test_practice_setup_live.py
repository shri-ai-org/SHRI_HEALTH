"""The six practice-setup lists against a live database, as shri_app, with nothing replaced but
the sign-in: core's tenant_db (row-level security, the `facilityId` check, audit) and the real
reads (repository.py). Each test gets two fresh clinics and its own platform payers. Runs where
``TEST_DATABASE_URL`` is set. Synthetic data only.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime, time
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import DEV_USER_HEADER, CurrentUser, current_user
from app.db.models import systems
from app.db.tests import builders as b
from app.db.tests.conftest import (
    TEST_DATABASE_URL,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)
from app.main import create_app

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
M = b.M
LISTS = ("/api/v1/facilities", "/api/v1/providers", "/api/v1/appointment-types",
         "/api/v1/provider-schedules", "/api/v1/practice-payers")


# ----------------------------------------------------------------------------------- data
def _payer(admin: Engine, name: str, external_id: str, payer_type: str = "commercial",
           active: bool = True) -> UUID:
    """A platform payer: shri_app may only read the directory, so the platform (here the test's
    superuser connection) writes it."""
    payer_id = uuid.uuid4()
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.payer (id, name, payer_type, supports_eligibility, "
            "supports_claim_status, supports_era, is_active) "
            "VALUES (:i, :n, :t, true, true, false, :a)"),
            {"i": payer_id, "n": name, "t": payer_type, "a": active})
        c.execute(text(
            "INSERT INTO admin.payer_clearinghouse_id (id, payer_id, clearinghouse, "
            "external_payer_id) VALUES (:i, :p, 'waystar', :e)"),
            {"i": uuid.uuid4(), "p": payer_id, "e": external_id})
    return payer_id


def _site(db: Session, name: str, code: str, org_id: UUID, *, active: bool = True) -> Any:
    site = M["location"](name=name, physical_type_system=systems.LOCATION_PHYSICAL_TYPE,
                         physical_type_code="si", managing_organization_id=org_id)
    db.add(site)
    db.flush()
    fac = M["facility"](tenant_id=db.info["tenant_id"], location_id=site.id, code=code,
                        name=name, timezone="America/Chicago", is_active=active)
    db.add(fac)
    db.flush()
    return fac


def _provider(db: Session, family: str, facilities: list[Any], *, active: bool = True) -> Any:
    made = b.practitioner(db, family, "Test")
    pr = made["practitioner"]
    pr.active = active
    roles = []
    for fac in facilities:
        role = M["practitioner_role"](practitioner_id=pr.id)
        db.add(role)
        db.flush()
        db.add(M["practitioner_role_location"](practitioner_role_id=role.id,
                                               location_id=fac.location_id))
        roles.append(role)
    db.flush()
    return {"practitioner": pr, "user": made["user"], "roles": roles}


def _clinic(admin: Engine, app_engine: Engine, tag: str, payers: list[UUID],
            clearinghouse: str = "waystar") -> dict[str, Any]:
    """One practice: three facilities (one inactive), three providers (one inactive), three
    appointment types (one inactive), two schedules and two practice payers with enrollments."""
    tenant = make_tenant(admin)
    db = open_session(app_engine, tenant)
    ctx = b.practice(db)  # organization, site, facility "Main office", Dr. Rivera with a user
    main = ctx["facility"]
    db.add_all([
        M["address"](location_id=main.location_id, line=["200 Test Avenue"], city="Springfield",
                     state="IL", postal_code="62702", country="US", use="work"),
        M["contact_point"](location_id=main.location_id, system="phone", value="+12175550110",
                           rank=1),
    ])
    north = _site(db, "North office", "NORTH", ctx["org"].id)
    closed = _site(db, "Closed office", "CLOSED", ctx["org"].id, active=False)

    rivera = ctx["practitioner"]
    rivera_role = M["practitioner_role"](practitioner_id=rivera.id)
    db.add(rivera_role)
    db.flush()
    db.add_all([
        M["practitioner_role_location"](practitioner_role_id=rivera_role.id,
                                        location_id=main.location_id),
        M["practitioner_role_specialty"](practitioner_role_id=rivera_role.id,
                                         specialty_system=systems.NUCC,
                                         specialty_code="2084N0400X",
                                         specialty_display="Neurology"),
        M["practitioner_qualification"](practitioner_id=rivera.id, code_system=systems.V2_0360,
                                        code_code="MD", identifier_value="TEST-LIC-0042",
                                        ext_state="IL", issuer_display="Test Medical Board",
                                        period_start=date(2015, 7, 1)),
        M["contact_point"](practitioner_id=rivera.id, system="phone", value="+12175550120",
                           use="work", rank=1),
        M["contact_point"](practitioner_id=rivera.id, system="email",
                           value="elena.rivera@example.com", use="work"),
    ])
    lowe = _provider(db, "Lowe", [north])
    retired = _provider(db, "Gerard", [main, north], active=False)

    types = []
    for code, name, active in (("FOLLOWUP", "Follow-up visit", True),
                               ("NEW", "New patient", True), ("OLD", "Retired visit", False)):
        t = M["appointment_type"](tenant_id=tenant, code=code, name=name,
                                  default_duration_minutes=20, is_active=active)
        db.add(t)
        types.append(t)
    db.flush()

    # One schedule's actor is the PractitionerRole (as the starter seed makes them), the
    # other's the Practitioner itself.
    by_role = M["schedule"](ext_facility_id=main.id, comment="Mornings only")
    db.add(by_role)
    db.flush()
    db.add(M["schedule_actor"](schedule_id=by_role.id, practitioner_role_id=rivera_role.id))
    by_practitioner = M["schedule"](ext_facility_id=north.id, active=False)
    db.add(by_practitioner)
    db.flush()
    db.add(M["schedule_actor"](schedule_id=by_practitioner.id,
                               practitioner_id=lowe["practitioner"].id))
    rule = M["schedule_availability_rule"](tenant_id=tenant, schedule_id=by_role.id,
                                           day_of_week="tue", start_time=time(8),
                                           end_time=time(12), slot_minutes=20,
                                           location_id=ctx["room"].id,
                                           effective_from=date(2026, 11, 1))
    monday = M["schedule_availability_rule"](tenant_id=tenant, schedule_id=by_role.id,
                                             day_of_week="mon", start_time=time(9),
                                             end_time=time(11), slot_minutes=15,
                                             effective_from=date(2026, 11, 1),
                                             effective_to=date(2026, 12, 31))
    db.add_all([rule, monday])
    db.flush()
    db.add_all([
        M["availability_rule_appointment_type"](tenant_id=tenant, rule_id=rule.id,
                                                appointment_type_id=t.id)
        for t in types[:2]
    ])
    db.add(M["schedule_exception"](tenant_id=tenant, schedule_id=by_role.id,
                                   start_at=datetime(2026, 11, 24, 14, tzinfo=UTC),
                                   end_at=datetime(2026, 11, 24, 18, tzinfo=UTC),
                                   is_available=False, reason="Conference"))

    practice_payers = []
    for n, payer_id in enumerate(payers):
        pp = M["practice_payer"](tenant_id=tenant, payer_id=payer_id, is_active=n == 0)
        db.add(pp)
        practice_payers.append(pp)
    db.add_all([
        M["payer_enrollment"](tenant_id=tenant, payer_id=payers[0], clearinghouse=clearinghouse,
                              transaction="270", status="not-required"),
        M["payer_enrollment"](tenant_id=tenant, payer_id=payers[0], clearinghouse=clearinghouse,
                              transaction="837P", status="approved",
                              practitioner_id=rivera.id,
                              submitted_at=datetime(2026, 10, 1, 15, tzinfo=UTC),
                              approved_at=datetime(2026, 10, 20, 15, tzinfo=UTC)),
    ])
    db.commit()
    out = {
        "tenant": tenant, "user": ctx["user"].id, "org": ctx["org"].id,
        "facilities": [main.id, north.id, closed.id], "main": main.id, "north": north.id,
        "providers": [rivera.id, lowe["practitioner"].id, retired["practitioner"].id],
        "rivera": rivera.id, "lowe": lowe["practitioner"].id,
        "types": [t.id for t in types], "schedules": [by_role.id, by_practitioner.id],
        "by_role": by_role.id, "rule": rule.id, "monday": monday.id, "room": ctx["room"].id,
        "practice_payers": [pp.id for pp in practice_payers],
    }
    db.close()
    return out


@pytest.fixture
def engines() -> Iterator[tuple[Engine, Engine]]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    app_engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(app_engine, "shri_app")
    yield admin, app_engine
    admin.dispose()
    app_engine.dispose()


@pytest.fixture
def world(engines: tuple[Engine, Engine]) -> dict[str, Any]:
    admin, app_engine = engines
    tag = uuid.uuid4().hex[:10]
    payers = [_payer(admin, f"Live {tag} Health Plan", f"H{tag}"),
              _payer(admin, f"Live {tag} Medicare 100%", f"M{tag}", payer_type="medicare"),
              _payer(admin, f"Live {tag} Retired Plan", f"R{tag}", active=False)]
    return {"tag": tag, "payers": payers,
            "a": _clinic(admin, app_engine, tag, payers[:2]),
            "b": _clinic(admin, app_engine, tag, payers[:1], clearinghouse="availity")}


@pytest.fixture
def client(world: dict[str, Any]) -> Iterator[Any]:
    """One app per test on the test database as shri_app. Only the sign-in is replaced: an ADM,
    a front-desk user and an MD in clinic A, and an ADM in clinic B, each assigned to all of
    their clinic's facilities."""
    def user(clinic: dict[str, Any], roles: set[str]) -> CurrentUser:
        return CurrentUser(id=clinic["user"], organization_id=clinic["tenant"],
                           roles=frozenset(roles), facility_ids=frozenset(clinic["facilities"]),
                           display_name="Live test user")

    users = {"adm": user(world["a"], {"ADM"}), "fd": user(world["a"], {"FD"}),
             "md": user(world["a"], {"MD"}), "adm-b": user(world["b"], {"ADM"})}
    app: FastAPI = create_app(Settings(environment="test", auth_mode="dev_header",
                                       database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")

    def signed_in(request: Request) -> CurrentUser:
        return users[request.headers[DEV_USER_HEADER]]

    app.dependency_overrides[current_user] = signed_in
    with TestClient(app, raise_server_exceptions=False) as test_client:
        def as_user(name: str) -> TestClient:
            test_client.headers[DEV_USER_HEADER] = name
            return test_client
        yield as_user
        assert test_client.portal is not None
        test_client.portal.call(app.state.db.dispose)


def _get(client: Any, user: str, path: str, **params: Any) -> dict[str, Any]:
    response = client(user).get(path, params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _walk(client: Any, user: str, path: str, limit: int, between: Any = None,
          **params: Any) -> list[str]:
    """Every ID of a list, page by page; `between()` runs after the first page."""
    ids: list[str] = []
    query: dict[str, Any] = {"limit": limit, **params}
    while True:
        body = _get(client, user, path, **query)
        assert len(body["items"]) <= limit
        ids += [item["id"] for item in body["items"]]
        if "nextCursor" not in body:
            return ids
        query["cursor"] = body["nextCursor"]
        if between is not None:
            between()
            between = None


def _ids(values: list[UUID]) -> set[str]:
    return {str(v) for v in values}


# ----------------------------------------------------------------------------------- clinics
@pytest.mark.parametrize("path, key", [
    ("/api/v1/facilities", "facilities"), ("/api/v1/providers", "providers"),
    ("/api/v1/appointment-types", "types"), ("/api/v1/provider-schedules", "schedules"),
    ("/api/v1/practice-payers", "practice_payers"),
])
def test_each_list_shows_only_its_clinics_rows(client: Any, world: dict[str, Any], path: str,
                                               key: str) -> None:
    mine = {i["id"] for i in _get(client, "adm", path)["items"]}
    theirs = {i["id"] for i in _get(client, "adm-b", path)["items"]}
    assert mine == _ids(world["a"][key])
    assert theirs == _ids(world["b"][key])
    assert not mine & theirs


def test_the_payer_directory_is_the_same_for_every_clinic(client: Any,
                                                          world: dict[str, Any]) -> None:
    tag = world["tag"]
    for user in ("adm", "fd", "adm-b"):
        names = [p["name"] for p in _get(client, user, "/api/v1/payers",
                                         payerName=f"Live {tag}")["items"]]
        assert names == [f"Live {tag} Health Plan", f"Live {tag} Medicare 100%",
                         f"Live {tag} Retired Plan"]


def test_a_facility_that_is_not_the_users_is_404(client: Any, world: dict[str, Any]) -> None:
    other = str(world["b"]["main"])
    for path in ("/api/v1/providers", "/api/v1/provider-schedules"):
        response = client("adm").get(path, params={"facilityId": other})
        assert response.status_code == 404, response.text
        assert response.json()["code"] == "not-found"
    assert client("md").get("/api/v1/providers",
                            params={"facilityId": other}).status_code == 403


def test_permissions(client: Any) -> None:
    for path in LISTS:
        assert client("md").get(path).status_code == 403
        assert client("fd").get(path).status_code == 403
    assert client("md").get("/api/v1/payers").status_code == 403


def test_two_clinics_enroll_with_the_same_payer(world: dict[str, Any],
                                                engines: tuple[Engine, Engine]) -> None:
    _, app_engine = engines
    db = open_session(app_engine, world["b"]["tenant"])
    try:
        db.add(M["payer_enrollment"](payer_id=world["payers"][0], clearinghouse="waystar",
                                     transaction="270", status="not-required"))
        db.commit()
    finally:
        db.rollback()
        db.close()


# ----------------------------------------------------------------------------------- children
def test_facilities_with_their_site(client: Any, world: dict[str, Any]) -> None:
    items = {f["id"]: f for f in _get(client, "adm", "/api/v1/facilities")["items"]}
    main = items[str(world["a"]["main"])]
    assert main["address"] == {"lines": ["200 Test Avenue"], "city": "Springfield",
                               "state": "IL", "postalCode": "62702", "country": "US"}
    assert main["phone"] == "+12175550110"
    assert (main["code"], main["timeZone"], main["placeOfServiceCode"],
            main["billingLocation"], main["active"]) == ("MAIN", "America/New_York", "11",
                                                         True, True)
    assert main["createdAt"].endswith("Z") and main["updatedAt"] >= main["createdAt"]
    assert "address" not in items[str(world["a"]["north"])]  # no address row
    assert [f["name"] for f in items.values()] == ["Closed office", "Main office",
                                                   "North office"]


def test_providers_with_their_child_rows(client: Any, world: dict[str, Any]) -> None:
    a = world["a"]
    items = {p["id"]: p for p in _get(client, "adm", "/api/v1/providers")["items"]}
    # By creation time, then ID: all three were made in one transaction, so by ID.
    assert list(items) == [str(i) for i in sorted(a["providers"])]
    rivera = items[str(a["rivera"])]
    assert rivera["name"] == {"family": "Rivera", "given": ["Elena"], "prefix": "Dr."}
    assert len(rivera["npi"]) == 10
    assert rivera["qualifications"] == [{
        "code": {"system": systems.V2_0360, "code": "MD"}, "licenseNumber": "TEST-LIC-0042",
        "state": "IL", "issuer": "Test Medical Board", "startDate": "2015-07-01"}]
    assert rivera["specialties"] == [{"system": systems.NUCC, "code": "2084N0400X",
                                      "display": "Neurology"}]
    assert rivera["facilityIds"] == [str(a["main"])]
    assert (rivera["phone"], rivera["email"]) == ("+12175550120", "elena.rivera@example.com")
    retired = items[str(a["providers"][2])]
    assert retired["active"] is False
    assert sorted(retired["facilityIds"]) == sorted([str(a["main"]), str(a["north"])])


def test_a_provider_without_an_active_role_at_a_facility_is_left_out(
        client: Any, world: dict[str, Any], engines: tuple[Engine, Engine]) -> None:
    """facilityIds has minItems 1 in the contract, so a provider with no active role at a
    facility isn't listed until the contract says how to show one (asked on the PR)."""
    _, app_engine = engines
    db = open_session(app_engine, world["a"]["tenant"])
    try:
        main = db.get(M["facility"], world["a"]["main"])
        lapsed = _provider(db, "Okoye", [main])
        lapsed["roles"][0].active = False
        unplaced = _provider(db, "Nakamura", [])
        db.add(M["practitioner_role"](practitioner_id=unplaced["practitioner"].id))
        db.commit()
        hidden = {str(lapsed["practitioner"].id), str(unplaced["practitioner"].id)}
    finally:
        db.close()
    listed = {p["id"] for p in _get(client, "adm", "/api/v1/providers", limit=100)["items"]}
    assert listed == {str(i) for i in world["a"]["providers"]} and not listed & hidden


def test_provider_schedules_with_rules_and_exceptions(client: Any,
                                                      world: dict[str, Any]) -> None:
    a = world["a"]
    items = {s["id"]: s for s in _get(client, "adm", "/api/v1/provider-schedules")["items"]}
    by_role = items[str(a["by_role"])]
    assert (by_role["providerId"], by_role["facilityId"]) == (str(a["rivera"]), str(a["main"]))
    assert by_role["comment"] == "Mornings only"
    monday, tuesday = by_role["availabilityRules"]  # by day of the week
    assert monday == {"id": str(a["monday"]), "dayOfWeek": "mon", "startTime": "09:00",
                      "endTime": "11:00", "slotMinutes": 15, "appointmentTypeIds": [],
                      "startDate": "2026-11-01", "endDate": "2026-12-31"}
    assert tuesday["id"] == str(a["rule"]) and tuesday["locationId"] == str(a["room"])
    assert sorted(tuesday["appointmentTypeIds"]) == sorted(str(t) for t in a["types"][:2])
    assert [{k: v for k, v in e.items() if k != "id"} for e in by_role["exceptions"]] == [
        {"startAt": "2026-11-24T14:00:00Z", "endAt": "2026-11-24T18:00:00Z",
         "available": False, "reason": "Conference"}]
    by_practitioner = items[str(a["schedules"][1])]
    assert by_practitioner["providerId"] == str(a["lowe"])
    assert by_practitioner["availabilityRules"] == [] and by_practitioner["exceptions"] == []


def test_payers_and_practice_payers_with_their_child_rows(client: Any,
                                                         world: dict[str, Any]) -> None:
    tag = world["tag"]
    plan = _get(client, "fd", "/api/v1/payers", externalPayerId=f"H{tag}")["items"]
    assert [p["id"] for p in plan] == [str(world["payers"][0])]
    assert plan[0]["clearinghouseIds"] == [{"clearinghouse": "waystar",
                                            "externalPayerId": f"H{tag}"}]
    assert (plan[0]["payerType"], plan[0]["supportsEra"], plan[0]["active"]) == (
        "commercial", False, True)
    items = _get(client, "adm", "/api/v1/practice-payers")["items"]
    assert [p["payer"]["name"] for p in items] == [f"Live {tag} Health Plan",
                                                   f"Live {tag} Medicare 100%"]
    health = items[0]
    assert health["payerId"] == str(world["payers"][0]) and health["active"] is True
    assert health["enrollments"] == [
        {"transaction": "270", "clearinghouse": "waystar", "status": "not-required"},
        {"transaction": "837P", "clearinghouse": "waystar",
         "providerId": str(world["a"]["rivera"]), "status": "approved",
         "submittedAt": "2026-10-01T15:00:00Z", "approvedAt": "2026-10-20T15:00:00Z"}]
    assert items[1]["enrollments"] == [] and items[1]["active"] is False


# ----------------------------------------------------------------------------------- filters
def test_filters_on_the_real_queries(client: Any, world: dict[str, Any]) -> None:
    a, tag = world["a"], world["tag"]

    def ids(path: str, user: str = "adm", **params: Any) -> list[str]:
        return [i["id"] for i in _get(client, user, path, **params)["items"]]

    assert set(ids("/api/v1/facilities", active="false")) == {str(a["facilities"][2])}
    assert set(ids("/api/v1/providers", active="true")) == _ids(a["providers"][:2])
    assert set(ids("/api/v1/providers", facilityId=str(a["north"]))) == _ids(
        [a["lowe"], a["providers"][2]])
    assert ids("/api/v1/providers", facilityId=str(a["north"]), active="true") == [
        str(a["lowe"])]
    assert set(ids("/api/v1/appointment-types", active="false")) == {str(a["types"][2])}
    assert ids("/api/v1/provider-schedules", providerId=str(a["rivera"])) == [str(a["by_role"])]
    assert ids("/api/v1/provider-schedules", facilityId=str(a["north"]),
               active="true") == []
    assert ids("/api/v1/practice-payers", active="true") == [str(a["practice_payers"][0])]
    payers = world["payers"]
    assert ids("/api/v1/payers", "fd", payerName=f"{tag} medicare 100%") == [str(payers[1])]
    assert ids("/api/v1/payers", "fd", payerName=f"{tag}%Plan") == []  # % is literal
    assert ids("/api/v1/payers", "fd", payerName=f"Live {tag}", payerType="medicare") == [
        str(payers[1])]
    assert ids("/api/v1/payers", "fd", payerName=f"Live {tag}", active="false") == [
        str(payers[2])]


# ----------------------------------------------------------------------------------- paging
@pytest.mark.parametrize("path", LISTS)
def test_keyset_paging_walks_every_row_once(client: Any, path: str) -> None:
    everything = [i["id"] for i in _get(client, "adm", path)["items"]]
    for limit in (1, 2):
        assert _walk(client, "adm", path, limit) == everything


def test_payer_paging_walks_every_row_once(client: Any, world: dict[str, Any]) -> None:
    name = f"Live {world['tag']}"
    assert _walk(client, "fd", "/api/v1/payers", 1, payerName=name) == [
        str(p) for p in world["payers"][:2]] + [str(world["payers"][2])]


def test_facility_paging_is_stable_when_rows_are_inserted(
        client: Any, world: dict[str, Any], engines: tuple[Engine, Engine]) -> None:
    _, app_engine = engines
    a = world["a"]
    added: dict[str, UUID] = {}

    def insert() -> None:
        db = open_session(app_engine, a["tenant"])
        added["before"] = _site(db, "Aardvark office", "AARD", a["org"]).id  # sorts first
        added["after"] = _site(db, "Zebra office", "ZEBRA", a["org"]).id  # sorts last
        db.commit()
        db.close()

    seen = _walk(client, "adm", "/api/v1/facilities", 1, between=insert)
    assert len(seen) == len(set(seen))
    assert seen == [str(i) for i in (a["facilities"][2], a["main"], a["north"], added["after"])]
    assert str(added["before"]) not in seen  # behind the cursor: not seen, nothing shifted


def test_provider_paging_is_stable_when_rows_are_inserted(
        client: Any, world: dict[str, Any], engines: tuple[Engine, Engine]) -> None:
    _, app_engine = engines
    a = world["a"]
    added: dict[str, UUID] = {}

    def insert() -> None:
        db = open_session(app_engine, a["tenant"])
        main = db.get(M["facility"], a["main"])
        added["new"] = _provider(db, "Newcomer", [main])["practitioner"].id
        db.commit()
        db.close()

    seen = _walk(client, "adm", "/api/v1/providers", 2, between=insert)
    assert seen == [str(i) for i in sorted(a["providers"])] + [str(added["new"])]
