"""The demo layer (app.db.seed.demo): loaded as shri_migrator on top of the starter layer,
re-runnable, and what the demo screens read through the API role."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS
from app.db.seed import demo
from app.db.seed.starter import sid
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, open_session
from app.db.tests.test_seed import _snapshot, migrator_engine

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["migrator_engine"]       # a fixture, used by name

COUNTED = ("admin.pharmacy", "admin.payer", "admin.practice_payer", "admin.consent_requirement",
           "clinical.patient", "clinical.coverage", "clinical.appointment",
           "clinical.appointment_participant", "admin.patient_pharmacy", "clinical.identifier",
           "admin.mrn_counter")


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")


def _seed(engine: Engine) -> None:
    with Session(engine) as db, db.begin():
        demo.load_demo(db)


@pytest.fixture
def front_desk(app_engine: Engine) -> Iterator[Session]:
    db = open_session(app_engine, CLINIC_A, DEV_USERS["fd"].id)
    yield db
    conn = db.bind
    db.close()
    conn.close()  # type: ignore[union-attr]


def test_the_demo_layer_loads_and_a_second_run_changes_nothing(
        migrator_engine: Engine, admin_engine: Engine,
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.db.tests.test_seed.COUNTED", COUNTED)
    _seed(migrator_engine)
    first = _snapshot(admin_engine)
    _seed(migrator_engine)
    assert _snapshot(admin_engine) == first           # no MRN taken twice, no version moved


def test_the_front_desk_sees_the_demo_day(migrator_engine: Engine,
                                         front_desk: Session) -> None:
    _seed(migrator_engine)

    def rows(sql: str) -> list[Any]:
        return list(front_desk.execute(text(sql)))

    ours = {sid(demo.PATIENT, p.n) for p in demo.PATIENTS}
    assert ours <= {r.id for r in rows("SELECT id FROM clinical.patient")}
    mrns = [r.value for r in rows("SELECT patient_id, value FROM clinical.identifier "
                                  "WHERE type_code = 'MR'") if r.patient_id in ours]
    assert len(mrns) == len(ours) and all(m.startswith("RFM-") for m in mrns)
    day = rows("SELECT a.start, t.code FROM clinical.appointment a JOIN admin.appointment_type t "
               "ON t.id = a.ext_appointment_type_id WHERE a.start::date = '2026-11-20' "
               "ORDER BY a.start")
    assert [r.code for r in day] == ["NEW", "FU", "FU", "ANNUAL"]
    assert day[0].start.isoformat() == "2026-11-20T15:00:00+00:00"      # 9:00 in Chicago
    assert len(rows("SELECT 1 FROM clinical.coverage WHERE status = 'active'")) >= 4
    required = {r.kind for r in rows("SELECT kind FROM admin.consent_requirement "
                                     "WHERE is_required AND is_active")}
    assert required == {"treatment", "privacy-notice", "financial"}
    pharmacy = rows("SELECT p.name FROM admin.patient_pharmacy pp JOIN admin.pharmacy p "
                    "ON p.id = pp.pharmacy_id WHERE pp.is_default")
    assert {r.name for r in pharmacy} == {"Demo Pharmacy (synthetic)"}


def test_no_provider_is_double_booked(migrator_engine: Engine, front_desk: Session) -> None:
    """The exclusion constraint would refuse it, so loading at all proves it; this says why."""
    _seed(migrator_engine)
    blocking = front_desk.execute(text(
        "SELECT count(*) FROM clinical.appointment_participant WHERE ext_blocking")).scalar_one()
    assert blocking >= 4


def test_the_other_clinic_sees_no_demo_patient(migrator_engine: Engine,
                                               app_engine: Engine) -> None:
    _seed(migrator_engine)
    db = open_session(app_engine, CLINIC_B)
    try:
        ids = {r.id for r in db.execute(text("SELECT id FROM clinical.patient"))}
        assert not ids & {sid(demo.PATIENT, p.n) for p in demo.PATIENTS}
    finally:
        conn = db.bind
        db.close()
        conn.close()  # type: ignore[union-attr]
