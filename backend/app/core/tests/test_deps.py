from collections.abc import Callable

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USER_HEADER, CurrentUser, require, tenant_db


def _client(make_app: Callable[..., FastAPI], **settings: str) -> TestClient:
    router = APIRouter()

    @router.get("/whoami")
    async def whoami(user: CurrentUser = Depends(require("patients:read"))) -> dict[str, str]:
        return {"id": str(user.id), "organization_id": str(user.organization_id)}

    @router.post("/claims")
    async def submit_claim(user: CurrentUser = Depends(require("billing:write"))) -> None:
        return None

    @router.get("/db")
    async def uses_db(db: AsyncSession = Depends(tenant_db)) -> None:
        return None

    app = make_app(**settings)
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def test_missing_user_header_is_401(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).get("/whoami")

    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"


def test_unknown_user_is_401(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).get("/whoami", headers={DEV_USER_HEADER: "mallory"})
    assert response.status_code == 401


def test_dev_header_ignored_when_stand_in_is_off(make_app: Callable[..., FastAPI]) -> None:
    client = _client(make_app, auth_mode="keycloak")
    response = client.get("/whoami", headers={DEV_USER_HEADER: "platform-admin"})
    assert response.status_code == 401


@pytest.mark.parametrize(("user", "clinic"), [("doctor", CLINIC_A), ("doctor-b", CLINIC_B)])
def test_permitted_user_gets_through(
    make_app: Callable[..., FastAPI], user: str, clinic: object
) -> None:
    response = _client(make_app).get("/whoami", headers={DEV_USER_HEADER: user})

    assert response.status_code == 200
    assert response.json()["organization_id"] == str(clinic)


@pytest.mark.parametrize("user", ["no-access", "doctor"])
def test_missing_permission_is_403(make_app: Callable[..., FastAPI], user: str) -> None:
    response = _client(make_app).post("/claims", headers={DEV_USER_HEADER: user})

    assert response.status_code == 403
    assert response.json()["detail"] == "Missing permission billing:write"


def test_platform_admin_has_every_permission(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).post("/claims", headers={DEV_USER_HEADER: "platform-admin"})
    assert response.status_code == 200


@pytest.mark.parametrize("bad", ["patients", "Patients:Read", "patients:read:all", ""])
def test_require_rejects_malformed_permission_names(bad: str) -> None:
    with pytest.raises(ValueError, match="resource:action"):
        require(bad)


def test_tenant_db_without_database_is_503(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).get("/db", headers={DEV_USER_HEADER: "doctor"})
    assert response.status_code == 503


def test_tenant_db_needs_a_user(make_app: Callable[..., FastAPI]) -> None:
    assert _client(make_app).get("/db").status_code == 401
