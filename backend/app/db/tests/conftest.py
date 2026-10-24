"""Live-database test fixtures.

Environment (defaults match tools/README "Run the tests"):
  SHRI_TEST_ADMIN_URL   superuser URL, used only to create tenants and inspect the catalog
  SHRI_DATABASE_URL     shri_app URL (the API role, subject to RLS)

The database must be migrated to head first (``alembic upgrade head``).
"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("SHRI_DATABASE_URL",
                      "postgresql+psycopg://shri_app@localhost:5432/shri_health_test")

import app.db.session  # noqa: E402,F401  (registers the tenant default hook)

ADMIN_URL = os.environ.get("SHRI_TEST_ADMIN_URL",
                           "postgresql+psycopg://postgres@localhost:5432/shri_health_test")
APP_URL = os.environ["SHRI_DATABASE_URL"]


@pytest.fixture(scope="session")
def admin_engine():
    eng = create_engine(ADMIN_URL)
    yield eng
    eng.dispose()


@pytest.fixture(scope="session")
def app_engine():
    # NullPool: a session-level tenant setting can never leak into another test's connection.
    eng = create_engine(APP_URL, poolclass=NullPool)
    yield eng
    eng.dispose()


def make_tenant(admin_engine, slug: str | None = None) -> uuid.UUID:
    tid = uuid.uuid4()
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.tenant (id, slug, name) VALUES (:i, :s, :n)"),
                  {"i": tid, "s": slug or f"t-{tid.hex[:12]}", "n": "Test practice"})
    return tid


def open_session(app_engine, tenant_id: uuid.UUID, user_id: uuid.UUID | None = None) -> Session:
    """A session pinned to one connection with the tenant set for the whole connection, so
    tests can commit (deferred triggers fire at commit) and keep working."""
    s = Session(bind=app_engine.connect(), join_transaction_mode="rollback_only")
    s.info["tenant_id"] = tenant_id
    s.execute(text("SELECT set_config('app.current_tenant_id', :t, false), "
                   "set_config('app.current_user_id', :u, false)"),
              {"t": str(tenant_id), "u": str(user_id or "")})
    return s


@pytest.fixture
def tenant(admin_engine) -> uuid.UUID:
    return make_tenant(admin_engine)


@pytest.fixture
def db(app_engine, tenant):
    s = open_session(app_engine, tenant)
    yield s
    s.rollback()
    conn = s.bind
    s.close()
    conn.close()
