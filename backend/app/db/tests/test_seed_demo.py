"""The demo layer (app.db.seed.demo): loaded as shri_migrator on top of the starter layer,
re-runnable, and what the demo screens read through the API role."""
from __future__ import annotations

import datetime as dt
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS
from app.db.seed import demo, starter
from app.db.seed.starter import sid
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, open_session
from app.db.tests.test_seed import _snapshot, migrator_engine

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["migrator_engine"]       # a fixture, used by name

COUNTED = ("admin.pharmacy", "admin.payer", "admin.practice_payer", "admin.consent_requirement",
           "clinical.patient", "clinical.coverage", "clinical.appointment",
           "clinical.appointment_participant", "admin.patient_pharmacy", "clinical.identifier",
           "admin.mrn_counter", "admin.schedule_availability_rule",
           "admin.availability_rule_appointment_type")
#: A fixed clock for the seed's all-day schedule (any time well inside a day in both zones).
NOON = dt.datetime(2026, 11, 20, 18, 0, tzinfo=dt.UTC)


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")


def _seed(engine: Engine, now: dt.datetime = NOON) -> None:
    with Session(engine) as db, db.begin():
        demo.load_demo(db, now=now)


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


def test_the_demo_accounts_sign_in_with_their_roles(migrator_engine: Engine,
                                                   front_desk: Session) -> None:
    """What core's sign-in reads for each demo account (#152's Keycloak IDs)."""
    from app.core.session import _ROLES
    _seed(migrator_engine)
    for n, _username, subject, _name, role, _provider in demo.DEMO_USERS:
        user = front_desk.execute(text("SELECT * FROM admin.lookup_staff_user(:sub)"),
                                  {"sub": subject}).one()
        assert (user.user_id, user.tenant_id, user.is_active) == (sid(demo.DEMO_USER, n),
                                                                 CLINIC_A, True)
        roles = front_desk.execute(_ROLES, {"id": user.user_id}).all()
        assert [r.code for r in roles] == [role]
    account = front_desk.execute(text("SELECT * FROM admin.lookup_portal_account(:k)"),
                                 {"k": demo.DEMO_PATIENT_SUBJECT}).one()
    assert (account.tenant_id, account.patient_id, account.status) == (
        CLINIC_A, sid(demo.PATIENT, demo.DEMO_PORTAL_PATIENT), "active")


def test_the_seed_uses_the_keycloak_accounts_ids_and_names() -> None:
    """D112: Keycloak's names (#152's reset script) are the source of truth, so a person has
    one name on every screen and in sign-in. No database needed."""
    script = (Path(__file__).resolve().parents[4] / "infra" / "keycloak"
              / "reset-demo-users.sh").read_text()
    ids = dict(re.findall(r"^(\w+)_ID=([0-9a-f-]{36})$", script, re.MULTILINE))
    accounts = {m[1]: (ids[m[0]], f"{m[2]} {m[3]}") for m in re.findall(
        r'user "\$(\w+)_ID" (\S+) \S+ (\w+) (\w+)\)', script)}
    staff = {username: (subject, name)
             for _, username, subject, name, _, _ in demo.DEMO_USERS}
    assert staff == {u: a for u, a in accounts.items() if not u.startswith("demo.patient")}
    subject, name = accounts["demo.patient@example.com"]
    assert subject == demo.DEMO_PATIENT_SUBJECT
    patient = next(p for p in demo.PATIENTS if p.n == demo.DEMO_PORTAL_PATIENT)
    assert f"{patient.given} {patient.family}" == name
    provider = next(p for p in starter.PROVIDERS if p[0] == "demo")
    assert f"{provider[2]} {provider[1]}" == accounts["demo.doctor"][1]


# ======================================================================= the all-day schedule
def _windows(admin_engine: Engine) -> dict[str, set[tuple[dt.date, dt.date]]]:
    """Each facility's all-day rules (by its time zone): their (effective_from, effective_to)."""
    with admin_engine.connect() as c:
        rows = c.execute(text(
            "SELECT f.timezone, r.day_of_week, r.start_time, r.end_time, r.effective_from, "
            "r.effective_to FROM admin.schedule_availability_rule r "
            "JOIN clinical.schedule s ON s.id = r.schedule_id "
            "JOIN admin.facility f ON f.id = s.ext_facility_id "
            "WHERE r.start_time = '00:00' AND r.end_time = '23:59'")).all()
    out: dict[str, set[tuple[dt.date, dt.date]]] = {}
    days: dict[str, set[str]] = {}
    for r in rows:
        out.setdefault(r.timezone, set()).add((r.effective_from, r.effective_to))
        days.setdefault(r.timezone, set()).add(str(r.day_of_week))
    assert all(d == set(demo.DAYS_OF_WEEK) for d in days.values())  # weekends included
    return out


