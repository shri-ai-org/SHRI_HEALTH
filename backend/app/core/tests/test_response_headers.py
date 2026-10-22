from collections.abc import Callable

import pytest
from fastapi import APIRouter, FastAPI, Response
from fastapi.testclient import TestClient


def _client(make_app: Callable[..., FastAPI]) -> TestClient:
    router = APIRouter()

    @router.get("/ok")
    async def ok() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/own-cache")
    async def own_cache(response: Response) -> None:
        response.headers["Cache-Control"] = "private, max-age=60"

    @router.get("/crash")
    async def crash() -> None:
        raise RuntimeError("boom")

    app = make_app()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("path", ["/ok", "/health", "/ready", "/nowhere", "/crash"])
def test_every_response_is_no_store(make_app: Callable[..., FastAPI], path: str) -> None:
    assert _client(make_app).get(path).headers["Cache-Control"] == "no-store"


def test_endpoint_may_set_its_own_cache_control(make_app: Callable[..., FastAPI]) -> None:
    assert _client(make_app).get("/own-cache").headers["Cache-Control"] == "private, max-age=60"
