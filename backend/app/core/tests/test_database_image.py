"""The local and CI database matches what was agreed for production (ADR-0012; D23, D24, D31, D33).

Runs against infra/compose/postgres, opted in with TEST_DATABASE_IMAGE=shri (CI sets it), and
TEST_DATABASE_URL as that database's superuser. Skipped otherwise.
"""

import asyncio
import os
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

ADMIN_URL = os.environ.get("TEST_DATABASE_URL")
SERVICE_ROLES = ["shri_app", "shri_fhir_reader", "shri_integration", "shri_migrator",
                 "shri_reporting"]

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(
        not ADMIN_URL or os.environ.get("TEST_DATABASE_IMAGE") != "shri",
        reason="needs TEST_DATABASE_URL and TEST_DATABASE_IMAGE=shri",
    ),
]


def _query(sql: str) -> list[Any]:
    async def run() -> list[Any]:
        assert ADMIN_URL
        engine = create_async_engine(ADMIN_URL)
        async with engine.connect() as conn:
            rows = list((await conn.execute(text(sql))).all())
        await engine.dispose()
        return rows

    return asyncio.run(run())


def test_postgresql_18() -> None:
    [(version,)] = _query("SHOW server_version_num")
    assert int(version) // 10000 == 18


def test_pgvector_is_the_rds_version() -> None:
    assert _query("SELECT default_version FROM pg_available_extensions WHERE name = 'vector'") == [
        ("0.8.2",)
    ]


def test_data_checksums_on() -> None:
    assert _query("SHOW data_checksums") == [("on",)]


def test_scram_only() -> None:
    assert _query("SHOW password_encryption") == [("scram-sha-256",)]
    methods = {row[0] for row in _query("SELECT auth_method FROM pg_hba_file_rules")}
    assert methods == {"scram-sha-256"}


def test_utc() -> None:
    assert _query("SHOW timezone") == [("UTC",)]


def test_c_utf8_collation() -> None:
    assert _query(
        "SELECT datlocprovider::text, datlocale FROM pg_database "
        "WHERE datname = current_database()"
    ) == [("b", "C.UTF-8")]


def test_service_roles_cannot_bypass_rls() -> None:
    rows = _query(
        "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles "
        "WHERE rolname LIKE 'shri\\_%' ORDER BY rolname"
    )
    assert [r[0] for r in rows] == SERVICE_ROLES
    assert all(not r.rolsuper and not r.rolbypassrls and r.rolcanlogin for r in rows)


def test_migrator_owns_the_database_and_the_api_does_not() -> None:
    assert _query(
        "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()"
    ) == [("shri_migrator",)]
