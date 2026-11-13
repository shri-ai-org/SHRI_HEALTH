"""The demo layer (app.db.seed.demo): loaded as shri_migrator on top of the starter layer,
re-runnable, and what the demo screens read through the API role."""
from __future__ import annotations

import datetime as dt
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS, FACILITY_A
from app.db.models import MAPPERS, systems
from app.db.seed import demo, starter
from app.db.seed.starter import sid
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, open_session
from app.db.tests.test_seed import _snapshot, migrator_engine

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
M = MAPPERS
__all__ = ["migrator_engine"]       # a fixture, used by name

COUNTED = ("admin.pharmacy", "admin.payer", "admin.practice_payer", "admin.consent_requirement",
           "clinical.patient", "clinical.coverage", "clinical.appointment",
           "clinical.appointment_participant", "admin.patient_pharmacy", "clinical.identifier",
           "admin.mrn_counter", "admin.schedule_availability_rule",
           "admin.availability_rule_appointment_type", "admin.integration_endpoint",
           "clinical.patient_race_ethnicity", "admin.employer",
           "clinical.patient_general_practitioner", "clinical.coverage_class",
           "clinical.coverage_cost_to_beneficiary", "admin.portal_account",
           "admin.online_booking_setting", "admin.online_bookable_type",
           "clinical.appointment_reason")


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    # Five of the 500, so each database test seeds in seconds; the full population is checked
    # without a database below, and loads in the reset.
    monkeypatch.setattr(demo, "POPULATION_SIZE", 5)


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
               f"ON t.id = a.ext_appointment_type_id WHERE a.start::date = '{demo.DEMO_DAY}' "
               "ORDER BY a.start")
    assert [r.code for r in day] == ["NEW", "FU", "FU", "ANNUAL", "FU", "FU", "FU"]
    nine = dt.datetime.combine(demo.DEMO_DAY, dt.time(9), ZoneInfo("America/Los_Angeles"))
    assert day[0].start == nine                                  # 9:00 at the San Jose office
    assert len(rows("SELECT 1 FROM clinical.coverage WHERE status = 'active'")) >= 4
    required = {r.kind for r in rows("SELECT kind FROM admin.consent_requirement "
                                     "WHERE is_required AND is_active")}
    assert required == {"treatment", "privacy-notice", "financial"}
    pharmacy = rows("SELECT p.name FROM admin.patient_pharmacy pp JOIN admin.pharmacy p "
                    "ON p.id = pp.pharmacy_id WHERE pp.is_default")
    assert {r.name for r in pharmacy} == {"Demo Pharmacy (synthetic)"}


def test_a_signed_prescription_has_one_connection_to_send_through(
        migrator_engine: Engine, front_desk: Session, app_engine: Engine) -> None:
    """The outbox's lookup (app.integration.api): one active erx connection, or signing is 503."""
    _seed(migrator_engine)
    erx = ("SELECT adapter, environment FROM admin.integration_endpoint "
           "WHERE kind = 'erx' AND is_active")
    assert [tuple(r) for r in front_desk.execute(text(erx))] == [("simulated-erx", "test")]
    db = open_session(app_engine, CLINIC_B)
    try:
        assert list(db.execute(text(erx))) == []        # the other clinic has none of its own
    finally:
        conn = db.bind
        db.close()
        conn.close()  # type: ignore[union-attr]


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
    for _n, patient, _username, subject in demo.PORTAL_USERS:   # active, no invitation
        account = front_desk.execute(text("SELECT * FROM admin.lookup_portal_account(:k)"),
                                     {"k": subject}).one()
        assert (account.tenant_id, account.patient_id, account.status) == (
            CLINIC_A, sid(demo.PATIENT, patient), "active")
    assert front_desk.execute(text("SELECT count(*) FROM admin.portal_invitation")
                              ).scalar_one() == 0


def test_online_booking_takes_a_follow_up_with_a_days_notice(migrator_engine: Engine,
                                                             front_desk: Session) -> None:
    _seed(migrator_engine)
    setting = front_desk.execute(text(
        "SELECT is_enabled, min_notice_minutes, booking_window_days, cancel_cutoff_hours, "
        "reschedule_cutoff_hours FROM admin.online_booking_setting")).one()
    assert tuple(setting) == (True, 24 * 60, 60, 24, 24)
    bookable = front_desk.execute(text(
        "SELECT b.facility_id, t.code FROM admin.online_bookable_type b "
        "JOIN admin.appointment_type t ON t.id = b.appointment_type_id ORDER BY t.code")).all()
    assert [tuple(r) for r in bookable] == [(FACILITY_A, "FU"), (FACILITY_A, "TELE-FU")]


