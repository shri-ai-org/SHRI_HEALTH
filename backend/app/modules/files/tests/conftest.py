"""An app per test with the in-memory session, repository, store, scanner, encryption,
operations and core's download tokens (fakes.py), and a client per development user (X-Dev-User;
core/deps.py). Synthetic data only."""

from collections.abc import Callable, Iterator

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core import download_tokens as core_tokens
from app.core.config import Settings
from app.core.deps import CurrentUser, current_user, tenant_db
from app.core.download_tokens import DownloadTokens
from app.main import create_app

from .. import api, crypto, operations, scanner, storage
from .fakes import (
    FakeFileCrypto,
    FakeOperations,
    FakeRepository,
    FakeScanner,
    FakeSession,
    MemoryFileStore,
    World,
    download_tokens,
)


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def store() -> MemoryFileStore:
    return MemoryFileStore()


@pytest.fixture
def fake_scanner() -> FakeScanner:
    return FakeScanner()


@pytest.fixture
def fake_crypto() -> FakeFileCrypto:
    return FakeFileCrypto()


@pytest.fixture
def fake_operations() -> FakeOperations:
    return FakeOperations()


@pytest.fixture
def fake_tokens() -> DownloadTokens:
    return download_tokens()


@pytest.fixture
def app(world: World, store: MemoryFileStore, fake_scanner: FakeScanner,
        fake_crypto: FakeFileCrypto, fake_operations: FakeOperations,
        fake_tokens: DownloadTokens) -> Iterator[FastAPI]:
    application = create_app(Settings(environment="test", auth_mode="dev_header"))

    async def fake_db(user: CurrentUser = Depends(current_user)) -> FakeSession:
        session = FakeSession(user.organization_id)
        world.sessions.append(session)
        return session

    application.dependency_overrides[tenant_db] = fake_db
    application.dependency_overrides[api.repository] = lambda: FakeRepository(world)
    application.dependency_overrides[storage.file_store] = lambda: store
    application.dependency_overrides[scanner.scanner] = lambda: fake_scanner
    application.dependency_overrides[crypto.file_crypto] = lambda: fake_crypto
    application.dependency_overrides[operations.operations] = lambda: fake_operations
    application.dependency_overrides[api.patient_audit] = lambda: (
        lambda request, patient_ids: world.audited.append(list(patient_ids)))
    application.dependency_overrides[core_tokens.download_tokens] = lambda: fake_tokens
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[str], TestClient]:
    def client(name: str) -> TestClient:
        c = TestClient(app, raise_server_exceptions=False)
        c.headers["X-Dev-User"] = name
        return c
    return client
