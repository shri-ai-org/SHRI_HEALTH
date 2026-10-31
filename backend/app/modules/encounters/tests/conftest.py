"""Fixtures for the encounter tests: the in-memory app (fakes.py) for the API tests, and, for the
live tests, scheduling's practice, users and clients (a fresh clinic per test, shri_app, the real
core), since a rooming encounter starts at check-in (D16). Both apps carry the routes that wait
for core's T50 permissions, granted as T50 proposes them (pending_permissions.py). Synthetic data
only."""

from collections.abc import Callable, Iterator

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.deps import CurrentUser, current_user, tenant_db
from app.main import create_app
from app.modules.scheduling.tests import pending_permissions
from app.modules.scheduling.tests.conftest import (  # noqa: F401
    client,
    pending_client,
    practice,
    users,
)

from .. import api
from .fakes import (
    FakeLinks,
    FakeOperations,
    FakeRepository,
    FakeSession,
    FakeStore,
    FakeSummaryStore,
    World,
)


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def fake_app(world: World, monkeypatch: pytest.MonkeyPatch) -> Iterator[FastAPI]:
    pending_permissions.grant(monkeypatch)
    application = create_app(Settings(environment="test", auth_mode="dev_header"))
    pending_permissions.mount(application)

    async def fake_db(user: CurrentUser = Depends(current_user)) -> FakeSession:
        return FakeSession(user.organization_id)

    application.dependency_overrides[tenant_db] = fake_db
    application.dependency_overrides[api.repository] = lambda: FakeRepository(world)
    application.dependency_overrides[api.fhir_store] = lambda: FakeStore(world)
    application.dependency_overrides[api.chart_check] = lambda: world.chart_check
    application.dependency_overrides[api.chart_openable] = lambda: world.chart_open
    application.dependency_overrides[api.audit_patients] = lambda: world.audit
    application.dependency_overrides[api.facility_rooms] = lambda: world.rooms
    application.dependency_overrides[api.summary_operations] = lambda: FakeOperations(world)
    application.dependency_overrides[api.summary_store] = lambda: FakeSummaryStore(world)
    application.dependency_overrides[api.summary_links] = lambda: FakeLinks()
    application.dependency_overrides[api.summary_files] = lambda: (lambda: None)
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def as_user(fake_app: FastAPI) -> Callable[[str], TestClient]:
    def make(name: str) -> TestClient:
        c = TestClient(fake_app, raise_server_exceptions=False)
        c.headers["X-Dev-User"] = name
        return c
    return make