def test_a_shown_patient_has_every_registration_field(migrator_engine: Engine,
                                                      front_desk: Session) -> None:
    """What the registration and insurance screens show (the rest is history.py's)."""
    _seed(migrator_engine)
    for p in demo.SHOWN_PATIENTS:
        pid = sid(demo.PATIENT, p.n)
        row = front_desk.execute(text(
            "SELECT p.marital_status_code, p.ext_race_text, p.ext_ethnicity_text, "
            "p.ext_occupation_text, p.ext_industry_text, "
            "(SELECT count(*) FROM clinical.contact_point c WHERE c.patient_id = p.id) AS tel, "
            "(SELECT count(*) FROM clinical.patient_race_ethnicity r "
            " WHERE r.patient_id = p.id) AS omb, "
            "(SELECT count(*) FROM admin.employer e WHERE e.patient_id = p.id "
            " AND e.phone IS NOT NULL) AS employer, "
            "(SELECT count(*) FROM clinical.patient_general_practitioner g "
            " WHERE g.patient_id = p.id) AS pcp "
            "FROM clinical.patient p WHERE p.id = :p"), {"p": pid}).one()
        assert all(v for v in row[:5]) and tuple(row[5:]) == (2, 2, 1, 1), p.family
        cover = front_desk.execute(text(
            "SELECT c.subscriber_id, "
            "(SELECT k.value FROM clinical.coverage_class k WHERE k.coverage_id = c.id "
            " AND k.type = 'plan') AS plan, "
            "(SELECT m.value_money_value FROM clinical.coverage_cost_to_beneficiary m "
            " WHERE m.coverage_id = c.id) AS copay "
            "FROM clinical.coverage c WHERE c.beneficiary_patient_id = :p"), {"p": pid}).one()
        assert cover.subscriber_id and cover.plan and cover.copay is not None, p.family


# ============================================================== the shown patients, no database
ON_THE_DEMO_DAY = dt.date(2026, 11, 20)  # ages are the demo's, whatever day the seed books


def _age(born: dt.date) -> int:
    d = ON_THE_DEMO_DAY
    return d.year - born.year - ((d.month, d.day) < (born.month, born.day))


def test_the_shown_patients_are_vimals_list() -> None:
    """Names, ages on the demo day, history and the restricted chart (Vimal, 11 Nov)."""
    from app.db.seed import history

    shown = {f"{p.given} {p.family}": (_age(p.birth_date), p.history, p.restricted)
             for p in demo.SHOWN_PATIENTS}
    assert shown == {
        "Robert Miller": (68, True, False), "Linda Thompson": (57, True, False),
        "James Wilson": (45, True, False), "Patricia Davis": (61, True, False),
        "David Nguyen": (39, True, True), "Maria Gonzalez": (72, True, False),
        "Emily Carter": (34, False, False), "Daniel Brooks": (52, False, False),
        "Sofia Ramirez": (41, False, False), "Michael Chen": (63, False, False),
        "Aisha Johnson": (29, False, False)}
    every = [(p.given, p.family) for p in demo.PATIENTS + demo.population()]
    assert len(every) == len(set(every))                    # every name is unique
    assert {p.n for p in demo.SHOWN_PATIENTS if p.history} == set(history.HISTORY)
    assert all(p.payer and p.email and p.emergency for p in demo.SHOWN_PATIENTS)
    # The bulk patients keep their generated names, with digits (D112 as amended).
    assert all(any(ch.isdigit() for ch in p.given) for p in demo.population())


def test_each_history_patients_conditions() -> None:
    from app.db.seed import history

    problems = {n: {c.code.code for c in h.problems} for n, h in history.HISTORY.items()}
    assert problems == {2: {"I10", "E11.9", "E78.5", "Z87.891"}, 3: {"M54.50", "G89.29"},
                        4: {"J45.40", "J30.2"}, 5: {"C50.912", "Z92.3", "Z79.811"},
                        6: {"G43.009"}, 7: {"J44.9", "M17.0", "Z87.891"}}
    for h in history.HISTORY.values():
        assert 3 <= len(h.visits) <= 4 and h.allergies and h.medications
        assert h.family and h.surgeries
        assert len({v.day for v in h.visits}) == len(h.visits)
        assert all(dt.date(2025, 11, 11) <= v.day < demo.DEMO_DAY for v in h.visits)


