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
from app.db.seed import starter
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, open_session, sync_url

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

COUNTED = ("admin.tenant", "clinical.organization", "clinical.location", "admin.facility",
           "admin.mrn_counter", "clinical.practitioner", "clinical.practitioner_role",
           "clinical.schedule", "admin.schedule_availability_rule",
           "admin.availability_rule_appointment_type", "admin.appointment_type", "admin.payer",
           "admin.practice_payer", "admin.note_template", "admin.note_template_section",
           "admin.app_user", "clinical.fhir_resource_history")


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


def _snapshot(admin_engine: Engine) -> dict[str, tuple[int, int]]:
    """Per table: row count, and the sum of every row's version (where it has one)."""
    out = {}
    with admin_engine.connect() as c:
        for table in COUNTED:
            schema, name = table.split(".")
            cols = set(c.execute(text("SELECT column_name FROM information_schema.columns "
                                      "WHERE table_schema = :s AND table_name = :n"),
                                 {"s": schema, "n": name}).scalars())
            version = ("meta_version_id" if "meta_version_id" in cols
                       else "version" if "version" in cols else "0")
            out[table] = tuple(c.execute(text(  # noqa: S608
                f"SELECT count(*), coalesce(sum({version}), 0) FROM {table}")).one())
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
        assert len(scalars("SELECT id FROM clinical.schedule")) == 4
        assert set(scalars("SELECT id FROM admin.app_user")) >= {
            u.id for u in DEV_USERS.values() if u.organization_id == CLINIC_A}
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


def test_the_seed_refuses_to_run_outside_development(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.db.seed.__main__ import main
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert main(["starter"]) == 1
    monkeypatch.setenv("ENVIRONMENT", "development")
    assert main(["unknown"]) == 2
