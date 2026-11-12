"""Creating a provider and a provider schedule (createProvider, createProviderSchedule) against a
live database, as shri_app, with nothing replaced but the sign-in: core's tenant_db (row-level
security, audit) and the real repository. Each test gets two fresh clinics. The two rules the
service checks under a lock (one NPI per practice, no overlapping rules for a provider at a
facility) are also tried with two requests at once. Runs where ``TEST_DATABASE_URL`` is set.
Synthetic data only.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import DEV_USER_HEADER, CurrentUser, current_user
from app.core.errors import ValidationFailed
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
from app.modules.practice_setup import schemas, service
from app.modules.practice_setup.repository import SqlProviderRepository

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
M = b.M
CO_TAXONOMY = "http://nucc.org/provider-taxonomy"


@pytest.fixture
def engines() -> Iterator[tuple[Engine, Engine]]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    app_engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(app_engine, "shri_app")
    yield admin, app_engine
    admin.dispose()
    app_engine.dispose()


def _clinic(admin: Engine, app_engine: Engine) -> dict[str, Any]:
    """A practice with its user, "Main office" (site and exam room) and one visit type."""
    tenant = make_tenant(admin)
    db = open_session(app_engine, tenant)
    ctx = b.practice(db)
    visit = M["appointment_type"](code="FU", name="Follow-up", default_duration_minutes=20)
    db.add(visit)
    db.commit()
    out = {"tenant": tenant, "user": ctx["user"].id, "facility": ctx["facility"].id,
           "site": ctx["site"].id, "room": ctx["room"].id, "visit": visit.id,
           "builder_provider": ctx["practitioner"].id}
    conn = db.bind
    db.close()
    conn.close()  # type: ignore[union-attr]
    return out


@pytest.fixture
def clinics(engines: tuple[Engine, Engine]) -> dict[str, dict[str, Any]]:
    admin, app_engine = engines
    return {"a": _clinic(admin, app_engine), "b": _clinic(admin, app_engine)}


def _user(clinic: dict[str, Any], roles: set[str]) -> CurrentUser:
    return CurrentUser(id=clinic["user"], organization_id=clinic["tenant"],
                       roles=frozenset(roles), facility_ids=frozenset({clinic["facility"]}),
                       display_name="Live test user")


@pytest.fixture
def app(clinics: dict[str, dict[str, Any]]) -> Iterator[FastAPI]:
    a, other = clinics["a"], clinics["b"]
    users = {"adm": _user(a, {"ADM"}), "fd": _user(a, {"FD"}), "co": _user(a, {"CO"}),
             "adm-b": _user(other, {"ADM"})}
    application = create_app(Settings(environment="test", auth_mode="dev_header",
                                      database_url=TEST_DATABASE_URL))
    switch_to_role(application.state.db.engine.sync_engine, "shri_app")

    def signed_in(request: Request) -> CurrentUser:
        return users[request.headers[DEV_USER_HEADER]]

    application.dependency_overrides[current_user] = signed_in
    yield application


@pytest.fixture
def client(app: FastAPI) -> Iterator[Any]:
    with TestClient(app, raise_server_exceptions=False) as test_client:
        def as_user(name: str) -> TestClient:
            test_client.headers[DEV_USER_HEADER] = name
            return test_client
        as_user.portal = test_client.portal  # type: ignore[attr-defined]
        yield as_user
        assert test_client.portal is not None
        test_client.portal.call(app.state.db.dispose)


def _provider(clinic: dict[str, Any], npi: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"name": {"family": "Lindgren118", "given": ["Kaia401"], "prefix": "Dr."},
            "npi": npi or b.npi(), "facilityIds": [str(clinic["facility"])], **extra}


def _rule(day: str = "mon", start: str = "09:00", end: str = "12:00", **extra: Any
          ) -> dict[str, Any]:
    return {"dayOfWeek": day, "startTime": start, "endTime": end, "slotMinutes": 20,
            "startDate": "2026-12-01", **extra}


def _schedule(clinic: dict[str, Any], provider_id: str, rules: list[dict[str, Any]],
              **extra: Any) -> dict[str, Any]:
    return {"providerId": provider_id, "facilityId": str(clinic["facility"]),
            "availabilityRules": rules, **extra}


def _errors(response: Any) -> set[tuple[str, str]]:
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "business-rule-violation", response.text
    return {(e["pointer"], e["code"]) for e in response.json()["errors"]}


def _new_provider(client: Any, clinic: dict[str, Any]) -> str:
    made = client("adm").post("/api/v1/providers", json=_provider(clinic))
    assert made.status_code == 201, made.text
    provider_id: str = made.json()["id"]
    return provider_id


# ------------------------------------------------------------------------------- providers
def test_create_a_provider_and_read_it_back(client: Any, clinics: dict[str, Any],
                                            engines: tuple[Engine, Engine]) -> None:
    a = clinics["a"]
    body = _provider(a, gender="female", phone="+12175550142", email="kaia@example.test",
                     specialties=[{"system": CO_TAXONOMY, "code": "207Q00000X",
                                   "display": "Family Medicine"}],
                     qualifications=[{"code": {"system": "http://terminology.hl7.org/"
                                               "CodeSystem/v2-0360", "code": "MD"},
                                      "licenseNumber": "TEST-12345", "state": "IL",
                                      "startDate": "2020-01-01"}])
    made = client("adm").post("/api/v1/providers", json=body)
    assert made.status_code == 201, made.text
    got = made.json()
    assert made.headers["Location"] == f"/api/v1/providers/{got['id']}"
    assert made.headers["ETag"].strip('"').isdigit()
    assert got["name"] == body["name"] and got["npi"] == body["npi"]
    assert got["facilityIds"] == [str(a["facility"])] and got["active"] is True
    assert (got["gender"], got["phone"], got["email"]) == (
        "female", "+12175550142", "kaia@example.test")
    assert got["specialties"] == body["specialties"]
    assert got["qualifications"] == body["qualifications"]
    listed = client("adm").get("/api/v1/providers").json()["items"]
    assert got in listed
    with engines[0].connect() as c:
        roles = c.execute(text(
            "SELECT count(*) FROM clinical.practitioner_role WHERE practitioner_id = :p "
            "AND active AND organization_id IS NOT NULL"), {"p": got["id"]}).scalar_one()
        audited = c.execute(text(
            "SELECT count(*) FROM audit.audit_event WHERE tenant_id = :t "
            "AND entity_type = 'providers' AND category = 'admin'"),
            {"t": a["tenant"]}).scalar_one()
    assert roles == 1 and audited >= 1


def test_only_practice_admins_create_providers(client: Any, clinics: dict[str, Any]) -> None:
    for user in ("fd", "co"):
        refused = client(user).post("/api/v1/providers", json=_provider(clinics["a"]))
        assert refused.status_code == 403, refused.text


def test_a_provider_is_refused_for_a_bad_npi_or_another_facility(client: Any,
                                                                 clinics: dict[str, Any]
                                                                 ) -> None:
    a = clinics["a"]
    assert _errors(client("adm").post("/api/v1/providers", json=_provider(
        a, npi="1234567890"))) == {("/npi", "invalid-format")}        # check digit
    elsewhere = _provider(a, facilityIds=[str(a["facility"]), str(uuid.uuid4())])
    assert _errors(client("adm").post("/api/v1/providers", json=elsewhere)) == {
        ("/facilityIds/1", "invalid-reference")}
    missing = client("adm").post("/api/v1/providers", json={"npi": b.npi()})
    assert missing.status_code == 422 and missing.json()["code"] == "validation-failed"


def test_one_npi_per_practice(client: Any, clinics: dict[str, Any]) -> None:
    a, other = clinics["a"], clinics["b"]
    npi = b.npi()
    assert client("adm").post("/api/v1/providers", json=_provider(a, npi)).status_code == 201
    assert _errors(client("adm").post("/api/v1/providers", json=_provider(a, npi))) == {
        ("/npi", "not-allowed-value")}
    # another practice may hold the same NPI: row-level security keeps them apart
    assert client("adm-b").post("/api/v1/providers",
                                json=_provider(other, npi)).status_code == 201


def test_the_builders_provider_npi_is_taken_too(client: Any, clinics: dict[str, Any],
                                                engines: tuple[Engine, Engine]) -> None:
    a = clinics["a"]
    with engines[0].connect() as c:
        npi = c.execute(text("SELECT value FROM clinical.identifier WHERE practitioner_id = :p "
                             "AND system = :s"),
                        {"p": a["builder_provider"], "s": systems.NPI}).scalar_one()
    assert _errors(client("adm").post("/api/v1/providers", json=_provider(a, npi))) == {
        ("/npi", "not-allowed-value")}


def _at_once(app: FastAPI, client: Any, clinic: dict[str, Any], attempt: Any) -> list[str]:
    """Two attempts in two sessions of the API's own database at the same time."""
    user = _user(clinic, {"ADM", "FD"})

    async def one() -> str:
        async with app.state.db.tenant_session(clinic["tenant"], clinic["user"]) as db:
            try:
                await attempt(db, user)
            except ValidationFailed:
                return "refused"
            await db.commit()
            return "created"

    async def both() -> list[str]:
        return list(await asyncio.gather(one(), one()))

    found: list[str] = client.portal.call(both)
    return sorted(found)