def test_the_portal_accounts_have_their_posted_ids() -> None:
    """The Keycloak IDs posted on #85: UUIDv5 of the username, for the three patients."""
    import uuid

    names = {p.n: f"{p.given}.{p.family}".lower() for p in demo.SHOWN_PATIENTS}
    for _n, patient, username, subject in demo.PORTAL_USERS:
        assert username == names[patient]
        assert subject == str(uuid.uuid5(demo.PORTAL_NAMESPACE, username))
    assert [patient for _, patient, _, _ in demo.PORTAL_USERS] == [3, 4, 7]


def test_the_portal_accounts_match_the_realm_script_where_it_has_them() -> None:
    """Drift against Thulasi's realm script (D112): once it creates a portal user, its ID and
    display name must be the seed's. Skips until the script has any of them."""
    script = (Path(__file__).resolve().parents[4] / "infra" / "keycloak"
              / "reset-demo-users.sh").read_text()
    ids = dict(re.findall(r"^(\w+)_ID=([0-9a-f-]{36})$", script, re.MULTILINE))
    accounts = {m[1]: (ids.get(m[0]), f"{m[2]} {m[3]}") for m in re.findall(
        r'user "\$(\w+)_ID" (\S+) \S+ (\w+) (\w+)\)', script)}
    shown = {p.n: f"{p.given} {p.family}" for p in demo.SHOWN_PATIENTS}
    found = 0
    for _n, patient, username, subject in demo.PORTAL_USERS:
        account = next((a for u, a in accounts.items() if u.split("@")[0] == username), None)
        if account is not None:
            assert account == (subject, shown[patient]), username
            found += 1
    if not found:
        pytest.skip("the realm script has none of the seeded portal users yet")


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
    # Patient realm users sign in with their email as the username (#300); staff never do.
    assert staff == {u: a for u, a in accounts.items() if "@" not in u}
    subject, name = accounts["demo.patient@example.com"]
    assert subject == demo.DEMO_PATIENT_SUBJECT
    patient = next(p for p in demo.PATIENTS if p.n == demo.DEMO_PORTAL_PATIENT)
    assert f"{patient.given} {patient.family}" == name
    provider = next(p for p in starter.PROVIDERS if p[0] == "demo")
    assert f"{provider[2]} {provider[1]}" == accounts["demo.doctor"][1]


# ======================================================================= the all-day schedule
ZONES = ("America/Los_Angeles", "America/New_York")


def _all_day_rules(admin_engine: Engine, zone: str) -> list[Any]:
    """The facility's demo all-day rules, as the scheduling module reads availability."""
    from app.modules.scheduling.reference import AvailabilityRule, since_midnight

    with admin_engine.connect() as c:
        rows = c.execute(text(
            "SELECT r.schedule_id, s.id AS provider_ref, r.day_of_week, r.start_time, "
            "r.end_time, r.slot_minutes, r.location_id, r.effective_from, r.effective_to "
            "FROM admin.schedule_availability_rule r "
            "JOIN clinical.schedule s ON s.id = r.schedule_id "
            "JOIN admin.facility f ON f.id = s.ext_facility_id "
            "WHERE f.timezone = :z AND r.start_time = '00:00' AND r.end_time = '23:59'"),
            {"z": zone}).all()
    return [AvailabilityRule(r.schedule_id, r.provider_ref, str(r.day_of_week),
                             since_midnight(r.start_time), since_midnight(r.end_time),
                             r.slot_minutes, r.location_id, r.effective_from, r.effective_to,
                             frozenset()) for r in rows]


def _free(admin_engine: Engine, zone: str, day: dt.date, now: dt.datetime) -> list[Any]:
    from app.modules.scheduling.slots import free_slots

    return free_slots(_all_day_rules(admin_engine, zone), [], [], day, zone, None, None,
                      not_before=now)


