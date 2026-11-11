"""The demo patients' clinical history (app.db.seed.history): loaded as shri_migrator through the
fhir_store helpers after the demo layer, re-runnable, and what the doctor's screens read back
through the API as the demo clinic's doctor. Synthetic data only."""
from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import CLINIC_A, DEV_USER_HEADER
from app.db.seed import demo, history
from app.db.seed.starter import sid
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, TEST_DATABASE_URL, sync_url
from app.db.tests.test_seed import migrator_engine
from app.main import create_app

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["migrator_engine"]       # a fixture, used by name

COUNTS = """
SELECT (SELECT count(*) FROM clinical.condition WHERE subject_patient_id = :p),
       (SELECT count(*) FROM clinical.allergy_intolerance WHERE patient_id = :p),
       (SELECT count(*) FROM clinical.medication_request WHERE subject_patient_id = :p),
       (SELECT count(*) FROM clinical.encounter WHERE subject_patient_id = :p
          AND status = 'finished'),
       (SELECT count(*) FROM clinical.observation WHERE subject_patient_id = :p),
       (SELECT count(*) FROM clinical.family_member_history WHERE patient_id = :p),
       (SELECT count(*) FROM clinical.procedure WHERE subject_patient_id = :p),
       (SELECT count(*) FROM clinical.composition WHERE subject_patient_id = :p
          AND status = 'final')
"""


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(demo, "POPULATION_SIZE", 5)


def _as_migrator() -> AsyncEngine:
    engine = create_async_engine(sync_url(), poolclass=NullPool)  # psycopg 3 does both

    @event.listens_for(engine.sync_engine, "connect")
    def _role(dbapi_connection: Any, _record: object) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("SET ROLE shri_migrator")
        cursor.close()
        dbapi_connection.commit()

    return engine


def _load() -> int:
    async def go() -> int:
        engine = _as_migrator()
        try:
            return await history.load_history(engine)
        finally:
            await engine.dispose()
    return asyncio.run(go())


@pytest.fixture
def seeded(migrator_engine: Engine) -> Iterator[None]:
    with Session(migrator_engine) as db, db.begin():
        demo.load_demo(db)
    _load()
    yield


def _counts(admin: Engine, n: int) -> tuple[int, ...]:
    with admin.connect() as c:
        return tuple(c.execute(text(COUNTS), {"p": sid(demo.PATIENT, n)}).one())


def test_each_demo_patient_gets_their_history_once(seeded: None,
                                                   admin_engine: Engine) -> None:
    #          problems, allergies, meds, past visits, observations, family, surgery, notes
    expected = {1: (0, 0, 0, 0, 0, 0, 0, 0),          # the demo visit's new patient
                2: (3, 1, 3, 2, 11, 2, 1, 2),
                3: (2, 1, 2, 1, 6, 1, 1, 1),
                4: (1, 0, 1, 1, 6, 0, 0, 1),
                5: (1, 1, 1, 1, 6, 1, 0, 1)}
    assert {n: _counts(admin_engine, n) for n in expected} == expected
    assert _load() == 0                                 # a second run changes nothing
    assert {n: _counts(admin_engine, n) for n in expected} == expected


def test_every_history_row_is_the_demo_clinics_and_the_doctors(seeded: None,
                                                               admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        notes = c.execute(text(
            "SELECT DISTINCT n.tenant_id, a.party_practitioner_id FROM clinical.composition n "
            "JOIN clinical.composition_attester a ON a.composition_id = n.id "
            "WHERE n.subject_patient_id = ANY(:ps)"),
            {"ps": [sid(demo.PATIENT, n) for n in history.HISTORY]}).all()
    assert notes == [(CLINIC_A, history.DOCTOR)]


def test_the_doctor_reads_it_through_the_api(seeded: None) -> None:
    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              database_url=TEST_DATABASE_URL))
    marcus = sid(demo.PATIENT, 2)
    with TestClient(app) as client:
        client.headers[DEV_USER_HEADER] = "md"
        visits = client.get(f"/api/v1/patients/{marcus}/encounters")
        vitals = client.get(f"/api/v1/patients/{marcus}/vitals")
        meds = client.get(f"/api/v1/patients/{marcus}/medications")
        allergies = client.get(f"/api/v1/patients/{marcus}/allergies")
        assert client.portal is not None
        client.portal.call(app.state.db.dispose)
    for response in (visits, vitals, meds, allergies):
        assert response.status_code == 200, response.text
    finished = [v for v in visits.json()["items"] if v["status"] == "finished"]
    assert len(finished) >= 2
    def codes(concept: dict[str, Any]) -> set[str]:
        return {c["code"] for c in concept.get("codings") or []}

    assert set().union(*(codes(m["medication"]) for m in meds.json()["items"])) >= {
        "314076", "861007", "617310"}
    assert [codes(a["code"]) for a in allergies.json()["items"]] == [{"7980"}]
    assert vitals.json()["items"]
