"""The performance baseline tool's guards and its generator's determinism. No database: the
tool itself runs only by hand (tools/perf_baseline.md), never in the test suite or CI."""
from __future__ import annotations

import datetime as dt

import pytest

from app.db.tools import perf_baseline as pb

NOW = dt.datetime(2026, 11, 13, 8, 0, 5, tzinfo=dt.UTC)


def test_the_same_patient_on_every_run() -> None:
    assert pb.person(2, 1234) == pb.person(2, 1234)
    assert list(pb.population(1, 1, 50)) == list(pb.population(1, 1, 50))


def test_patients_differ_by_clinic_and_number() -> None:
    assert pb.person(1, 7) != pb.person(2, 7)
    assert len({(p.given, p.family, p.birth_date) for p in pb.population(3, 1, 500)}) > 450
    assert len({p.mrn for p in pb.population(1, 1, 2000)}) == 2000


def test_generated_values_are_obviously_fictional() -> None:
    for p in pb.population(1, 1, 200):
        assert any(ch.isdigit() for ch in p.given) and any(ch.isdigit() for ch in p.family)
        assert p.phone.startswith("+1408555") and 100 <= int(p.phone[-4:]) < 200
        assert p.mrn.startswith("PERF1-")
        assert all(v < dt.datetime(2026, 11, 2, tzinfo=dt.UTC) for v in p.visits)


def test_a_top_up_continues_the_same_sequence() -> None:
    full = list(pb.population(1, 1, 30))
    assert list(pb.population(1, 21, 30)) == full[20:]
    assert list(pb.population(1, 31, 30)) == []


def test_new_names_match_the_pattern_in_utc() -> None:
    name = pb.new_database_name(NOW, "a1b2c3")
    assert name == "shri_perf_20261113080005_a1b2c3"
    pb.check_database_name(name)


@pytest.mark.parametrize("name", [
    "shri_health", "postgres", "keycloak", "template0", "template1", "shri_health_test",
    "shri_perf_", "shri_perf_20261113080005_A1B2C3", "shri_perf_2026111308000_a1b2c3",
    "shri_perf_20261113080005_a1b2c3; DROP DATABASE shri_health",
    "x_shri_perf_20261113080005_a1b2c3",
])
def test_refuses_any_other_database(name: str) -> None:
    with pytest.raises(pb.Refused):
        pb.check_database_name(name)


def test_refuses_a_bad_token() -> None:
    with pytest.raises(pb.Refused):
        pb.new_database_name(NOW, "xyz")


@pytest.mark.parametrize("env", [
    {}, {"ENVIRONMENT": "production"}, {"ENVIRONMENT": "staging"},
    {"ENVIRONMENT": "development", "SHRI_DEMO": "true"},
    {"ENVIRONMENT": "test", "SHRI_DEMO": "TRUE"},
])
def test_refuses_production_staging_and_demo_servers(env: dict[str, str]) -> None:
    with pytest.raises(pb.Refused):
        pb.check_environment(env)


@pytest.mark.parametrize("env", [
    {"ENVIRONMENT": "development"}, {"ENVIRONMENT": "test", "SHRI_DEMO": "false"},
])
def test_runs_on_a_development_or_test_machine(env: dict[str, str]) -> None:
    pb.check_environment(env)


def test_needs_the_master_url_and_never_prints_it(capsys: pytest.CaptureFixture[str],
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.delenv("SHRI_DEMO", raising=False)
    monkeypatch.delenv(pb.ADMIN_URL_SETTING, raising=False)
    assert pb.main([]) == 2
    assert pb.ADMIN_URL_SETTING in capsys.readouterr().err


def test_refuses_before_touching_any_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv(pb.ADMIN_URL_SETTING, "postgresql+psycopg://u:p@localhost:1/postgres")
    monkeypatch.setattr(pb, "_create", lambda *_: pytest.fail("created a database"))
    assert pb.main([]) == 2


def test_drops_its_database_after_a_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.delenv("SHRI_DEMO", raising=False)
    monkeypatch.setenv(pb.ADMIN_URL_SETTING, "postgresql+psycopg://u:p@localhost:1/postgres")
    made: list[str] = []
    dropped: list[str] = []
    monkeypatch.setattr(pb, "_create", lambda _admin, name: made.append(name))
    monkeypatch.setattr(pb, "_drop", lambda _admin, name: dropped.append(name))

    def fail(*_: object) -> None:
        raise RuntimeError("migration failed")

    monkeypatch.setattr(pb, "_migrate", fail)
    with pytest.raises(RuntimeError, match="migration failed"):
        pb.main([])
    assert dropped == made and len(made) == 1
    pb.check_database_name(made[0])


def test_report_lists_every_operation_with_the_earlier_baseline() -> None:
    out = pb.report({name: [1.0, 2.0, 3.0] for name in pb.OPERATIONS}, 3)
    for name in pb.OPERATIONS:
        assert name in out
    assert "26.5 / 66.0" in out and "49.6 / 58.4" in out and "12.7 / 15.9" in out
    assert pb.pct([float(n) for n in range(1, 101)], .95) == 95.0


def test_drops_a_half_created_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.delenv("SHRI_DEMO", raising=False)
    monkeypatch.setenv(pb.ADMIN_URL_SETTING, "postgresql+psycopg://u:p@localhost:1/postgres")
    dropped: list[str] = []

    def half_create(_admin: object, name: str) -> None:
        raise RuntimeError("extensions failed")

    monkeypatch.setattr(pb, "_create", half_create)
    monkeypatch.setattr(pb, "_drop", lambda _admin, name: dropped.append(name))
    with pytest.raises(RuntimeError, match="extensions failed"):
        pb.main([])
    assert len(dropped) == 1
    pb.check_database_name(dropped[0])