def test_every_provider_has_weekly_all_day_rules_with_no_end_date(
        migrator_engine: Engine, admin_engine: Engine) -> None:
    _seed(migrator_engine)
    with admin_engine.connect() as c:
        rows = c.execute(text(
            "SELECT r.schedule_id, r.day_of_week, r.effective_from, r.effective_to "
            "FROM admin.schedule_availability_rule r WHERE r.start_time = '00:00' "
            "AND r.end_time = '23:59'")).all()
    assert len(rows) == len(starter.PROVIDERS) * 2 * 7       # each provider, facility and day
    assert {(r.effective_from, r.effective_to) for r in rows} == {(starter.EFFECTIVE_FROM, None)}
    for zone in ZONES:                                       # weekends included
        assert {r.day_of_week for r in _all_day_rules(admin_engine, zone)} == set(demo.DAYS_OF_WEEK)


@pytest.mark.parametrize("now", [
    dt.datetime(2026, 11, 20, 18, 0, tzinfo=dt.UTC),          # the demo day, midday
    dt.datetime(2026, 11, 20, 7, 59, 30, tzinfo=dt.UTC),      # 23:59:30 in San Jose
    dt.datetime(2026, 11, 20, 8, 0, 30, tzinfo=dt.UTC),       # 00:00:30 in San Jose
    dt.datetime(2026, 11, 20, 4, 59, 30, tzinfo=dt.UTC),      # 23:59:30 in New York
    dt.datetime(2026, 11, 20, 5, 0, 30, tzinfo=dt.UTC),       # 00:00:30 in New York
])
def test_a_revisit_14_days_out_has_free_times_whatever_the_hour(
        migrator_engine: Engine, admin_engine: Engine, now: dt.datetime) -> None:
    _seed(migrator_engine)
    for zone in ZONES:
        today = now.astimezone(ZoneInfo(zone)).date()
        later = _free(admin_engine, zone, today + dt.timedelta(days=14), now)
        assert {s.provider_id for s in later} == {r.provider_id for r in
                                                  _all_day_rules(admin_engine, zone)}
        assert len(later) >= 70 * len(starter.PROVIDERS)     # 00:00 to 23:40, every 20 min
    tomorrow = _free(admin_engine, "America/Los_Angeles", dt.date(2026, 11, 21), now)
    assert tomorrow                                          # just before midnight too


@pytest.mark.parametrize(("now", "day", "hours"), [
    (dt.datetime(2027, 2, 28, 18, 0, tzinfo=dt.UTC), dt.date(2027, 3, 14), 22),  # spring forward
    (dt.datetime(2026, 10, 18, 18, 0, tzinfo=dt.UTC), dt.date(2026, 11, 1), 24),  # fall back
])
def test_a_daylight_saving_day_14_days_out_is_still_all_day_local(
        migrator_engine: Engine, admin_engine: Engine, now: dt.datetime, day: dt.date,
        hours: int) -> None:
    """The rules are local times, so a day with 23 or 25 hours keeps 00:00 to 23:59 there."""
    _seed(migrator_engine)
    for zone in ZONES:
        free = _free(admin_engine, zone, day, now)
        local = [s.start.astimezone(ZoneInfo(zone)) for s in free]
        assert min(local).time() == dt.time(0, 0) and max(local).time() == dt.time(23, 20)
        span = max(s.start for s in free) - min(s.start for s in free)
        assert span == dt.timedelta(hours=hours, minutes=20)


def test_a_database_seeded_before_gets_the_open_ended_rules(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """The earlier seed's 8-day window, made by the same rows: a rerun moves them to the
    weekly rules with no end date, adds nothing, and a second rerun changes nothing."""
    monkeypatch.setattr("app.db.tests.test_seed.COUNTED", COUNTED)
    _seed(migrator_engine)
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.schedule_availability_rule SET effective_from = "
                       "'2026-11-04', effective_to = '2026-11-11' WHERE start_time = '00:00' "
                       "AND end_time = '23:59'"))
    _seed(migrator_engine)
    first = _snapshot(admin_engine)
    with admin_engine.connect() as c:
        assert c.execute(text(
            "SELECT count(*) FROM admin.schedule_availability_rule WHERE start_time = '00:00' "
            "AND end_time = '23:59' AND effective_to IS NOT NULL")).scalar_one() == 0
    _seed(migrator_engine)
    assert _snapshot(admin_engine) == first


