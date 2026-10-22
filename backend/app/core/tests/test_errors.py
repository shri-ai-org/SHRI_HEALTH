from collections.abc import Callable

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.core.errors import AppError, Conflict, Forbidden, NotFound, ValidationFailed


class Body(BaseModel):
    date_of_birth: int


def _client(make_app: Callable[..., FastAPI]) -> TestClient:
    router = APIRouter()

    @router.get("/raise/{kind}")
    async def raise_error(kind: str) -> None:
        errors: dict[str, AppError] = {
            "not-found": NotFound("Patient not found"),
            "conflict": Conflict("Version changed", current_version=3),
            "forbidden": Forbidden(),
            "validation": ValidationFailed("Dose out of range"),
        }
        raise errors[kind]

    @router.get("/crash")
    async def crash() -> None:
        raise RuntimeError("secret internal detail")

    @router.post("/echo")
    async def echo(body: Body) -> Body:
        return body

    app = make_app()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    ("kind", "status", "title"),
    [
        ("not-found", 404, "Not Found"),
        ("conflict", 409, "Conflict"),
        ("forbidden", 403, "Forbidden"),
        ("validation", 422, "Unprocessable Content"),
    ],
)
def test_app_errors_become_problem_json(
    make_app: Callable[..., FastAPI], kind: str, status: int, title: str
) -> None:
    response = _client(make_app).get(f"/raise/{kind}")

    assert response.status_code == status
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["status"] == status
    assert body["title"] == title
    assert body["type"] == "about:blank"
    assert body["instance"] == f"/raise/{kind}"


def test_extra_fields_are_included(make_app: Callable[..., FastAPI]) -> None:
    body = _client(make_app).get("/raise/conflict").json()
    assert body["detail"] == "Version changed"
    assert body["current_version"] == 3


def test_validation_errors_never_echo_submitted_values(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).post("/echo", json={"date_of_birth": "1970-01-31 SECRET"})

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"
    assert "SECRET" not in response.text
    assert response.json()["errors"][0]["loc"] == ["body", "date_of_birth"]


def test_unhandled_errors_hide_details(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).get("/crash")

    assert response.status_code == 500
    assert response.json() == {
        "type": "about:blank", "title": "Internal Server Error", "status": 500, "instance": "/crash"
    }
    assert "secret" not in response.text


def test_unknown_route_is_problem_json(client: TestClient) -> None:
    response = client.get("/api/v1/nothing-here")

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
