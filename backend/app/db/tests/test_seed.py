"""The starter setup data (app.db.seed): loaded as shri_migrator, re-runnable, and readable by
core's dev users through the API role."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS, FACILITY_A, FACILITY_B
from app.core.session import _ROLES as CORE_ROLE_QUERY
from app.db.seed import starter
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, open_session, sync_url

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

COUNTED = ("admin.tenant", "clinical.organization", "clinical.location", "admin.facility",
           "admin.mrn_counter", "clinical.practitioner", "clinical.practitioner_role",
           "clinical.schedule", "admin.schedule_availability_rule",
           "admin.availability_rule_appointment_type", "admin.appointment_type", "admin.payer",
           "admin.practice_payer", "admin.note_template", "admin.note_template_section",
           "admin.app_user", "admin.user_role", "clinical.fhir_resource_history")


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """load_starter refuses anything but development and test (core's ENVIRONMENT)."""
    monkeypatch.setenv("ENVIRONMENT", "test")


@pytest.fixture(scope="module")
def migrator_engine() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)

    @event.listens_for(engine, "connect")
    def _as_migrator(dbapi_connection: object, _record: object) -> None:
        cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
        cursor.execute("SET ROLE shri_migrator")
        cursor.close()
        dbapi_connection.commit()  # type: ignore[attr-defined]

    yield engine
    engine.dispose()


def _seed(engine: Engine) -> None:
    with Session(engine) as db, db.begin():
        starter.load_starter(db)


def _snapshot(admin_engine: Engine) -> dict[str, tuple[Any, ...]]:
    """Per table: row count, the sum of every row's version (where it has one) and the latest
    updated_at (where it has one), so an update to a table without a version shows too."""
    out = {}
    with admin_engine.connect() as c:
        for table in COUNTED:
            schema, name = table.split(".")
            cols = set(c.execute(text("SELECT column_name FROM information_schema.columns "
                                      "WHERE table_schema = :s AND table_name = :n"),
                                 {"s": schema, "n": name}).scalars())
            version = ("meta_version_id" if "meta_version_id" in cols
                       else "version" if "version" in cols else "0")
            updated = "max(updated_at)" if "updated_at" in cols else "NULL"
            out[table] = tuple(c.execute(text(  # noqa: S608
                f"SELECT count(*), coalesce(sum({version}), 0), {updated} FROM {table}")).one())
    return out


def test_the_starter_layer_loads_and_a_second_run_changes_nothing(
        migrator_engine: Engine, admin_engine: Engine) -> None:
    _seed(migrator_engine)
    first = _snapshot(admin_engine)
    _seed(migrator_engine)
    assert _snapshot(admin_engine) == first


def test_the_dev_users_see_their_practice_through_the_api_role(
        migrator_engine: Engine, app_engine: Engine) -> None:
    _seed(migrator_engine)
    db = open_session(app_engine, CLINIC_A, DEV_USERS["fd"].id)
    try:
        def scalars(sql: str) -> list[Any]:
            return list(db.execute(text(sql)).scalars())

        assert set(scalars("SELECT id FROM admin.facility")) == {
            FACILITY_A, starter.sid(starter.FACILITY, 12)}
        assert sorted(scalars("SELECT timezone FROM admin.facility")) == [
            "America/Chicago", "America/New_York"]
        assert sorted(scalars("SELECT code FROM admin.appointment_type")) == [
            "ANNUAL", "FU", "NEW", "TELE-FU"]
        assert sorted(scalars("SELECT code FROM admin.note_template")) == [
            "ANNUAL", "FOLLOW-UP", "NEW-VISIT"]
        per_facility = 2 * len(starter.PROVIDERS)        # two facilities
        assert len(scalars("SELECT id FROM clinical.schedule")) == per_facility
        # One PractitionerRole per provider and facility; each schedule uses its facility's role.
        assert len(scalars("SELECT id FROM clinical.practitioner_role")) == per_facility
        assert scalars(
            "SELECT count(*) FROM clinical.schedule s JOIN admin.facility f ON f.id = "
            "s.ext_facility_id JOIN clinical.schedule_actor a ON a.schedule_id = s.id "
            "JOIN clinical.practitioner_role_location l ON l.practitioner_role_id = "
            "a.practitioner_role_id WHERE l.location_id = f.location_id") == [per_facility]
        assert set(scalars("SELECT id FROM admin.app_user")) >= {
            u.id for u in DEV_USERS.values() if u.organization_id == CLINIC_A}
        # Staff sign-in finds each dev user's roles and facilities as core has them.
        for user in DEV_USERS.values():
            if user.organization_id != CLINIC_A:
                continue
            found = db.execute(CORE_ROLE_QUERY, {"id": user.id}).all()
            assert {r.code for r in found} == user.roles, user.display_name
            assert {r.facility_id for r in found} <= user.facility_ids
        # Registration works at once: the counter exists, as onboarding creates it.
        mrn = db.execute(text("SELECT system, value FROM admin.next_mrn()")).one()
        assert mrn.system == starter.MRN_SYSTEM and mrn.value.startswith("RFM-")
        db.rollback()                                    # give the number back
    finally:
        conn = db.bind
        db.close()
        conn.close()  # type: ignore[union-attr]
    other = open_session(app_engine, CLINIC_B)
    try:
        assert list(other.execute(text("SELECT id FROM admin.facility")).scalars()) == [
            FACILITY_B]
    finally:
        conn = other.bind
        other.close()
        conn.close()  # type: ignore[union-attr]


def test_a_superuser_login_is_detected(admin_engine: Engine, migrator_engine: Engine) -> None:
    """The test URL is a superuser, which would skip RLS; shri_migrator does not."""
    from app.db.seed.__main__ import bypasses_rls
    with Session(admin_engine) as db:
        assert bypasses_rls(db)
    with Session(migrator_engine) as db:
        assert not bypasses_rls(db)


def test_facilities_have_a_synthetic_address(migrator_engine: Engine,
                                             admin_engine: Engine) -> None:
    _seed(migrator_engine)
    with admin_engine.connect() as c:
        rows = c.execute(text("SELECT f.name, a.line, a.city, a.state FROM admin.facility f "
                              "JOIN clinical.address a ON a.location_id = f.location_id "
                              "WHERE f.tenant_id IN (:a, :b)"),
                         {"a": CLINIC_A, "b": CLINIC_B}).all()
    assert len(rows) == 3
    assert all(r.name.endswith("(synthetic)") and "Sample Avenue" in r.line[0] for r in rows)