def test_the_starters_office_hours_stay(migrator_engine: Engine, admin_engine: Engine) -> None:
    _seed(migrator_engine)
    ids = [sid(starter.RULE, (i * 10 + j) * 10 + d) for i in range(1, len(starter.PROVIDERS) + 1)
           for j in (1, 2) for d in range(1, len(starter.WEEKDAYS) + 1)]
    with admin_engine.connect() as c:
        hours = c.execute(text(
            "SELECT start_time, end_time, effective_to FROM admin.schedule_availability_rule "
            "WHERE id = ANY(:ids)"), {"ids": ids}).all()
    assert len(hours) == len(ids)
    assert {tuple(h) for h in hours} == {(dt.time(9, 0), dt.time(17, 0), None)}


# ======================================================================= the population
def test_the_500_are_the_same_people_every_run_and_obviously_fictional(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.undo()                                  # the full 500, not the fixture's 5
    first, again = demo.population(), demo.population()
    assert first == again and len(first) == demo.POPULATION_SIZE == 500
    numbers = [p.n for p in first]
    assert len(set(numbers)) == 500 and not set(numbers) & {p.n for p in demo.PATIENTS}
    synthea = re.compile(r"^[A-Z][a-z]+\d{2,3}$")         # D112: names with digits
    assert all(synthea.match(p.given) and synthea.match(p.family) for p in first)
    assert all(re.fullmatch(r"\+14085550[12]\d\d", p.phone) for p in first)  # 555-01xx
    assert all(p.visit is None for p in first)         # the demo day is unchanged
    ages = [(dt.date(2026, 11, 20) - p.birth_date).days // 365 for p in first]
    assert min(ages) >= 6 and max(ages) <= 86
    assert {p.payer for p in first} == {1, 2, 3, None} and {p.gender for p in first} == {
        "female", "male"}


def test_eligibility_has_one_connection_to_send_through(
        migrator_engine: Engine, front_desk: Session, app_engine: Engine) -> None:
    """Eligibility's 270 goes through the outbox to partner clearinghouse (demo step 3): one
    active connection, the simulated payer, or the check is 503."""
    _seed(migrator_engine)
    payer = ("SELECT adapter, environment, name FROM admin.integration_endpoint "
             "WHERE kind = 'clearinghouse' AND is_active")
    assert [tuple(r) for r in front_desk.execute(text(payer))] == [
        ("simulated-clearinghouse", "test", "Simulated payer (demo)")]
    db = open_session(app_engine, CLINIC_B)
    try:
        assert list(db.execute(text(payer))) == []      # the other clinic has none of its own
    finally:
        conn = db.bind
        db.close()
        conn.close()  # type: ignore[union-attr]


def test_no_two_seed_kinds_share_a_number() -> None:
    """sid(kind, n) puts the kind in the ID, so two kinds on one number would give two rows
    the same ID (db/CLAUDE.md, "The demo seed's fixed IDs"). 21 is the one known overlap
    (starter USER_ROLE, demo PHARMACY), kept because renumbering would change live IDs."""
    import ast

    used: dict[int, list[str]] = {}
    from app.db.seed import results

    for module in (starter, demo, results):
        source = Path(module.__file__ or "").read_text()
        for node in ast.parse(source).body:
            if (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Tuple)
                    and isinstance(node.value, ast.Call)
                    and getattr(node.value.func, "id", "") == "range"):
                numbers = range(*(a.value for a in node.value.args  # type: ignore[attr-defined]
                                  ))
                for name, number in zip(node.targets[0].elts, numbers, strict=True):
                    used.setdefault(number, []).append(name.id)  # type: ignore[attr-defined]
    shared = {n: names for n, names in used.items() if len(names) > 1}
    assert shared == {21: ["USER_ROLE", "PHARMACY"]}
    assert demo.AI_FEATURE not in used                       # a single number, not a range


def test_the_demo_day_is_the_reset_day_in_san_jose_unless_set(
        monkeypatch: pytest.MonkeyPatch) -> None:
    """Vimal's run check on #85: rehearsals before the 20th see the demo patients that day. The
    day turns at midnight in San Jose (08:00 UTC in November, 13:30 IST), never at UTC's."""
    monkeypatch.delenv("SHRI_DEMO_DAY", raising=False)
    before = dt.datetime(2026, 11, 13, 7, 59, 59, tzinfo=dt.UTC)       # 23:59:59 in San Jose
    after = dt.datetime(2026, 11, 13, 8, 0, 0, tzinfo=dt.UTC)          # 00:00:00 there
    assert demo._demo_day(before) == dt.date(2026, 11, 12)
    assert demo._demo_day(after) == dt.date(2026, 11, 13)
    # The next daylight-saving change, Sunday 14 March 2027: that midnight is still PST (08:00
    # UTC), the next one PDT (07:00 UTC).
    assert demo._demo_day(dt.datetime(2027, 3, 14, 7, 59, 59, tzinfo=dt.UTC)) == \
        dt.date(2027, 3, 13)
    assert demo._demo_day(dt.datetime(2027, 3, 14, 8, 0, tzinfo=dt.UTC)) == dt.date(2027, 3, 14)
    assert demo._demo_day(dt.datetime(2027, 3, 15, 6, 59, 59, tzinfo=dt.UTC)) == \
        dt.date(2027, 3, 14)
    assert demo._demo_day(dt.datetime(2027, 3, 15, 7, 0, tzinfo=dt.UTC)) == dt.date(2027, 3, 15)
    monkeypatch.setenv("SHRI_DEMO_DAY", " 2026-11-20 ")
    assert demo._demo_day(before) == dt.date(2026, 11, 20)              # the setting wins
    monkeypatch.setenv("SHRI_DEMO_DAY", " ")
    assert demo._demo_day(after) == dt.date(2026, 11, 13)               # blank: the default


@pytest.mark.parametrize("value", ["20 Nov", "2026-11-31", "20261120", "2026-11-20T00:00",
                                   "2026-W47-5"])
def test_an_invalid_demo_day_is_refused_with_the_format(
        monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("SHRI_DEMO_DAY", value)
    with pytest.raises(ValueError, match=r"SHRI_DEMO_DAY must be a date as YYYY-MM-DD"):
        demo._demo_day()


def test_the_demo_clinic_has_both_ai_features_on(migrator_engine: Engine,
                                                admin_engine: Engine) -> None:
    """A feature without a row is off (modules/ai), so a reset without these leaves the AI off.
    A second run changes nothing."""
    _seed(migrator_engine)
    _seed(migrator_engine)
    with admin_engine.connect() as c:
        rows = c.execute(text("SELECT feature, is_enabled FROM admin.ai_feature_setting "
                              "WHERE tenant_id = :t ORDER BY feature"), {"t": CLINIC_A}).all()
    assert [tuple(r) for r in rows] == [("ambient-documentation", True), ("chart-summary", True)]


def test_a_history_patient_was_registered_before_the_first_visit(
        migrator_engine: Engine, admin_engine: Engine) -> None:
    from app.db.seed.history import HISTORY

    _seed(migrator_engine)
    with admin_engine.connect() as c:
        found = c.execute(text("SELECT id, created_at FROM clinical.patient WHERE tenant_id = :t"),
                          {"t": CLINIC_A}).all()
    created: dict[Any, dt.datetime] = {r.id: r.created_at for r in found}
    for n, h in HISTORY.items():
        assert created[sid(demo.PATIENT, n)] == h.visits[0].start - dt.timedelta(days=7)
    others = [p for p in demo.PATIENTS if not p.history]
    assert all(created[sid(demo.PATIENT, p.n)].date() >= dt.date(2026, 11, 1) for p in others)


# ================================================== an additive run (`deploy.sh up`) and a reset
def _ai(admin_engine: Engine) -> dict[str, bool]:
    with admin_engine.connect() as c:
        rows = c.execute(text("SELECT feature, is_enabled FROM admin.ai_feature_setting "
                              "WHERE tenant_id = :t"), {"t": CLINIC_A}).all()
    return {r.feature: r.is_enabled for r in rows}


def test_an_additive_run_restores_a_missing_ai_row_on_and_keeps_a_deliberate_off(
        migrator_engine: Engine, admin_engine: Engine) -> None:
    """D118: a switch-off in the AI settings persists until switched back on or the next reset;
    `up`'s seed only fills a missing row, as ON."""
    _seed(migrator_engine)
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.ai_feature_setting SET is_enabled = false, reason = :r "
                       "WHERE tenant_id = :t AND feature = 'ambient-documentation'"),
                  {"r": "Switched off for a rehearsal (synthetic)", "t": CLINIC_A})
        c.execute(text("DELETE FROM admin.ai_feature_setting WHERE tenant_id = :t "
                       "AND feature = 'chart-summary'"), {"t": CLINIC_A})
    try:
        _seed(migrator_engine)
        assert _ai(admin_engine) == {"ambient-documentation": False, "chart-summary": True}
    finally:
        with admin_engine.begin() as c:
            c.execute(text("UPDATE admin.ai_feature_setting SET is_enabled = true, reason = NULL "
                           "WHERE tenant_id = :t"), {"t": CLINIC_A})


