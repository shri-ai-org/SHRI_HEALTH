from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from app.core.config import Settings


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_dev_login_refused_outside_development(environment: str) -> None:
    with pytest.raises(ValidationError, match="only allowed in development and test"):
        Settings(environment=environment, auth_mode="dev_header")


def test_dev_login_allowed_in_development() -> None:
    assert Settings(environment="development", auth_mode="dev_header").auth_mode == "dev_header"


def test_default_auth_mode_is_not_the_stand_in() -> None:
    assert Settings().auth_mode == "keycloak"


@pytest.mark.parametrize("name", ["current_org", "app.org; DROP TABLE x", "App.Org"])
def test_rls_setting_name_is_validated(name: str) -> None:
    with pytest.raises(ValidationError):
        Settings(rls_tenant_setting=name)


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
    _fake_openbao(monkeypatch, {"rls_tenant_setting": "bao.setting"})
    monkeypatch.setenv("OPENBAO_ADDR", "https://bao.internal:8200")
    monkeypatch.setenv("OPENBAO_TOKEN", "test-token")
    monkeypatch.setenv("RLS_TENANT_SETTING", "env.setting")

    assert Settings().rls_tenant_setting == "env.setting"


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
