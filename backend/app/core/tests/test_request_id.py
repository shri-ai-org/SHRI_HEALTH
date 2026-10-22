from collections.abc import Callable
from uuid import UUID

import pytest
from fastapi import APIRouter, FastAPI, Request
from fastapi.testclient import TestClient

from app.core.request_id import current_request_id, current_traceparent

TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


def _client(make_app: Callable[..., FastAPI]) -> TestClient:
    router = APIRouter()

    @router.get("/ids")
    async def ids(request: Request) -> dict[str, str | None]:
        return {
            "state": request.state.request_id,
            "context": current_request_id(),
            "traceparent": current_traceparent(),
        }

    app = make_app()
    app.include_router(router)
    return TestClient(app)


def test_request_id_is_generated(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).get("/ids")

    request_id = response.headers["X-Request-ID"]
    assert UUID(request_id)
    assert response.json()["state"] == request_id
    assert response.json()["context"] == request_id


def test_valid_client_request_id_is_kept(make_app: Callable[..., FastAPI]) -> None:
    sent = "0B7E4B0C-3F4E-4D3A-9D0E-0C1B5E2F9A11"
    response = _client(make_app).get("/ids", headers={"X-Request-ID": sent})
    assert response.headers["X-Request-ID"] == sent.lower()


@pytest.mark.parametrize("bad", ["hello", "x" * 200, "1234\nINJECTED log line"])
def test_invalid_client_request_id_is_replaced(make_app: Callable[..., FastAPI], bad: str) -> None:
    response = _client(make_app).get("/ids", headers={"X-Request-ID": bad})

    assert response.headers["X-Request-ID"] != bad
    assert UUID(response.headers["X-Request-ID"])


def test_request_id_on_health_and_errors(client: TestClient) -> None:
    assert UUID(client.get("/health").headers["X-Request-ID"])
    assert UUID(client.get("/nowhere").headers["X-Request-ID"])


def test_valid_traceparent_is_propagated(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).get("/ids", headers={"traceparent": TRACEPARENT})
    assert response.json()["traceparent"] == TRACEPARENT


@pytest.mark.parametrize(
    "bad", ["garbage", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"]
)
def test_invalid_traceparent_is_dropped(make_app: Callable[..., FastAPI], bad: str) -> None:
    response = _client(make_app).get("/ids", headers={"traceparent": bad})
    assert response.json()["traceparent"] is None
