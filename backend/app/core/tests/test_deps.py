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
    async def submit_claim(user: CurrentUser = Depends(require("claims:submit"))) -> None:
        return None

    @router.get("/me")
    async def me(user: CurrentUser = Depends(require("authenticated"))) -> list[str]:
        return sorted(user.roles)

    @router.get("/db")
    async def uses_db(db: AsyncSession = Depends(tenant_db)) -> None:
        return None

    app = make_app(**settings)
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def test_missing_user_header_is_401(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).get("/whoami")

    assert response.status_code == 401
    assert response.json()["code"] == "unauthenticated"


def test_unknown_user_is_401(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).get("/whoami", headers={DEV_USER_HEADER: "mallory"})
    assert response.status_code == 401


def test_dev_header_ignored_when_stand_in_is_off(make_app: Callable[..., FastAPI]) -> None:
    client = _client(make_app, auth_mode="keycloak")
    assert client.get("/whoami", headers={DEV_USER_HEADER: "md"}).status_code == 401


@pytest.mark.parametrize(("user", "clinic"), [("md", CLINIC_A), ("md-b", CLINIC_B)])
def test_permitted_user_gets_through(
    make_app: Callable[..., FastAPI], user: str, clinic: object
) -> None:
    response = _client(make_app).get("/whoami", headers={DEV_USER_HEADER: user})

    assert response.status_code == 200
    assert response.json()["organization_id"] == str(clinic)


@pytest.mark.parametrize("user", ["none", "md", "sup"])
def test_missing_permission_is_403(make_app: Callable[..., FastAPI], user: str) -> None:
    response = _client(make_app).post("/claims", headers={DEV_USER_HEADER: user})

    assert response.status_code == 403
    assert response.json()["code"] == "permission-denied"


def test_role_with_permission_gets_through(make_app: Callable[..., FastAPI]) -> None:
    assert _client(make_app).post("/claims", headers={DEV_USER_HEADER: "bil"}).status_code == 200


def test_authenticated_needs_only_a_session(make_app: Callable[..., FastAPI]) -> None:
    client = _client(make_app)
    assert client.get("/me", headers={DEV_USER_HEADER: "none"}).json() == []
    assert client.get("/me").status_code == 401


@pytest.mark.parametrize(
    "bad", ["patients", "Patients:Read", "patients:read:all", "", "patients:fly", "public"]
)
def test_require_rejects_unknown_permission_names(bad: str) -> None:
    with pytest.raises(ValueError, match="Unknown permission"):
        require(bad)


def test_tenant_db_without_database_is_503(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).get("/db", headers={DEV_USER_HEADER: "md"})

    assert response.status_code == 503
    assert response.json()["code"] == "service-unavailable"


def test_tenant_db_needs_a_user(make_app: Callable[..., FastAPI]) -> None:
    assert _client(make_app).get("/db").status_code == 401