def test_two_requests_with_one_npi_at_once_create_one_provider(
        app: FastAPI, client: Any, clinics: dict[str, Any],
        engines: tuple[Engine, Engine]) -> None:
    a = clinics["a"]
    body = schemas.ProviderCreate.model_validate(_provider(a))

    async def attempt(db: Any, user: CurrentUser) -> None:
        await service.create_provider(db, SqlProviderRepository(), user, body)

    assert _at_once(app, client, a, attempt) == ["created", "refused"]
    with engines[0].connect() as c:
        assert c.execute(text("SELECT count(*) FROM clinical.identifier WHERE tenant_id = :t "
                              "AND system = :s AND value = :v"),
                         {"t": a["tenant"], "s": systems.NPI, "v": body.npi}).scalar_one() == 1


# ------------------------------------------------------------------------------- schedules
def test_create_a_schedule_and_read_it_back(client: Any, clinics: dict[str, Any]) -> None:
    a = clinics["a"]
    provider = _new_provider(client, a)
    body = _schedule(a, provider, [
        _rule("mon", "09:00", "12:00", locationId=str(a["room"]),
              appointmentTypeIds=[str(a["visit"])]),
        _rule("mon", "12:00", "17:00", endDate="2027-06-30"),       # touching is not overlapping
        _rule("tue", "09:00", "17:00")],
        exceptions=[{"startAt": "2026-12-24T09:00:00-05:00", "endAt": "2026-12-24T17:00:00-05:00",
                     "available": False, "reason": "Holiday"}],
        comment="Main office hours")
    made = client("fd").post("/api/v1/provider-schedules", json=body)       # FD may (D66)
    assert made.status_code == 201, made.text
    got = made.json()
    assert made.headers["Location"] == f"/api/v1/provider-schedules/{got['id']}"
    assert (got["providerId"], got["facilityId"], got["comment"], got["active"]) == (
        provider, str(a["facility"]), "Main office hours", True)
    assert [(r["dayOfWeek"], r["startTime"], r["endTime"]) for r in got["availabilityRules"]] == [
        ("mon", "09:00", "12:00"), ("mon", "12:00", "17:00"), ("tue", "09:00", "17:00")]
    first = got["availabilityRules"][0]
    assert first["locationId"] == str(a["room"]) and first["appointmentTypeIds"] == [
        str(a["visit"])]
    assert got["availabilityRules"][1]["endDate"] == "2027-06-30"
    assert got["exceptions"][0]["startAt"] == "2026-12-24T14:00:00Z"
    listed = client("adm").get("/api/v1/provider-schedules",
                               params={"providerId": provider}).json()["items"]
    assert listed == [got]