def test_an_additive_run_leaves_live_work_alone(migrator_engine: Engine, admin_engine: Engine,
                                                app_engine: Engine) -> None:
    """A patient registered live keeps the next MRN, a visit booked live stays, and the seed
    adds no second copy of anything (no AI request or suggestion either: it writes none)."""
    _seed(migrator_engine)
    db = open_session(app_engine, CLINIC_A, DEV_USERS["fd"].id)
    try:
        mrn = db.execute(text("SELECT system, value FROM admin.next_mrn()")).one()
        live = M["patient"](gender="female", birth_date=dt.date(1990, 1, 2))
        live.identifier = [M["identifier"](system=mrn.system, value=mrn.value, use="usual",
                                           type_system=systems.V2_0203, type_code="MR")]
        live.name = [M["human_name"](family="Liveregistered77", given=["Avery402"],
                                     use="official")]
        db.add(live)
        db.flush()
        start = dt.datetime.combine(demo.DEMO_DAY, dt.time(15, 0), demo.CLINIC_ZONE)
        booked = M["appointment"](status="booked", subject_patient_id=live.id, start=start,
                                  end=start + dt.timedelta(minutes=20), minutes_duration=20,
                                  ext_facility_id=FACILITY_A)
        db.add(booked)
        db.commit()
        live_id, booked_id, live_mrn = live.id, booked.id, mrn.value
    finally:
        conn = db.bind
        db.close()
        conn.close()  # type: ignore[union-attr]

    def counts() -> tuple[int, ...]:
        with admin_engine.connect() as c:
            return tuple(c.execute(text(f"SELECT count(*) FROM {t} WHERE tenant_id = :t"),
                                   {"t": CLINIC_A}).scalar_one()
                         for t in ("clinical.patient", "clinical.appointment",
                                   "clinical.identifier", "admin.ai_request",
                                   "admin.ai_suggestion", "admin.ai_feature_setting"))
    before = counts()
    _seed(migrator_engine)
    assert counts() == before
    with admin_engine.connect() as c:
        assert c.execute(text("SELECT status FROM clinical.appointment WHERE id = :a"),
                         {"a": booked_id}).scalar_one() == "booked"
        assert c.execute(text("SELECT value FROM clinical.identifier WHERE patient_id = :p"),
                         {"p": live_id}).scalar_one() == live_mrn
        taken = c.execute(text("SELECT value FROM clinical.identifier i JOIN clinical.patient p "
                               "ON p.id = i.patient_id WHERE p.tenant_id = :t AND i.type_code = "
                               "'MR' GROUP BY value HAVING count(*) > 1"),
                          {"t": CLINIC_A}).all()
    assert taken == []                                       # no MRN given twice


