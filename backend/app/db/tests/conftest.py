"""Live-database test fixtures.

Same convention as the core's database tests: ``TEST_DATABASE_URL`` points at a throwaway
PostgreSQL as a superuser, migrated to head first (``alembic -c app/db/alembic.ini upgrade
head``). Without it, the test modules here are skipped (marker ``db``). Any driver name works:
the schema tests use sync psycopg, the facade tests the URL's own (async) driver.

The app-role connections log in with that same URL and switch to ``shri_app`` with SET ROLE, so
no per-role password is needed. After SET ROLE, ``current_user`` is ``shri_app``, which has
neither superuser nor BYPASSRLS, so row-level security applies exactly as for a direct login.
A role's own ``search_path`` setting is applied only at login, so the switch also applies
``shri_app``'s configured search_path, read from the catalog.

Tests import this module and builders.py through the package (``app.db.tests.*``), never by bare
name: ``backend/app/core/tests/`` has its own conftest.py, and a bare ``conftest`` would resolve
to whichever one pytest imported first (pyproject.toml sets ``pythonpath = ["."]``).
"""

import os
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

import app.db.session  # noqa: F401  (registers the tenant default hook)

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
APP_ROLE = "shri_app"
SERVICE_ROLES = ("shri_app", "shri_fhir_reader", "shri_integration", "shri_reporting",
                 "shri_maintenance")
SKIP_WITHOUT_DATABASE = pytest.mark.skipif(not TEST_DATABASE_URL,
                                           reason="TEST_DATABASE_URL not set")


def _role_search_path_sql(role: str) -> str:
    """Applies the role's own configured search_path (ALTER ROLE ... SET search_path, which
    sql/00_extensions.sql sets), so tests see exactly what a login as that role sees. Plain SQL
    with no parameters (role is one of SERVICE_ROLES), so it runs on psycopg and asyncpg."""
    if role not in SERVICE_ROLES:
        raise ValueError(f"not a service role: {role!r}")
    return ("SELECT set_config('search_path', substr(cfg, length('search_path=') + 1), false) "
            "FROM pg_db_role_setting s, unnest(s.setconfig) AS cfg "
            f"WHERE s.setrole = '{role}'::regrole AND s.setdatabase = 0 "
            "AND starts_with(cfg, 'search_path=')")


def sync_url() -> str:
    assert TEST_DATABASE_URL, "TEST_DATABASE_URL not set"
    url = make_url(TEST_DATABASE_URL).set(drivername="postgresql+psycopg")
    return url.render_as_string(hide_password=False)


def switch_to_role(engine: Engine, role: str, *, require_search_path: bool = True) -> None:
    """Every new connection of ``engine`` becomes ``role`` before it is used.

    ``require_search_path``: the role must have its own configured search_path (shri_app,
    shri_integration and shri_reporting do). shri_fhir_reader has none by design, so its
    connections keep the login default, exactly as a real login would.

    Committed straight away: a SET inside a transaction that later rolls back is undone.
    """
    search_path_sql = _role_search_path_sql(role)

    @event.listens_for(engine, "connect")
    def _as_role(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute(search_path_sql)
            if cursor.fetchone() is None and require_search_path:
                raise RuntimeError(f"{role} has no search_path setting; run "
                                   "sql/00_extensions.sql on this database first")
            cursor.execute(f"SET ROLE {role}")
            cursor.execute("SELECT current_user")
            row = cursor.fetchone()
        finally:
            cursor.close()
        dbapi_connection.commit()
        if row is None or row[0] != role:
            raise RuntimeError(f"connection is not running as {role}: {row!r}")


def switch_to_app_role(engine: Engine) -> None:
    switch_to_role(engine, APP_ROLE)


@pytest.fixture(scope="session")
def admin_engine() -> Iterator[Engine]:
    eng = create_engine(sync_url())
    yield eng
    eng.dispose()


@pytest.fixture(scope="session")
def app_engine() -> Iterator[Engine]:
    # NullPool: a session-level tenant setting can never leak into another test's connection.
    eng = create_engine(sync_url(), poolclass=NullPool)
    switch_to_app_role(eng)
    yield eng
    eng.dispose()


def make_tenant(admin_engine: Engine, slug: str | None = None) -> uuid.UUID:
    tid = uuid.uuid4()
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.tenant (id, slug, name) VALUES (:i, :s, :n)"),
                  {"i": tid, "s": slug or f"t-{tid.hex[:12]}", "n": "Test practice"})
    return tid


def open_session(app_engine: Engine, tenant_id: uuid.UUID,
                 user_id: uuid.UUID | None = None) -> Session:
    """A session pinned to one connection with the tenant set for the whole connection, so
    tests can commit (deferred triggers fire at commit) and keep working."""
    s = Session(bind=app_engine.connect(), join_transaction_mode="rollback_only")
    s.info["tenant_id"] = tenant_id
    s.execute(text("SELECT set_config('app.current_tenant_id', :t, false), "
                   "set_config('app.current_user_id', :u, false)"),
              {"t": str(tenant_id), "u": str(user_id or "")})
    return s


@pytest.fixture
def tenant(admin_engine: Engine) -> uuid.UUID:
    return make_tenant(admin_engine)


@pytest.fixture
def db(app_engine: Engine, tenant: uuid.UUID) -> Iterator[Session]:
    s = open_session(app_engine, tenant)
    yield s
    s.rollback()
    conn = s.bind
    s.close()
    conn.close()  # type: ignore[union-attr]
