"""GET /me without a database: who may call it, and the permissions it lists per role."""

from collections.abc import Callable

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import permissions
from app.core.deps import DEV_USER_HEADER


def test_unauthenticated_is_401(make_app: Callable[..., FastAPI]) -> None:
    response = TestClient(make_app(), raise_server_exceptions=False).get("/api/v1/me")

    assert response.status_code == 401
    assert response.json()["code"] == "unauthenticated"


def test_unknown_user_is_401(make_app: Callable[..., FastAPI]) -> None:
    client = TestClient(make_app(), raise_server_exceptions=False)

    response = client.get("/api/v1/me", headers={DEV_USER_HEADER: "nobody"})

    assert response.status_code == 401


def test_permissions_of_is_the_union_of_the_roles() -> None:
    fd, ma = permissions.ROLE_PERMISSIONS["FD"], permissions.ROLE_PERMISSIONS["MA"]

    assert permissions.permissions_of({"FD"}) == fd
    assert permissions.permissions_of({"FD", "MA"}) == fd | ma
    assert permissions.permissions_of(set()) == frozenset()
    assert permissions.permissions_of({"PAT"}) == frozenset()  # never a staff permission
