"""The server-day database checks against the test database, as the master user."""
from __future__ import annotations

import pytest
from sqlalchemy import Engine, text

from app.db.tests.conftest import SKIP_WITHOUT_DATABASE
from app.db.tools import server_check as sc

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]


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


def test_a_query_that_fails_is_a_failed_check_not_a_crash(admin_engine: Engine) -> None:
    with admin_engine.connect() as conn:
        [(_, got)] = sc.run(conn, [sc.Check("missing", "SELECT x FROM no_such_table", "1")])
        assert got is None
        assert conn.execute(text("SELECT 1")).scalar_one() == 1   # the connection still works


def test_it_needs_the_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SERVER_CHECK_DATABASE_URL", raising=False)
    assert sc.main([]) == 2