def test_only_the_front_desk_and_admins_create_schedules(client: Any,
                                                         clinics: dict[str, Any]) -> None:
    a = clinics["a"]
    provider = _new_provider(client, a)
    refused = client("co").post("/api/v1/provider-schedules", json=_schedule(a, provider, []))
    assert refused.status_code == 403, refused.text


def test_overlapping_rules_are_refused(client: Any, clinics: dict[str, Any]) -> None:
    a = clinics["a"]
    provider = _new_provider(client, a)
    inside = _schedule(a, provider, [_rule("mon", "09:00", "12:00"),
                                     _rule("mon", "11:00", "13:00"),
                                     _rule("wed", "09:00", "12:00")])
    assert _errors(client("fd").post("/api/v1/provider-schedules", json=inside)) == {
        ("/availabilityRules/0", "conflicting-fields"),
        ("/availabilityRules/1", "conflicting-fields")}
    first = client("fd").post("/api/v1/provider-schedules",
                              json=_schedule(a, provider, [_rule("mon", "09:00", "12:00")]))
    assert first.status_code == 201, first.text
    # a second schedule for the provider at the facility may not overlap the first one's rules,
    # but rules on other dates or other days are fine
    clash = _schedule(a, provider, [_rule("mon", "10:00", "11:00"),
                                    _rule("mon", "10:00", "11:00", startDate="2026-01-05",
                                          endDate="2026-06-30"),
                                    _rule("thu", "10:00", "11:00")])
    assert _errors(client("fd").post("/api/v1/provider-schedules", json=clash)) == {
        ("/availabilityRules/0", "conflicting-fields")}


