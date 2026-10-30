"""The reset's own half (app.db.seed.reset): it only fills an empty database and refuses
anything else; it never drops, truncates or deletes. The full run (empty database to the demo
data) is run by hand on a fresh database, as the reset split leaves one. Synthetic data only."""
from __future__ import annotations

import pytest
from sqlalchemy import Engine

from app.db.seed import reset
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_database_with_tables_is_refused_and_left_alone(
        admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    migrated = []
    monkeypatch.setattr(reset, "migrate", lambda: migrated.append(True))
    with pytest.raises(reset.NotEmpty):
        reset.reset(admin_engine)          # the test database is migrated: it has tables
    assert not migrated


@pytest.mark.parametrize("environment", ["production", "staging"])
def test_only_development_and_test(monkeypatch: pytest.MonkeyPatch, environment: str) -> None:
    monkeypatch.setenv("ENVIRONMENT", environment)
    with pytest.raises(RuntimeError, match="ENVIRONMENT"):
        reset.reset(None)  # type: ignore[arg-type]  # refused before the database is used
