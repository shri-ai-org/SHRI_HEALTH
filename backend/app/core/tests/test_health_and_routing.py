from collections.abc import Callable

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.routing import module_names


def test_health_at_root_needs_no_login(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_and_ready_are_not_under_the_api_version(client: TestClient) -> None:
    assert client.get("/api/v1/health").status_code == 404
    assert client.get("/api/v1/ready").status_code == 404


def test_not_ready_without_database(client: TestClient) -> None:
    response = client.get("/ready")

    assert response.status_code == 503
    assert response.headers["content-type"] == "application/problem+json"
    assert response.headers["Retry-After"] == "5"
    assert response.json()["code"] == "service-unavailable"


def test_not_ready_when_database_unreachable(make_app: Callable[..., FastAPI]) -> None:
    app = make_app(database_url="postgresql+asyncpg://nobody:pw@127.0.0.1:1/none")
    response = TestClient(app).get("/ready")

    assert response.status_code == 503
    assert "127.0.0.1" not in response.text


def test_module_routers_are_discovered() -> None:
    names = module_names()
    assert "medications" in names
    assert "orders" in names


def test_docs_served_under_api_prefix_outside_production(client: TestClient) -> None:
    assert client.get("/api/v1/openapi.json").status_code == 200


def test_no_docs_in_production(make_app: Callable[..., FastAPI]) -> None:
    client = TestClient(make_app(environment="production", auth_mode="keycloak"))
    assert client.get("/api/v1/openapi.json").status_code == 404
    assert client.get("/api/v1/docs").status_code == 404
