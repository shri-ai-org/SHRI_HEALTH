"""An app per test with the in-memory database, write helpers and chart check (fakes.py), and a
client per development user (X-Dev-User; core/deps.py). Synthetic data only."""

from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.deps import CurrentUser, current_user, tenant_db
from app.main import create_app

from .. import access, api
from .fakes import (
    FakeRepository,
    FakeSession,
    FakeStore,
    World,
    fake_chart_check,
    recording_audit,
)


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def app(world: World) -> Iterator[FastAPI]:
    application = create_app(Settings(environment="test", auth_mode="dev_header"))

    async def fake_db(user: CurrentUser = Depends(current_user)) -> FakeSession:
        return FakeSession(user.organization_id)

    application.dependency_overrides[tenant_db] = fake_db
    application.dependency_overrides[api.repository] = lambda: FakeRepository(world)
    application.dependency_overrides[access.fhir_store] = lambda: FakeStore(world)
    application.dependency_overrides[access.chart_check] = lambda: fake_chart_check(world)
    application.dependency_overrides[access.audit_hooks] = lambda: recording_audit(world)
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[str], TestClient]:
    def client(name: str) -> TestClient:
        c = TestClient(app, raise_server_exceptions=False)
        c.headers["X-Dev-User"] = name
        return c
    return client


def new_patient(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": {"family": "Lindgren118", "given": ["Kaia401"]},
        "birthDate": "1990-03-14",
        "gender": "female",
        "phones": [{"number": "+12175550142", "use": "mobile"}],
    }
    body.update(overrides)
    return body
