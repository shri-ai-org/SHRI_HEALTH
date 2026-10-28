"""An app per test with the in-memory repository (fakes.py) in place of the SQL one and of
tenant_db, and a client per development user (X-Dev-User; core/deps.py). Synthetic data only."""

from collections.abc import Callable, Iterator

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.deps import CurrentUser, current_user, tenant_db
from app.main import create_app

from .. import api
from .fakes import FakeRepository, FakeSession, World


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
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[str], TestClient]:
    def client(name: str) -> TestClient:
        c = TestClient(app, raise_server_exceptions=False)
        c.headers["X-Dev-User"] = name
        return c
    return client
