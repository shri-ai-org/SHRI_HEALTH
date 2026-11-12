"""The demo patients' clinical history (app.db.seed.history): loaded as shri_migrator through the
fhir_store helpers after the demo layer, re-runnable, and what the doctor's screens read back
through the API as the demo clinic's doctor. Synthetic data only."""
from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import CLINIC_A, DEV_USER_HEADER, DEV_USERS
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


def _observations(n: int, h: history.History) -> int:
    """Each reading's vitals (a visit's adds height), and the two social history answers."""
    days = {v.day for v in h.visits}
    return 2 + sum(3 + (r.spo2 is not None) + (r.temperature_f is not None)
                   + (r.respiratory_rate is not None) + (r.day in days)
                   for r in history.VITALS[n])


def _expected(n: int, h: history.History) -> tuple[int, ...]:
    """problems and visit diagnoses, allergies, meds, finished visits (the doctor's, and a
    nurse visit for every other reading), observations, family, surgery, signed notes."""
    return (len(h.problems) + sum(len(v.diagnoses) for v in h.visits), len(h.allergies),
            len(h.medications), len(history.VITALS[n]), _observations(n, h), len(h.family),
            len(h.surgeries), len(h.visits))


def test_each_history_patient_has_a_vitals_series() -> None:
    """Six to eight readings in the year before the demo (20 Nov), oldest first, one on each
    visit's day (with its temperature) and none in the future; SpO2 only for asthma and COPD."""
    asthma_or_copd = {n for n, h in history.HISTORY.items()
                      if any((c.code.code or "")[:3] in ("J44", "J45") for c in h.problems)}
    assert set(history.VITALS) == set(history.HISTORY) and asthma_or_copd == {4, 7}
    for n, readings in history.VITALS.items():
        days = [r.day for r in readings]
        in_the_year = [d for d in days if d >= dt.date(2025, 11, 20)]
        assert 6 <= len(in_the_year) <= 8 and days == sorted(set(days)), n
        assert all(dt.date(2025, 11, 1) <= d < dt.date(2026, 11, 11) for d in days), n
        visits = {v.day for v in history.HISTORY[n].visits}
        assert visits <= set(days), n
        assert all((r.temperature_f is not None) == (r.day in visits) for r in readings), n
        assert all((r.respiratory_rate is not None) == (r.day in visits) for r in readings), n
        assert all((r.spo2 is not None) == (n in asthma_or_copd) for r in readings), n


def test_the_trends_fit_the_conditions() -> None:
    def first_last(n: int, value: Any) -> tuple[Any, Any]:
        return value(history.VITALS[n][0]), value(history.VITALS[n][-1])

    systolic = first_last(2, lambda r: r.bp[0])
    assert systolic[0] >= 140 > 130 >= systolic[1]                   # to goal on treatment
    assert first_last(2, lambda r: r.weight_lb)[1] < first_last(2, lambda r: r.weight_lb)[0]
    assert first_last(4, lambda r: r.spo2) == (95, 98)                 # the controller
    rates = first_last(6, lambda r: r.heart_rate)
    assert rates[1] <= rates[0] - 10                                   # propranolol
    lowest = min(history.VITALS[7], key=lambda r: r.spo2 or 100)
    assert lowest.day == dt.date(2026, 2, 17) and lowest.spo2 == 89   # the exacerbation


def test_each_demo_patient_gets_their_history_once(seeded: None,
                                                   admin_engine: Engine) -> None:
    nothing = (0,) * 8
    expected = {p.n: _expected(p.n, history.HISTORY[p.n]) if p.history else nothing
                for p in demo.PATIENTS}           # 1, the demo visit's patient, and 8 to 12
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


