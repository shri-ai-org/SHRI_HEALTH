"""tenant_db against a real PostgreSQL with row-level security (DECISIONS D21, D23).

Needs TEST_DATABASE_URL pointing at a throwaway database as a superuser, e.g.
postgresql+asyncpg://postgres:postgres@localhost:5432/postgres. Skipped otherwise.
The API side connects as a role like shri_app: no superuser, no BYPASSRLS.
"""

import asyncio
import os
from collections.abc import Callable, Iterator
from secrets import token_hex
from typing import Any

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.db import CORRELATION_SETTING, TENANT_SETTING, USER_SETTING
from app.core.deps import (
    CLINIC_A,
    CLINIC_B,
    DEV_USER_HEADER,
    DEV_USERS,
    CurrentUser,
    current_user,
    require,
    tenant_db,
)

CHECKED = Depends(require("authenticated"))

ADMIN_URL = os.environ.get("TEST_DATABASE_URL")
ROLE = "shri_rls_test_api"
REQUEST_ID = "0b7e4b0c-3f4e-4d3a-9d0e-0c1b5e2f9a11"

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not ADMIN_URL, reason="TEST_DATABASE_URL not set"),
]

TEARDOWN = [
    "DROP TABLE IF EXISTS rls_probe",
    "DROP TABLE IF EXISTS rls_commit_log",
    "DROP FUNCTION IF EXISTS rls_log_settings()",
    f"DROP OWNED BY {ROLE}",
    f"DROP ROLE IF EXISTS {ROLE}",
]

# Same shape as the schema's policies (Sam's sql/90_rls_grants.sql): NULLIF because a
# transaction-local setting reads back as '' (not NULL) on a pooled connection afterwards.
POLICY = f"tenant_id = NULLIF(current_setting('{TENANT_SETTING}', true), '')::uuid"
SETUP = [
    "CREATE TABLE rls_probe (tenant_id uuid NOT NULL, label text NOT NULL)",
    "ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE rls_probe FORCE ROW LEVEL SECURITY",
    f"CREATE POLICY tenant_isolation ON rls_probe USING ({POLICY}) WITH CHECK ({POLICY})",
    f"INSERT INTO rls_probe VALUES ('{CLINIC_A}', 'a-1'), ('{CLINIC_A}', 'a-2'), "
    f"('{CLINIC_B}', 'b-1')",
    # A trigger that fires at COMMIT records the three settings it can see.
    "CREATE TABLE rls_commit_log (tenant text, app_user text, correlation text)",
    f"""CREATE FUNCTION rls_log_settings() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            INSERT INTO rls_commit_log VALUES (
                current_setting('{TENANT_SETTING}', true),
                current_setting('{USER_SETTING}', true),
                current_setting('{CORRELATION_SETTING}', true));
            RETURN NULL;
        END $$""",
    "CREATE CONSTRAINT TRIGGER rls_probe_at_commit AFTER INSERT ON rls_probe "
    "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rls_log_settings()",
]


async def _run(url: str, statements: list[str]) -> list[Any]:
    engine = create_async_engine(url)
    rows: list[Any] = []
    async with engine.begin() as conn:
        for statement in statements:
            result = await conn.execute(text(statement))
            if result.returns_rows:
                rows = list(result.all())
    await engine.dispose()
    return rows