def test_a_schedule_is_refused_for_bad_times_or_references(client: Any,
                                                           clinics: dict[str, Any]) -> None:
    a = clinics["a"]
    provider = _new_provider(client, a)
    times = _schedule(a, provider, [_rule("mon", "12:00", "09:00"),
                                    _rule("tue", startDate="2027-01-01", endDate="2026-12-31")],
                      exceptions=[{"startAt": "2026-12-24T17:00:00Z",
                                   "endAt": "2026-12-24T09:00:00Z", "available": False}])
    assert _errors(client("fd").post("/api/v1/provider-schedules", json=times)) == {
        ("/availabilityRules/0/endTime", "out-of-range"),
        ("/availabilityRules/1/endDate", "out-of-range"),
        ("/exceptions/0/endAt", "out-of-range")}
    references = _schedule(a, provider, [_rule(locationId=str(uuid.uuid4()),
                                               appointmentTypeIds=[str(uuid.uuid4())])])
    assert _errors(client("fd").post("/api/v1/provider-schedules", json=references)) == {
        ("/availabilityRules/0/locationId", "invalid-reference"),
        ("/availabilityRules/0/appointmentTypeIds/0", "invalid-reference")}
    # the builder's provider has no role at the facility; an unknown one isn't visible at all
    for who in (a["builder_provider"], uuid.uuid4()):
        assert _errors(client("fd").post("/api/v1/provider-schedules", json=_schedule(
            a, str(who), [_rule()]))) == {("/providerId", "invalid-reference")}
    elsewhere = {**_schedule(a, provider, [_rule()]), "facilityId": str(uuid.uuid4())}
    assert _errors(client("fd").post("/api/v1/provider-schedules", json=elsewhere)) == {
        ("/facilityId", "invalid-reference")}


def _booked(engines: tuple[Engine, Engine], clinic: dict[str, Any], provider_id: str,
            start: datetime, status: str = "booked") -> None:
    """An appointment of the provider at the clinic's facility, written as the API would."""
    db = open_session(engines[1], clinic["tenant"])
    pt = b.patient(db)
    appt = M["appointment"](status=status, start=start, end=start + timedelta(minutes=20),
                            minutes_duration=20, subject_patient_id=pt.id,
                            ext_appointment_type_id=clinic["visit"],
                            ext_facility_id=clinic["facility"])
    appt.participant = [M["appointment_participant"](actor_patient_id=pt.id, status="accepted"),
                        M["appointment_participant"](actor_practitioner_id=provider_id,
                                                     status="accepted")]
    db.add(appt)
    db.commit()
    conn = db.bind
    db.close()
    conn.close()  # type: ignore[union-attr]