def test_every_past_visit_was_booked_checked_in_and_out(seeded: None,
                                                        admin_engine: Engine) -> None:
    """As the live visit leaves it: a fulfilled booking with its reason, the four visit steps,
    the exam room, and a follow-up request booked as the next visit (or declined)."""
    with admin_engine.connect() as c:
        rows = c.execute(text(
            "SELECT a.status, (SELECT count(*) FROM clinical.appointment_reason r "
            "  WHERE r.appointment_id = a.id) AS reasons, "
            "(SELECT string_agg(v.step, ',' ORDER BY v.occurred_at) "
            "  FROM admin.visit_flow_event v WHERE v.appointment_id = a.id) AS steps, "
            "(SELECT count(*) FROM clinical.encounter_location l WHERE l.encounter_id = e.id) "
            "  AS rooms, f.status AS follow_up "
            "FROM clinical.appointment a JOIN clinical.encounter e ON e.appointment_id = a.id "
            "JOIN clinical.encounter_follow_up f ON f.encounter_id = e.id "
            "WHERE a.subject_patient_id = ANY(:ps)"),
            {"ps": [sid(demo.PATIENT, n) for n in history.HISTORY]}).all()
    assert len(rows) == sum(len(h.visits) for h in history.HISTORY.values())
    assert {(r.status, r.reasons, r.steps, r.rooms) for r in rows} == {
        ("fulfilled", 1, "checked-in,roomed,with-provider,checked-out", 1)}
    declined = [r for r in rows if r.follow_up == "declined"]
    assert len(declined) == sum(h.last_follow_up is not None
                                for h in history.HISTORY.values())


def test_the_restricted_chart_has_its_label_and_provenance(seeded: None,
                                                           admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        rows = c.execute(text(
            "SELECT p.id, pv.reason_text, pv.created_by_user_id FROM clinical.patient p "
            "JOIN clinical.provenance pv ON pv.target_id = p.id AND pv.activity_code = 'UPDATE' "
            "WHERE 'R' = ANY(p.meta_security) AND p.id = ANY(:ps)"),
            {"ps": [sid(demo.PATIENT, p.n) for p in demo.PATIENTS]}).all()
    assert [tuple(r) for r in rows] == [(sid(demo.PATIENT, 6), history.RESTRICT_REASON,
                                         history.ADMIN_USER)]


def test_the_doctor_reads_it_through_the_api(seeded: None, admin_engine: Engine) -> None:
    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              database_url=TEST_DATABASE_URL))
    robert, david = sid(demo.PATIENT, 2), sid(demo.PATIENT, 6)
    with TestClient(app) as client:
        client.headers[DEV_USER_HEADER] = "md"
        visits = client.get(f"/api/v1/patients/{robert}/encounters")
        vitals = client.get(f"/api/v1/patients/{robert}/vitals")
        meds = client.get(f"/api/v1/patients/{robert}/medications")
        allergies = client.get(f"/api/v1/patients/{robert}/allergies")
        contacts = client.get(f"/api/v1/patients/{robert}/related-persons")
        # Restricted: refused without a grant (D37). The grant itself is a write with an
        # Idempotency-Key, which needs core's Transit; the dry run's step 8 makes one.
        sealed = client.get(f"/api/v1/patients/{david}/problems")
        assert client.portal is not None
        client.portal.call(app.state.db.dispose)
    with admin_engine.connect() as c:     # a grant left by an earlier run lasts 4 hours (D53)
        granted = c.execute(text(
            "SELECT EXISTS (SELECT 1 FROM audit.break_glass_access WHERE patient_id = :p "
            "AND user_id = :u AND expires_at > now())"),
            {"p": david, "u": DEV_USERS["md"].id}).scalar_one()
    if granted:
        assert sealed.status_code == 200, sealed.text
    else:
        assert sealed.status_code == 403 and sealed.json()["code"] == "break-glass-required"
    for response in (visits, vitals, meds, allergies, contacts):
        assert response.status_code == 200, response.text
    assert contacts.json()["items"]
    finished = [v for v in visits.json()["items"] if v["status"] == "finished"]
    assert len(finished) == len(history.VITALS[2])     # the doctor's visits and nurse visits
    def codes(concept: dict[str, Any]) -> set[str]:
        return {c["code"] for c in concept.get("codings") or []}

    assert set().union(*(codes(m["medication"]) for m in meds.json()["items"])) >= {
        "314076", "861007", "617311"}
    assert [codes(a["code"]) for a in allergies.json()["items"]] == [{"723"}]
    assert vitals.json()["items"]
