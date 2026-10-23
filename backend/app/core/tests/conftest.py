from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture
def make_app() -> Callable[..., FastAPI]:
    def _make(**overrides: Any) -> FastAPI:
        values: dict[str, Any] = {"environment": "test", "auth_mode": "dev_header"}
        values.update(overrides)
        return create_app(Settings(**values))

    return _make


@pytest.fixture
def client(make_app: Callable[..., FastAPI]) -> TestClient:
    return TestClient(make_app(), raise_server_exceptions=False)
