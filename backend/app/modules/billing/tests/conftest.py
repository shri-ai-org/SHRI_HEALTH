"""An app per test with the in-memory session, repository and file store (fakes.py), and a client
per development user (X-Dev-User; core/deps.py). Synthetic data only."""

from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.deps import CurrentUser, current_user, tenant_db
from app.main import create_app
from app.modules.files import storage

from .. import api
from .fakes import FakeRepository, FakeSession, MemoryFileStore, World


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def store() -> MemoryFileStore:
    return MemoryFileStore()


@pytest.fixture
def app(world: World, store: MemoryFileStore) -> Iterator[FastAPI]:
    application = create_app(Settings(environment="test", auth_mode="dev_header"))

    async def fake_db(user: CurrentUser = Depends(current_user)) -> FakeSession:
        session = FakeSession(user.organization_id)
        world.sessions.append(session)
        return session

    application.dependency_overrides[tenant_db] = fake_db
    application.dependency_overrides[api.repository] = lambda: FakeRepository(world)
    application.dependency_overrides[storage.file_store] = lambda: store
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[str], TestClient]:
    def client(name: str) -> TestClient:
        c = TestClient(app, raise_server_exceptions=False)
        c.headers["X-Dev-User"] = name
        return c
    return client


def cash(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"amount": {"value": "25.00", "currency": "USD"}, "method": "cash"}
    body.update(overrides)
    return body