async def _teardown(url: str) -> None:
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        exists = (await conn.execute(
            text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": ROLE})).first()
        for statement in TEARDOWN:
            if statement.startswith("DROP OWNED") and not exists:
                continue
            await conn.execute(text(statement))
    await engine.dispose()


@pytest.fixture
def api_database_url() -> Iterator[str]:
    assert ADMIN_URL
    password = token_hex(16)
    asyncio.run(_teardown(ADMIN_URL))
    database = make_url(ADMIN_URL).database
    asyncio.run(_run(ADMIN_URL, [
        *SETUP,
        f"CREATE ROLE {ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{password}'",
        # Our database image revokes CONNECT and schema access from PUBLIC; every role is granted
        # them explicitly, as Anand's migrations do for the service roles.
        f'GRANT CONNECT ON DATABASE "{database}" TO {ROLE}',
        f"GRANT USAGE ON SCHEMA public TO {ROLE}",
        f"GRANT SELECT, INSERT ON rls_probe TO {ROLE}",
        f"GRANT INSERT ON rls_commit_log TO {ROLE}",
    ]))
    yield make_url(ADMIN_URL).set(username=ROLE, password=password).render_as_string(False)
    asyncio.run(_teardown(ADMIN_URL))


def _app(
    make_app: Callable[..., FastAPI], database_url: str, **settings_overrides: str
) -> FastAPI:
    router = APIRouter()

    async def labels(db: AsyncSession) -> list[str]:
        rows = await db.execute(text("SELECT label FROM rls_probe ORDER BY label"))
        return list(rows.scalars())

    @router.get("/probe")
    async def probe(_: CurrentUser = CHECKED, db: AsyncSession = Depends(tenant_db)) -> list[str]:
        return await labels(db)

    @router.get("/probe/settings")
    async def settings(
        _: CurrentUser = CHECKED, db: AsyncSession = Depends(tenant_db)
    ) -> list[str]:
        row = (await db.execute(text(
            f"SELECT current_setting('{TENANT_SETTING}', true), "
            f"current_setting('{USER_SETTING}', true), "
            f"current_setting('{CORRELATION_SETTING}', true)"))).one()
        return list(row)

    @router.post("/probe/{label}")
    async def add_then_read(
        label: str, _: CurrentUser = CHECKED, db: AsyncSession = Depends(tenant_db)
    ) -> list[str]:
        await db.execute(
            text(f"INSERT INTO rls_probe VALUES ("
                 f"NULLIF(current_setting('{TENANT_SETTING}', true), '')::uuid, :label)"),
            {"label": label},
        )
        await db.commit()  # the deferred trigger fires here
        return await labels(db)  # new transaction: the settings must be set again

    @router.get("/probe-unchecked")
    async def unchecked(db: AsyncSession = Depends(tenant_db)) -> list[str]:
        return await labels(db)  # forgot require(): must be refused

    @router.get("/probe-db-first")
    async def db_first(
        db: AsyncSession = Depends(tenant_db), _: CurrentUser = Depends(require("patients:read"))
    ) -> list[str]:
        return await labels(db)

    @router.get("/probe-no-tenant")
    async def no_tenant() -> list[str]:
        async with app.state.db.sessions() as db:
            return await labels(db)

    app = make_app(database_url=database_url, **settings_overrides)
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


def test_the_three_settings_are_set(
    make_app: Callable[..., FastAPI], api_database_url: str
) -> None:
    with TestClient(_app(make_app, api_database_url)) as client:
        response = client.get(
            "/probe/settings", headers={DEV_USER_HEADER: "md-b", "X-Request-ID": REQUEST_ID}
        )

    assert response.json() == [str(CLINIC_B), str(DEV_USERS["md-b"].id), REQUEST_ID]


def test_settings_last_until_commit_time_triggers(
    make_app: Callable[..., FastAPI], api_database_url: str
) -> None:
    assert ADMIN_URL
    with TestClient(_app(make_app, api_database_url)) as client:
        response = client.post(
            "/probe/b-2", headers={DEV_USER_HEADER: "md-b", "X-Request-ID": REQUEST_ID}
        )
    logged = asyncio.run(
        _run(ADMIN_URL, ["SELECT tenant, app_user, correlation FROM rls_commit_log"])
    )

    assert response.json() == ["b-1", "b-2"]  # and the clinic is set again after the commit
    assert [tuple(row) for row in logged] == [
        (str(CLINIC_B), str(DEV_USERS["md-b"].id), REQUEST_ID)
    ]


def test_clinic_never_comes_from_client_headers(
    make_app: Callable[..., FastAPI], api_database_url: str
) -> None:
    with TestClient(_app(make_app, api_database_url)) as client:
        response = client.get("/probe", headers={
            DEV_USER_HEADER: "md",
            "X-Tenant-Id": str(CLINIC_B),
            "X-Organization-Id": str(CLINIC_B),
            "X-Clinic-Id": str(CLINIC_B),
        })

    assert response.json() == ["a-1", "a-2"]


def test_request_without_a_session_sees_zero_rows(
    make_app: Callable[..., FastAPI], api_database_url: str
) -> None:
    with TestClient(_app(make_app, api_database_url)) as client:
        client.get("/probe", headers={DEV_USER_HEADER: "md"})  # leaves a pooled connection
        no_session = client.get("/probe")
        no_clinic = client.get("/probe-no-tenant")

    assert no_session.status_code == 401
    assert "a-1" not in no_session.text
    assert no_clinic.json() == []  # no clinic set: row-level security returns nothing


def test_ready_with_a_safe_role(make_app: Callable[..., FastAPI], api_database_url: str) -> None:
    with TestClient(make_app(database_url=api_database_url)) as client:
        response = client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_not_ready_when_the_role_can_bypass_rls(make_app: Callable[..., FastAPI]) -> None:
    assert ADMIN_URL  # a superuser: exactly what the API must never connect as
    with TestClient(make_app(database_url=ADMIN_URL)) as client:
        response = client.get("/ready")

    assert response.status_code == 503
    assert response.json()["code"] == "service-unavailable"


def test_tenant_db_without_require_fails_loudly_in_development(
    make_app: Callable[..., FastAPI], api_database_url: str
) -> None:
    with TestClient(_app(make_app, api_database_url), raise_server_exceptions=False) as client:
        response = client.get("/probe-unchecked", headers={DEV_USER_HEADER: "md"})

    assert response.status_code == 500
    assert "a-1" not in response.text


def test_tenant_db_without_require_is_403_outside_development(
    make_app: Callable[..., FastAPI], api_database_url: str
) -> None:
    app = _app(make_app, api_database_url, environment="production", auth_mode="keycloak")
    app.dependency_overrides[current_user] = lambda: DEV_USERS["md"]  # a signed-in user
    with TestClient(app) as client:
        response = client.get("/probe-unchecked")

    assert response.status_code == 403
    assert response.json()["code"] == "permission-denied"


def test_dependency_order_does_not_matter(
    make_app: Callable[..., FastAPI], api_database_url: str
) -> None:
    with TestClient(_app(make_app, api_database_url)) as client:
        allowed = client.get("/probe-db-first", headers={DEV_USER_HEADER: "md"})
        denied = client.get("/probe-db-first", headers={DEV_USER_HEADER: "sup"})

    assert allowed.json() == ["a-1", "a-2"]
    assert denied.status_code == 403