def test_every_provider_is_bookable_all_day_from_each_facilitys_today(
        migrator_engine: Engine, admin_engine: Engine) -> None:
    """Just before midnight in Chicago it is already the next day in New York: each facility's
    window starts on its own today. Just after, both are the same day."""
    before = dt.datetime(2026, 11, 20, 5, 59, 30, tzinfo=dt.UTC)  # 23:59:30 CST, 00:59:30 EST
    _seed(migrator_engine, before)
    assert _windows(admin_engine) == {
        "America/Chicago": {(dt.date(2026, 11, 19), dt.date(2026, 11, 26))},
        "America/New_York": {(dt.date(2026, 11, 20), dt.date(2026, 11, 27))}}
    after = dt.datetime(2026, 11, 20, 6, 0, 30, tzinfo=dt.UTC)    # 00:00:30 CST
    _seed(migrator_engine, after)
    assert _windows(admin_engine) == {
        "America/Chicago": {(dt.date(2026, 11, 20), dt.date(2026, 11, 27))},
        "America/New_York": {(dt.date(2026, 11, 20), dt.date(2026, 11, 27))}}
    with admin_engine.connect() as c:                # one rule per provider, facility and day
        assert c.execute(text(
            "SELECT count(*) FROM admin.schedule_availability_rule WHERE start_time = '00:00' "
            "AND end_time = '23:59'")).scalar_one() == len(starter.PROVIDERS) * 2 * 7


def test_the_same_day_again_changes_nothing(migrator_engine: Engine, admin_engine: Engine,
                                            monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.db.tests.test_seed.COUNTED", COUNTED)
    _seed(migrator_engine, NOON)
    first = _snapshot(admin_engine)
    _seed(migrator_engine, NOON + dt.timedelta(hours=3))   # later the same day in both zones
    assert _snapshot(admin_engine) == first


def test_the_rules_are_local_times_so_a_daylight_saving_day_is_still_all_day(
        migrator_engine: Engine, admin_engine: Engine) -> None:
    """Seeded on Sat 31 Oct, the window covers Sun 1 Nov, when Chicago leaves daylight time: the
    rule is stored as 00:00 to 23:59 local, so that day's window is 24 h 59 min long in UTC
    (laid out by the scheduling module, as for every booking)."""
    from app.modules.scheduling.reference import AvailabilityRule
    from app.modules.scheduling.slots import windows

    _seed(migrator_engine, dt.datetime(2026, 10, 31, 15, 0, tzinfo=dt.UTC))
    with admin_engine.connect() as c:
        row = c.execute(text(
            "SELECT r.schedule_id, r.day_of_week, r.start_time, r.end_time, r.slot_minutes, "
            "r.location_id, r.effective_from, r.effective_to "
            "FROM admin.schedule_availability_rule r "
            "JOIN clinical.schedule s ON s.id = r.schedule_id JOIN admin.facility f "
            "ON f.id = s.ext_facility_id WHERE f.timezone = 'America/Chicago' "
            "AND r.day_of_week = 'sun' AND r.start_time = '00:00' LIMIT 1")).one()
    assert row.effective_from <= dt.date(2026, 11, 1) <= row.effective_to
    rule = AvailabilityRule(row.schedule_id, row.schedule_id, str(row.day_of_week),
                            row.start_time, row.end_time, row.slot_minutes, row.location_id,
                            row.effective_from, row.effective_to, frozenset())
    ((_, start, end, _, _),) = windows([rule], [], dt.date(2026, 11, 1), "America/Chicago", None)
    assert start == dt.datetime(2026, 11, 1, 5, 0, tzinfo=dt.UTC)       # 00:00 CDT
    assert end == dt.datetime(2026, 11, 2, 5, 59, tzinfo=dt.UTC)         # 23:59 CST
