"""An app per test with the in-memory repository, partner, chart check and audit hook (fakes.py)
and the refill requests' stand-ins (refill_fakes.py), a client per development user (X-Dev-User;
core/deps.py), and one per test patient for the portal (X-Dev-Patient, D108). Synthetic data
only."""

from collections.abc import Callable, Iterator

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.deps import (
    DEV_USERS,
    CurrentUser,
    PortalPatient,
    current_user,
    portal_db,
    portal_session,
    tenant_db,
)
from app.main import create_app
from app.modules.scheduling.tests.portal_live import portal_app, portal_chart  # noqa: F401

from .. import api, partner, portal_api
from .fakes import (
    FakePartner,
    FakeSession,
    World,
    fake_chart_check,
    recording_audit,
)
from .refill_fakes import (
    FakeRefillRepository,
    FakeRefills,
    Refills,
    fake_chart_view,
    fake_summaries,
    recording_publish,
)


@pytest.fixture
def world() -> World:
    found = World()
    for name in ("md", "app"):  # the prescribers are practitioners; ma and rn are not here
        found.practitioners[DEV_USERS[name].id] = DEV_USERS[name].id
    return found


@pytest.fixture
def refills(world: World) -> Refills:
    return Refills(world)


@pytest.fixture
def app(world: World, refills: Refills) -> Iterator[FastAPI]:
    application = create_app(Settings(environment="test", auth_mode="dev_header",
                                      patient_auth_mode="dev_header"))
    sessions: list[FakeSession] = []

    async def fake_db(user: CurrentUser = Depends(current_user)) -> FakeSession:
        session = FakeSession(user.organization_id, user_id=user.id)
        sessions.append(session)
        return session

    async def fake_portal_db(patient: PortalPatient = Depends(portal_session)) -> FakeSession:
        session = FakeSession(patient.organization_id, patient_id=patient.patient_id)
        sessions.append(session)
        return session

    application.state.fake_sessions = sessions
    application.dependency_overrides[tenant_db] = fake_db
    application.dependency_overrides[portal_db] = fake_portal_db
    application.dependency_overrides[api.repository] = lambda: FakeRefillRepository(world,
                                                                                    refills)
    application.dependency_overrides[partner.partner] = lambda: FakePartner(world)
    application.dependency_overrides[api.chart_check] = lambda: fake_chart_check(world)
    application.dependency_overrides[api.audit_hook] = lambda: recording_audit(world)
    application.dependency_overrides[api.refill_reads] = lambda: FakeRefills(refills)
    application.dependency_overrides[api.refill_store] = lambda: FakeRefills(refills)
    application.dependency_overrides[api.chart_view] = lambda: fake_chart_view(world)
    application.dependency_overrides[api.patient_summaries] = lambda: fake_summaries(world)
    application.dependency_overrides[portal_api.portal_refill_reads] = (
        lambda: FakeRefills(refills))
    application.dependency_overrides[portal_api.portal_refill_store] = (
        lambda: FakeRefills(refills))
    application.dependency_overrides[portal_api.refill_events] = (
        lambda: recording_publish(refills))
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[str], TestClient]:
    def client(name: str) -> TestClient:
        c = TestClient(app, raise_server_exceptions=False)
        c.headers["X-Dev-User"] = name
        return c
    return client
