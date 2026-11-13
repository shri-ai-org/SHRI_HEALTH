"""The server-day database checks against the test database, as the master user."""
from __future__ import annotations

import pytest
from sqlalchemy import Engine, text

from app.core.deps import CLINIC_A
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE
from app.db.tests.test_seed import migrator_engine
from app.db.tools import server_check as sc

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["migrator_engine"]       # a fixture, used by name


def test_the_default_patient_count_is_the_demo_seeds() -> None:
    from app.db.seed import demo

    assert sc.PATIENTS == len(demo.PATIENTS) + demo.POPULATION_SIZE


def test_a_migrated_database_passes_and_a_wrong_count_fails(admin_engine: Engine) -> None:
    with admin_engine.connect() as conn:
        patients = conn.execute(text("SELECT count(*) FROM clinical.patient")).scalar_one()
        vector = conn.execute(text(
            "SELECT extversion FROM pg_extension WHERE extname = 'vector'")).scalar_one()
        got = {c.name: v == c.expected
               for c, v in sc.run(conn, sc.checks(patients, pgvector=vector))}
        assert all(got.values()), got
        wrong = sc.run(conn, sc.checks(patients + 1, head="9999"))
    assert {c.name for c, v in wrong if v != c.expected} >= {"migrations at head",
                                                             "demo patients loaded"}


def test_a_clinic_table_without_row_security_and_a_superuser_fail(admin_engine: Engine) -> None:
    """Thulasi on #270: row security switched off entirely, and a superuser role, both count."""
    with admin_engine.connect() as conn, conn.begin() as tx:
        conn.execute(text("CREATE TABLE clinical.server_check_probe (tenant_id uuid)"))
        conn.execute(text("CREATE ROLE shri_server_check_probe SUPERUSER NOLOGIN"))
        failed = {c.name for c, v in sc.run(conn, sc.checks(0)) if v != c.expected}
        tx.rollback()
    assert {"row security on and forced on every clinic table",
            "no service role bypasses row security"} <= failed


def test_a_query_that_fails_is_a_failed_check_not_a_crash(admin_engine: Engine) -> None:
    with admin_engine.connect() as conn:
        [(_, got)] = sc.run(conn, [sc.Check("missing", "SELECT x FROM no_such_table", "1")])
        assert got is None
        assert conn.execute(text("SELECT 1")).scalar_one() == 1   # the connection still works


def test_it_needs_the_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SERVER_CHECK_DATABASE_URL", raising=False)
    assert sc.main([]) == 2


def test_the_demo_checks_pass_on_the_seed_and_name_what_is_missing(
        admin_engine: Engine, migrator_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """After the demo seed, its history and its results, every demo check passes but the code
    lists (the test database has none loaded); an AI feature switched off fails its own line."""
    from sqlalchemy.orm import Session

    from app.db.seed import demo
    from app.db.tests.test_seed_results import _load

    monkeypatch.setenv("ENVIRONMENT", "test")
    with Session(migrator_engine) as db, db.begin():
        demo.load_demo(db)
    _load()
    with admin_engine.connect() as conn:
        failed = {c.name for c, v in sc.run(conn, sc.demo_checks()) if not c.passes(v)}
        assert failed <= {"ICD-10-CM codes loaded", "RxNorm codes loaded"}, failed
        conn.rollback()
        conn.execute(text("UPDATE admin.ai_feature_setting SET is_enabled = false, "
                          "reason = 'rehearsal (synthetic)' WHERE feature = 'chart-summary' "
                          "AND tenant_id = :t"), {"t": CLINIC_A})
        off = {c.name for c, v in sc.run(conn, sc.demo_checks()) if not c.passes(v)}
        conn.rollback()                                     # nothing is kept
    assert "both AI features on in the demo clinic" in off


def test_an_at_least_check_takes_more_but_not_fewer() -> None:
    check = sc.Check("visits", "SELECT 1", "6", at_least=True)
    assert check.passes("7") and check.passes("6")
    assert not check.passes("5") and not check.passes(None) and not check.passes("x")


def test_a_failed_seed_line_says_a_reset_is_needed() -> None:
    """After an additive `up` over a database seeded before the San Jose move, the zone lines
    fail and say what fixes them; a passing line says nothing more."""
    zone = next(c for c in sc.demo_checks() if c.name == "the demo clinic's time zone")
    assert sc.line(zone, "America/Los_Angeles") == (
        "PASS  the demo clinic's time zone: America/Los_Angeles")
    assert sc.line(zone, "America/Denver") == (
        "FAIL  the demo clinic's time zone: America/Denver (expected America/Los_Angeles); "
        "reset needed: deploy.sh reset, after 13:30 IST (up only adds missing rows; Anand's seed)")
    visits = next(c for c in sc.demo_checks() if c.name.startswith("visits today"))
    none_today = sc.line(visits, "0")
    assert "(expected at least 6); reset needed" in none_today
    assert sc.line(sc.Check("x", "SELECT 1", "1"), "2") == "FAIL  x: 2 (expected 1)"