def test_time_off_may_not_cover_a_booked_visit(client: Any, clinics: dict[str, Any],
                                               engines: tuple[Engine, Engine]) -> None:
    """Vimal's #276 review: an exception that isn't available is refused when it covers the
    provider's booked, arrived or checked-in appointment at the facility, and the problem gives
    only how many; a no-show, extra hours or another day don't count."""
    a = clinics["a"]
    provider = _new_provider(client, a)
    first = client("fd").post("/api/v1/provider-schedules", json=_schedule(a, provider, [_rule()]))
    assert first.status_code == 201, first.text
    visit = datetime(2026, 12, 7, 15, 0, tzinfo=UTC)
    _booked(engines, a, provider, visit)
    _booked(engines, a, provider, visit + timedelta(hours=1), status="arrived")
    _booked(engines, a, provider, visit + timedelta(hours=2), status="noshow")
    off = [{"startAt": "2026-12-07T14:00:00Z", "endAt": "2026-12-07T18:00:00Z",
            "available": False},
           {"startAt": "2026-12-08T14:00:00Z", "endAt": "2026-12-08T18:00:00Z",
            "available": False},
           {"startAt": "2026-12-07T14:00:00Z", "endAt": "2026-12-07T18:00:00Z",
            "available": True}]
    refused = client("fd").post("/api/v1/provider-schedules",
                                json=_schedule(a, provider, [_rule("tue")], exceptions=off))
    assert _errors(refused) == {("/exceptions/0", "conflicting-fields")}
    assert "covers 2 booked appointments" in refused.json()["detail"]
    assert "Nguyen" not in refused.text and "Mai" not in refused.text   # no patient data
    with engines[0].connect() as c:
        schedules = c.execute(text(
            "SELECT count(*) FROM clinical.schedule WHERE tenant_id = :t"),
            {"t": a["tenant"]}).scalar_one()
    assert schedules == 1                                                # nothing written
    made = client("fd").post("/api/v1/provider-schedules",
                             json=_schedule(a, provider, [_rule("tue")], exceptions=off[1:]))
    assert made.status_code == 201, made.text


def test_another_clinics_provider_is_not_found(client: Any, clinics: dict[str, Any]) -> None:
    a, other = clinics["a"], clinics["b"]
    theirs = client("adm-b").post("/api/v1/providers", json=_provider(other))
    assert theirs.status_code == 201, theirs.text
    assert _errors(client("fd").post("/api/v1/provider-schedules", json=_schedule(
        a, theirs.json()["id"], [_rule()]))) == {("/providerId", "invalid-reference")}


def test_two_overlapping_schedules_at_once_create_one(app: FastAPI, client: Any,
                                                      clinics: dict[str, Any],
                                                      engines: tuple[Engine, Engine]) -> None:
    a = clinics["a"]
    provider = _new_provider(client, a)
    body = schemas.ProviderScheduleCreate.model_validate(
        _schedule(a, provider, [_rule("fri", "08:00", "16:00")]))

    async def attempt(db: Any, user: CurrentUser) -> None:
        await service.create_provider_schedule(db, SqlProviderRepository(), user, body)

    assert _at_once(app, client, a, attempt) == ["created", "refused"]
    with engines[0].connect() as c:
        assert c.execute(text(
            "SELECT count(*) FROM clinical.schedule s JOIN clinical.schedule_actor sa "
            "ON sa.schedule_id = s.id JOIN clinical.practitioner_role r "
            "ON r.id = sa.practitioner_role_id WHERE r.practitioner_id = :p"),
            {"p": provider}).scalar_one() == 1
