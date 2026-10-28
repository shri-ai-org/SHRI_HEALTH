"""Live fixtures for the scheduling API: per test, a fresh clinic A with a small practice (two
facilities, a room, a provider with a schedule, visit types) and synthetic patients, plus a clinic
B, and an app on the test database as shri_app where only the sign-in is replaced. The users'
facilities are the new facility A1 (A2 is someone else's), so the facility rules are real.
Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import DEV_USER_HEADER, DEV_USERS, CurrentUser, current_user
from app.db.models import MAPPERS, systems
from app.db.tests import builders as b
from app.db.tests.conftest import (
    TEST_DATABASE_URL,
    _role_search_path_sql,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)
from app.main import create_app

M = MAPPERS
ZONE = "America/Chicago"
SIGNS_IN_AS = ("fd", "ma", "md", "adm", "dsp", "none", "md-b", "fd-b")
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def demo_day() -> dt.date:
    """A Monday at least a week ahead, so every slot is in the future."""
    today = dt.datetime.now(ZoneInfo(ZONE)).date()
    ahead = today + dt.timedelta(days=7)
    return ahead + dt.timedelta(days=(7 - ahead.weekday()) % 7)


def local(day: dt.date, hour: int, minute: int = 0) -> str:
    """An ISO timestamp for a Chicago wall-clock time on the day."""
    return dt.datetime.combine(day, dt.time(hour, minute), ZoneInfo(ZONE)).isoformat()


@dataclass
class Practice:
    clinic: UUID
    clinic_b: UUID
    facility: UUID  # A1: the users' facility
    other_facility: UUID  # A2: in the same clinic, nobody's here
    facility_b: UUID
    room: UUID
    provider: UUID
    other_provider: UUID  # works only at A2
    types: dict[str, UUID]
    patients: dict[str, UUID] = field(default_factory=dict)
    day: dt.date = field(default_factory=demo_day)


def _site(db: Session, tenant: UUID, org: Any, code: str, name: str) -> tuple[Any, Any]:
    site = M["location"](tenant_id=tenant, name=name,
                         physical_type_system=systems.LOCATION_PHYSICAL_TYPE,
                         physical_type_code="si", managing_organization_id=org.id)
    db.add(site)
    db.flush()
    fac = M["facility"](tenant_id=tenant, location_id=site.id, code=code, name=name,
                        timezone=ZONE)
    db.add(fac)
    db.flush()
    return site, fac


def _provider(db: Session, tenant: UUID, org: Any, site: Any, family: str, given: str
              ) -> tuple[UUID, Any]:
    made = b.practitioner(db, family, given)
    role = M["practitioner_role"](tenant_id=tenant, practitioner_id=made["practitioner"].id,
                                  organization_id=org.id)
    role.location = [M["practitioner_role_location"](location_id=site.id)]
    db.add(role)
    db.flush()
    return made["practitioner"].id, role


def _schedule(db: Session, tenant: UUID, facility: Any, role: Any, site: Any) -> None:
    sch = M["schedule"](tenant_id=tenant, ext_facility_id=facility.id)
    sch.actor = [M["schedule_actor"](practitioner_role_id=role.id)]
    db.add(sch)
    db.flush()
    for day in DAYS:
        db.add(M["schedule_availability_rule"](
            tenant_id=tenant, schedule_id=sch.id, day_of_week=day, start_time=dt.time(9),
            end_time=dt.time(17), slot_minutes=20, location_id=site.id,
            effective_from=dt.date(2026, 1, 1)))
    db.flush()


def setup_session(admin: Engine, tenant: UUID) -> Session:
    """A superuser session pinned to one clinic, with the app's search_path, so the database's
    triggers (which name tables unqualified) resolve as they do for the API."""
    db = open_session(admin, tenant)
    db.execute(text(_role_search_path_sql("shri_app")))
    return db


def build_practice(admin: Engine) -> Practice:
    clinic, clinic_b = make_tenant(admin), make_tenant(admin)
    db = setup_session(admin, clinic)
    try:
        org = M["organization"](tenant_id=clinic, name="Riverbend test practice (synthetic)",
                                type_system=systems.ORGANIZATION_TYPE, type_code="prov")
        db.add(org)
        db.flush()
        site, fac = _site(db, clinic, org, "MAIN", "Main office (synthetic)")
        site2, fac2 = _site(db, clinic, org, "NORTH", "North office (synthetic)")
        room = M["location"](tenant_id=clinic, name="Exam 1",
                             physical_type_system=systems.LOCATION_PHYSICAL_TYPE,
                             physical_type_code="ro", part_of_location_id=site.id)
        db.add(room)
        db.flush()
        provider, role = _provider(db, clinic, org, site, "Lindqvist58", "Avery401")
        _schedule(db, clinic, fac, role, site)
        other, role2 = _provider(db, clinic, org, site2, "Okonkwo73", "Jordan552")
        _schedule(db, clinic, fac2, role2, site2)
        types = {}
        for code, name, minutes, overbook in (("FU", "Follow-up visit", 20, 0),
                                              ("NEW", "New patient visit", 40, 0),
                                              ("OB", "Overbook-friendly visit", 20, 1)):
            row = M["appointment_type"](tenant_id=clinic, code=code, name=name,
                                        default_duration_minutes=minutes, max_overbook=overbook)
            db.add(row)
            db.flush()
            types[code] = row.id
        patients = {}
        for key, family, given in (("kaia", "Lindgren118", "Kaia401"),
                                   ("marcus", "Okafor904", "Marcus217"),
                                   ("restricted", "Vasquez512", "Elena88")):
            patients[key] = b.patient(db, family, given).id
        db.execute(text("UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :p"),
                   {"p": patients["restricted"]})
        ids = (fac.id, fac2.id, room.id)  # before the commit expires the rows
        db.commit()
    finally:
        db.close()
    db = setup_session(admin, clinic_b)
    try:
        org_b = M["organization"](tenant_id=clinic_b, name="Northgate test clinic (synthetic)",
                                  type_system=systems.ORGANIZATION_TYPE, type_code="prov")
        db.add(org_b)
        db.flush()
        _, fac_b = _site(db, clinic_b, org_b, "MAIN", "Northgate office (synthetic)")
        facility_b = fac_b.id
        db.commit()
    finally:
        db.close()
    return Practice(clinic, clinic_b, ids[0], ids[1], facility_b, ids[2], provider, other,
                    types, patients)


@pytest.fixture
def practice() -> Iterator[Practice]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        yield build_practice(admin)
    finally:
        admin.dispose()


@pytest.fixture
def users(practice: Practice) -> dict[str, CurrentUser]:
    """A real user per dev user name, with that dev user's roles, at facility A1. md-b, and
    fd-b (the front desk's roles), are in clinic B."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    signed: dict[str, CurrentUser] = {}
    try:
        for name in SIGNS_IN_AS:
            clinic_b = name.endswith("-b")
            dev = DEV_USERS["fd" if name == "fd-b" else name]
            tenant = practice.clinic_b if clinic_b else practice.clinic
            db = setup_session(admin, tenant)
            user = M["app_user"](tenant_id=tenant, keycloak_subject=str(uuid.uuid4()),
                                 username=f"{name}.{uuid.uuid4().hex[:8]}",
                                 display_name=dev.display_name)
            db.add(user)
            db.flush()
            user_id = user.id
            db.commit()
            signed[name] = CurrentUser(
                id=user_id, organization_id=tenant, roles=dev.roles,
                facility_ids=frozenset({practice.facility_b if clinic_b else practice.facility}),
                display_name=dev.display_name)
            db.close()
    finally:
        admin.dispose()
    return signed


@pytest.fixture
def client(users: dict[str, CurrentUser]) -> Iterator[Any]:
    """One app and TestClient per test, as shri_app; X-Dev-User names one of ``users``."""
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
