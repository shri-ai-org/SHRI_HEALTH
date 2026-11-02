from typing import Any
from uuid import uuid4

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import Settings


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_dev_login_refused_outside_development(environment: str) -> None:
    with pytest.raises(ValidationError, match="only allowed in development and test"):
        Settings(environment=environment, auth_mode="dev_header")


def test_dev_login_allowed_in_development() -> None:
    assert Settings(environment="development", auth_mode="dev_header").auth_mode == "dev_header"


def test_default_auth_mode_is_not_the_stand_in() -> None:
    assert Settings().auth_mode == "keycloak"


def test_unset_environment_is_production(monkeypatch: pytest.MonkeyPatch) -> None:
    # Review of #7 (Minalini): a deployment that forgets ENVIRONMENT must not end up in
    # development, where X-Dev-User and the API docs are on.
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    settings = Settings()

    assert settings.environment == "production"
    assert settings.show_docs is False
    with pytest.raises(ValidationError, match="only allowed in development and test"):
        Settings(auth_mode="dev_header")


def test_docs_hidden_in_production() -> None:
    assert Settings(environment="production").show_docs is False


def _fake_openbao(monkeypatch: pytest.MonkeyPatch, data: dict[str, Any] | None) -> list[str]:
    calls: list[str] = []

    def fake_get(url: str, **kwargs: Any) -> httpx.Response:
        calls.append(url)
        request = httpx.Request("GET", url)
        if data is None:
            return httpx.Response(403, request=request)
        return httpx.Response(200, json={"data": {"data": data}}, request=request)

    monkeypatch.setattr(httpx, "get", fake_get)
    return calls


def test_openbao_values_are_loaded(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_openbao(monkeypatch, {"DATABASE_URL": "postgresql+asyncpg://from-bao/db",
                                        "unrelated": "ignored"})
    monkeypatch.setenv("OPENBAO_ADDR", "https://bao.internal:8200")
    monkeypatch.setenv("OPENBAO_TOKEN", "test-token")

    settings = Settings()

    assert calls == ["https://bao.internal:8200/v1/secret/data/shri-health/api"]
    assert settings.database_url is not None
    assert settings.database_url.get_secret_value() == "postgresql+asyncpg://from-bao/db"


def test_environment_variables_override_openbao(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_openbao(monkeypatch, {"problem_type_base": "tag:bao.example,2026:problem/"})
    monkeypatch.setenv("OPENBAO_ADDR", "https://bao.internal:8200")
    monkeypatch.setenv("OPENBAO_TOKEN", "test-token")
    monkeypatch.setenv("PROBLEM_TYPE_BASE", "tag:env.example,2026:problem/")

    assert Settings().problem_type_base == "tag:env.example,2026:problem/"


def test_unreadable_openbao_stops_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_openbao(monkeypatch, None)
    monkeypatch.setenv("OPENBAO_ADDR", "https://bao.internal:8200")
    monkeypatch.setenv("OPENBAO_TOKEN", "test-token")

    with pytest.raises(RuntimeError, match="Could not read settings from OpenBao"):
        Settings()


def test_openbao_without_token_stops_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENBAO_ADDR", "https://bao.internal:8200")
    monkeypatch.delenv("OPENBAO_TOKEN", raising=False)

    with pytest.raises(RuntimeError, match="OPENBAO_TOKEN is missing"):
        Settings()


def test_a_half_configured_file_store_stops_startup_naming_what_to_set() -> None:
    with pytest.raises(ValidationError, match="FILE_STORE_ACCESS_KEY_ID, "
                       "FILE_STORE_SECRET_ACCESS_KEY, FILE_STORE_CLEAN_BUCKET, "
                       "FILE_STORE_QUARANTINE_BUCKET"):
        Settings(environment="test", file_store_url="http://seaweedfs.test:8333")


def test_a_file_store_is_all_or_nothing() -> None:
    assert Settings(environment="test").file_store_url is None
    full = Settings(environment="test", file_store_url="http://seaweedfs.test:8333",
                    file_store_access_key_id="shri-api",
                    file_store_secret_access_key=SecretStr(uuid4().hex),
                    file_store_clean_bucket="clean", file_store_quarantine_bucket="quarantine")
    assert full.file_store_region == "us-east-1" and full.file_store_public_url is None
