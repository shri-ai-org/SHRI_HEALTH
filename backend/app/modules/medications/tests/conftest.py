"""An app per test with the in-memory repository, partner, chart check and audit hook (fakes.py),
and a client per development user (X-Dev-User; core/deps.py). Synthetic data only."""

from collections.abc import Callable, Iterator

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.deps import DEV_USERS, CurrentUser, current_user, tenant_db
from app.main import create_app

from .. import api, partner
from .fakes import (
    FakePartner,
    FakeRepository,
    FakeSession,
    World,
    fake_chart_check,
    recording_audit,
)


@pytest.fixture
def world() -> World:
    found = World()
    for name in ("md", "app"):  # the prescribers are practitioners; ma and rn are not here
        found.practitioners[DEV_USERS[name].id] = DEV_USERS[name].id
    return found


@pytest.fixture
def app(world: World) -> Iterator[FastAPI]:
    application = create_app(Settings(environment="test", auth_mode="dev_header"))
    sessions: list[FakeSession] = []

    async def fake_db(user: CurrentUser = Depends(current_user)) -> FakeSession:
        session = FakeSession(user.organization_id)
        sessions.append(session)
        return session

    application.state.fake_sessions = sessions
    application.dependency_overrides[tenant_db] = fake_db
    application.dependency_overrides[api.repository] = lambda: FakeRepository(world)
    application.dependency_overrides[partner.partner] = lambda: FakePartner(world)
    application.dependency_overrides[api.chart_check] = lambda: fake_chart_check(world)
    application.dependency_overrides[api.audit_hook] = lambda: recording_audit(world)
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[str], TestClient]:
    def client(name: str) -> TestClient:
        c = TestClient(app, raise_server_exceptions=False)
        c.headers["X-Dev-User"] = name
        return c
    return client
