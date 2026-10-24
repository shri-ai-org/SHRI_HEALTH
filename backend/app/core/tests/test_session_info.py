"""session.info["tenant_id"] for data-access helpers (Anand's hook in backend/app/db/).

No database needed: a session only connects at its first query, and these tests never query.
"""

from collections.abc import Callable
from uuid import UUID

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.db import TENANT_ID_INFO_KEY, Database
from app.core.deps import CLINIC_A, CLINIC_B, DEV_USER_HEADER, CurrentUser, require, tenant_db

UNREACHABLE_DB = "postgresql+asyncpg://nobody:pw@127.0.0.1:1/none"


def _database() -> Database:
    return Database(Settings(environment="test", database_url=UNREACHABLE_DB))


def test_tenant_session_publishes_the_clinic() -> None:
    session = _database().tenant_session(CLINIC_A, UUID(int=1))

    assert TENANT_ID_INFO_KEY == "tenant_id"
    assert session.info["tenant_id"] == CLINIC_A
    assert isinstance(session.info["tenant_id"], UUID)
    # Hooks such as before_flush receive the sync Session: it shares the same info dict.
    assert session.sync_session.info["tenant_id"] == CLINIC_A


def test_a_session_without_a_clinic_has_no_tenant_id() -> None:
    assert TENANT_ID_INFO_KEY not in _database().sessions().info


@pytest.mark.parametrize(("user", "clinic"), [("md", CLINIC_A), ("md-b", CLINIC_B)])
def test_tenant_db_session_carries_the_callers_clinic(
    make_app: Callable[..., FastAPI], user: str, clinic: UUID
) -> None:
    router = APIRouter()

    @router.get("/session-tenant")
    async def session_tenant(
        _: CurrentUser = Depends(require("authenticated")),
        db: AsyncSession = Depends(tenant_db),
    ) -> str:
        return str(db.info[TENANT_ID_INFO_KEY])

    app = make_app(database_url=UNREACHABLE_DB)
    app.include_router(router)
    with TestClient(app) as client:
        response = client.get(
            "/session-tenant",
            headers={DEV_USER_HEADER: user, "X-Tenant-Id": str(CLINIC_B)},  # ignored (D21)
        )

    assert response.json() == str(clinic)
