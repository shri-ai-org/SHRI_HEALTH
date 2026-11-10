"""Fixtures for the AI tests: the database layer's engines (app/db/tests/conftest.py) for the
gateway's live tests, and, for the live API tests, scheduling's practice and users (a fresh
clinic per test) with an app on the test database as shri_app, where only the sign-in, the file
store (a folder) and the file encryption's key service (a fixed test key) are replaced: the
transcript files are sealed and opened with the file service's real AES-256-GCM. The model is a
real HTTP server in the test (stub_model_server.py). Synthetic data only."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.core.crypto import DataKey
from app.core.deps import DEV_USER_HEADER, CurrentUser, current_user
from app.db.tests.conftest import (  # noqa: F401
    TEST_DATABASE_URL,
    admin_engine,
    app_engine,
    switch_to_role,
)
from app.main import create_app
from app.modules.files import crypto, storage
from app.modules.scheduling.tests.conftest import practice, users  # noqa: F401

from .stub_claude_server import StubClaudeServer
from .stub_model_server import StubModelServer

#: A fixed data key for the tests' file encryption (never a real key).
TEST_KEY = bytes(range(32))


class FixedDataKeys:
    """The key service, replaced: one fixed test key, wrapped as a label."""

    async def new_data_key(self) -> DataKey:
        return DataKey(plaintext=TEST_KEY, wrapped="test-wrapped-key")

    async def unwrap_data_key(self, wrapped: str) -> bytes:
        assert wrapped == "test-wrapped-key"
        return TEST_KEY


@pytest.fixture
def file_crypto() -> crypto.FileCrypto:
    return crypto.AesGcmFileCrypto(FixedDataKeys())


@pytest.fixture
def file_store(tmp_path: Path) -> storage.LocalFileStore:
    return storage.LocalFileStore(tmp_path / "files")


@pytest.fixture
def ai_app(users: dict[str, CurrentUser], file_store: storage.LocalFileStore,  # noqa: F811
           file_crypto: crypto.FileCrypto) -> Iterator[FastAPI]:
    application = create_app(Settings(environment="test", auth_mode="dev_header",
                                      database_url=TEST_DATABASE_URL))
    switch_to_role(application.state.db.engine.sync_engine, "shri_app")

    def signed_in(request: Request) -> CurrentUser:
        return users[request.headers[DEV_USER_HEADER]]

    application.dependency_overrides[current_user] = signed_in
    application.dependency_overrides[storage.file_store] = lambda: file_store
    application.dependency_overrides[crypto.file_crypto] = lambda: file_crypto
    yield application


@pytest.fixture
def client(ai_app: FastAPI) -> Iterator[Callable[[str], TestClient]]:
    with TestClient(ai_app, raise_server_exceptions=False) as test_client:
        def as_user(name: str) -> TestClient:
            test_client.headers[DEV_USER_HEADER] = name
            return test_client
        yield as_user
        assert test_client.portal is not None
        test_client.portal.call(ai_app.state.db.dispose)


@pytest.fixture
def model_server(monkeypatch: pytest.MonkeyPatch) -> Iterator[StubModelServer]:
    """A local OpenAI-compatible chat server; the gateway finds it through config.py's
    environment variables, as it would find the GPU server."""
    server = StubModelServer()
    server.start()
    monkeypatch.setenv("SHRI_AI_PROVIDER", "openai-compatible")
    monkeypatch.setenv("SHRI_AI_MODEL_URL", server.url)
    monkeypatch.setenv("SHRI_AI_MODEL_NAME", server.model)
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def claude_server(ai_app: FastAPI, monkeypatch: pytest.MonkeyPatch
                  ) -> Iterator[StubClaudeServer]:
    """A local stand-in for the Claude API; the gateway reaches it through the official SDK,
    with ``ai_provider=claude`` and a placeholder key (never a real one) in core's settings,
    the key's only source (OpenBao in a real environment)."""
    server = StubClaudeServer()
    server.start()
    monkeypatch.setenv("SHRI_AI_PROVIDER", "claude")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(ai_app.state, "settings", ai_app.state.settings.model_copy(
        update={"claude_api_key": SecretStr("test-key-not-a-real-key")}))
    monkeypatch.setenv("ANTHROPIC_BASE_URL", server.url)
    monkeypatch.delenv("SHRI_AI_MODEL", raising=False)
    monkeypatch.delenv("SHRI_AI_MONTHLY_BUDGET_USD", raising=False)
    try:
        yield server
    finally:
        server.stop()
