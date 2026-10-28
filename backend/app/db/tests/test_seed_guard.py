"""The seed's environment guard (app.db.seed.__main__), with no database: the layer and the
engine are stubs, so a broken guard fails here and nothing is ever seeded (Vimal, #95)."""
from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import create_engine

from app.db.seed import __main__ as seed_main


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """Records each call of the stubbed layer; the engine is an in-memory SQLite one."""
    seen: list[Any] = []
    monkeypatch.setitem(seed_main.LAYERS, "starter", seen.append)
    monkeypatch.setattr(seed_main, "create_engine", lambda *a, **k: create_engine("sqlite://"))
    monkeypatch.setattr(seed_main, "bypasses_rls", lambda db: False)
    monkeypatch.setenv("MIGRATION_DATABASE_URL", "postgresql://seed:unused@db.invalid/none")
    return seen


@pytest.mark.parametrize("environment", ["production", "staging", None])
def test_the_seed_refuses_every_environment_but_development_and_test(
        calls: list[Any], monkeypatch: pytest.MonkeyPatch, environment: str | None) -> None:
    if environment is None:
        monkeypatch.delenv("ENVIRONMENT", raising=False)       # unset means production
    else:
        monkeypatch.setenv("ENVIRONMENT", environment)
    assert seed_main.main(["starter"]) == 1
    assert calls == []


@pytest.mark.parametrize("environment", ["development", "test"])
def test_the_seed_runs_its_layer_in_development_and_test(
        calls: list[Any], monkeypatch: pytest.MonkeyPatch, environment: str) -> None:
    monkeypatch.setenv("ENVIRONMENT", environment)
    assert seed_main.main(["starter"]) == 0
    assert len(calls) == 1                                     # the guard was reached and passed


def test_the_seed_refuses_a_login_that_bypasses_rls(
        calls: list[Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setattr(seed_main, "bypasses_rls", lambda db: True)
    assert seed_main.main(["starter"]) == 1
    assert calls == []


@pytest.mark.parametrize("environment", ["production", "staging", None])
def test_load_starter_refuses_too_before_touching_the_database(
        monkeypatch: pytest.MonkeyPatch, environment: str | None) -> None:
    """The reset script and the tests call load_starter directly, not main."""
    from app.db.seed.starter import load_starter

    if environment is None:
        monkeypatch.delenv("ENVIRONMENT", raising=False)
    else:
        monkeypatch.setenv("ENVIRONMENT", environment)
    with pytest.raises(RuntimeError, match="refusing to seed"):
        load_starter(None)  # type: ignore[arg-type]   # never reached: no session needed


def test_an_unknown_layer_is_a_usage_error(calls: list[Any],
                                           monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "development")
    assert seed_main.main(["unknown"]) == 2
    assert calls == []