def test_the_reset_check_passes_on_the_demo_data_and_names_what_is_wrong(
        migrator_engine: Engine) -> None:
    """reset.verify (the reset's last step): nothing to report on a fresh seed; an AI feature
    switched off, a lost portal account and too few visits each give their own phrase."""
    from app.db.seed import reset

    _seed(migrator_engine)
    with Session(migrator_engine) as db, db.begin():
        db.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))  # as the seed
        found = reset.summary(db)
        assert reset.verify(db, found) == []
        db.execute(text("UPDATE admin.ai_feature_setting SET is_enabled = false, reason = 'x' "
                        "WHERE feature = 'chart-summary'"))
        db.execute(text("UPDATE admin.portal_account SET status = 'disabled', "
                        "disabled_at = now(), disabled_reason = 'x' WHERE keycloak_user_id = :s"),
                   {"s": demo.PORTAL_USERS[0][3]})
        db.execute(text("UPDATE clinical.appointment SET status = 'cancelled', "
                        "ext_cancelled_at = now() WHERE status = 'booked' "
                        "AND (start AT TIME ZONE 'America/Los_Angeles')::date = :d"),
                   {"d": demo.DEMO_DAY})                      # every visit that day
        problems = reset.verify(db, found)
        db.rollback()
    assert problems == [
        "AI feature not on: chart-summary",
        f"0 visits booked on the demo day {demo.DEMO_DAY}, expected at least 6",
        f"portal account missing or on another chart: {demo.PORTAL_USERS[0][3]}"]
