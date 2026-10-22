"""tenant_db against a real PostgreSQL with row-level security.

Needs TEST_DATABASE_URL pointing at a throwaway database as a superuser, e.g.
postgresql+asyncpg://postgres:postgres@localhost:5432/postgres. Skipped otherwise.
"""

import asyncio
import os
from collections.abc import Callable, Iterator
from secrets import token_hex

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USER_HEADER, tenant_db

ADMIN_URL = os.environ.get("TEST_DATABASE_URL")
SETTING = "app.current_organization_id"
ROLE = "shri_rls_test_api"

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not ADMIN_URL, reason="TEST_DATABASE_URL not set"),
]

# Same shape as the schema's policies: NULLIF because a transaction-local setting reads
# back as '' (not NULL) on a pooled connection after an earlier transaction used it.
SETUP = [
    f"DROP TABLE IF EXISTS rls_probe; DROP ROLE IF EXISTS {ROLE}",
    "CREATE TABLE rls_probe (organization_id uuid NOT NULL, label text NOT NULL)",
    "ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE rls_probe FORCE ROW LEVEL SECURITY",
    f"CREATE POLICY tenant ON rls_probe USING "
    f"(organization_id = NULLIF(current_setting('{SETTING}', true), '')::uuid)",
    f"INSERT INTO rls_probe VALUES ('{CLINIC_A}', 'a-1'), ('{CLINIC_A}', 'a-2'), "
    f"('{CLINIC_B}', 'b-1')",
]


async def _run(url: str, statements: list[str]) -> None:
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        for statement in statements:
            for part in statement.split("; "):
                await conn.execute(text(part))
    await engine.dispose()


@pytest.fixture
def api_database_url() -> Iterator[str]:
    assert ADMIN_URL
    password = token_hex(16)
    asyncio.run(_run(ADMIN_URL, [
        *SETUP,
        f"CREATE ROLE {ROLE} LOGIN PASSWORD '{password}' NOSUPERUSER NOBYPASSRLS",
        f"GRANT SELECT, INSERT ON rls_probe TO {ROLE}",
    ]))
    yield make_url(ADMIN_URL).set(username=ROLE, password=password).render_as_string(False)
    asyncio.run(_run(ADMIN_URL, [f"DROP TABLE IF EXISTS rls_probe; DROP ROLE IF EXISTS {ROLE}"]))


def _app(make_app: Callable[..., FastAPI], database_url: str) -> FastAPI:
    router = APIRouter()

    async def labels(db: AsyncSession) -> list[str]:
        rows = await db.execute(text("SELECT label FROM rls_probe ORDER BY label"))
        return list(rows.scalars())

    @router.get("/probe")
    async def probe(db: AsyncSession = Depends(tenant_db)) -> list[str]:
        return await labels(db)

    @router.post("/probe/{label}")
    async def add_then_read(label: str, db: AsyncSession = Depends(tenant_db)) -> list[str]:
        await db.execute(
            text(f"INSERT INTO rls_probe VALUES (NULLIF(current_setting('{SETTING}', true), '')"
                 "::uuid, :label)"),
            {"label": label},
        )
        await db.commit()
        return await labels(db)  # new transaction: clinic must be set again

    @router.get("/probe-no-tenant")
    async def no_tenant() -> list[str]:
        async with app.state.db.sessions() as db:
            return await labels(db)

    app = make_app(database_url=database_url)
    app.include_router(router)
    return app


def test_each_clinic_sees_only_its_own_rows(
    make_app: Callable[..., FastAPI], api_database_url: str
) -> None:
    with TestClient(_app(make_app, api_database_url)) as client:
        a = client.get("/probe", headers={DEV_USER_HEADER: "md"})
        b = client.get("/probe", headers={DEV_USER_HEADER: "md-b"})
        a_again = client.get("/probe", headers={DEV_USER_HEADER: "md"})

    assert a.json() == ["a-1", "a-2"]
    assert b.json() == ["b-1"]
    assert a_again.json() == ["a-1", "a-2"]


def test_clinic_is_set_again_after_commit(
    make_app: Callable[..., FastAPI], api_database_url: str
) -> None:
    with TestClient(_app(make_app, api_database_url)) as client:
        response = client.post("/probe/b-2", headers={DEV_USER_HEADER: "md-b"})

    assert response.status_code == 200
    assert response.json() == ["b-1", "b-2"]


def test_session_without_clinic_sees_nothing(
    make_app: Callable[..., FastAPI], api_database_url: str
) -> None:
    with TestClient(_app(make_app, api_database_url)) as client:
        client.get("/probe", headers={DEV_USER_HEADER: "md"})  # leaves a pooled connection
        response = client.get("/probe-no-tenant")

    assert response.json() == []


def test_ready_with_database(make_app: Callable[..., FastAPI], api_database_url: str) -> None:
    with TestClient(make_app(database_url=api_database_url)) as client:
        response = client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}
