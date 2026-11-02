"""Partner callback signatures (core/partner_hooks.py), the receivers' refusals that need no
database, and the settings that guard them. Synthetic values only."""

import json
import secrets
import time
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from starlette.datastructures import Headers

from app.core.config import Settings
from app.core.errors import ServiceUnavailable, Unauthorized
from app.core.partner_hooks import CLINIC_HEADER, sign, verify
from app.main import create_app

CLINIC = uuid4()
BODY = b'{"messageType":"271"}'


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test", "auth_mode": "dev_header",
        "hook_secret_clearinghouse": SecretStr(secrets.token_hex(32)),
        "hook_secret_erx": SecretStr(secrets.token_hex(32))}
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def _app(**overrides: object) -> FastAPI:
    values: dict[str, object] = {"environment": "test", "auth_mode": "dev_header"}
    values.update(overrides)
    return create_app(Settings(**values))  # type: ignore[arg-type]


def _signed(settings: Settings, partner: str = "clearinghouse", body: bytes = BODY,
            now: float | None = None) -> dict[str, str]:
    return sign(settings, partner, "SIM-271-0001", CLINIC, body, now=now)


def test_a_signed_message_verifies_and_names_its_clinic() -> None:
    settings = _settings()
    hook = verify(settings, "clearinghouse", Headers(_signed(settings)), BODY)
    assert (hook.partner, hook.message_id, hook.clinic_id) == ("clearinghouse", "SIM-271-0001",
                                                                CLINIC)


@pytest.mark.parametrize("tamper", ["body", "clinic", "id", "timestamp", "secret", "partner"])
def test_any_change_breaks_the_signature(tamper: str) -> None:
    settings = _settings()
    headers = _signed(settings)
    body = BODY
    if tamper == "body":
        body = b'{"messageType":"272"}'
    elif tamper == "clinic":
        headers[CLINIC_HEADER] = str(uuid4())
    elif tamper == "id":
        headers["webhook-id"] = "SIM-271-0002"
    elif tamper == "timestamp":
        headers["webhook-timestamp"] = str(int(headers["webhook-timestamp"]) - 1)
    elif tamper == "secret":
        headers = _signed(_settings())  # another secret
    with pytest.raises(Unauthorized):
        verify(settings, "erx" if tamper == "partner" else "clearinghouse", Headers(headers),
               body)


@pytest.mark.parametrize("offset", [-301, 301])
def test_a_timestamp_outside_five_minutes_is_refused(offset: int) -> None:
    settings = _settings()
    headers = _signed(settings, now=time.time() + offset)
    with pytest.raises(Unauthorized):
        verify(settings, "clearinghouse", Headers(headers), BODY)


@pytest.mark.parametrize("header", ["webhook-id", "webhook-timestamp", "webhook-signature",
                                    CLINIC_HEADER])
def test_a_missing_header_is_refused(header: str) -> None:
    settings = _settings()
    headers = _signed(settings)
    del headers[header]
    with pytest.raises(Unauthorized):
        verify(settings, "clearinghouse", Headers(headers), BODY)


def test_one_good_signature_among_several_is_enough() -> None:
    settings = _settings()
    headers = _signed(settings)
    headers["webhook-signature"] = "v1,AAAA " + headers["webhook-signature"]
    assert verify(settings, "clearinghouse", Headers(headers), BODY).clinic_id == CLINIC


def test_an_unconfigured_partner_is_503() -> None:
    settings = _settings(hook_secret_erx=None)
    with pytest.raises(ServiceUnavailable):
        verify(settings, "erx", Headers({}), BODY)


def test_settings_refuse_simulated_partners_in_production_and_short_secrets() -> None:
    with pytest.raises(ValueError, match="never allowed in production"):
        Settings(environment="production", simulated_partners=True,
                 simulated_partner_callback_url="http://api:8000")
    with pytest.raises(ValueError, match="SIMULATED_PARTNER_CALLBACK_URL"):
        Settings(environment="test", simulated_partners=True)
    with pytest.raises(ValueError, match="at least 32"):
        Settings(environment="test", hook_secret_erx=SecretStr("short"))


@pytest.mark.parametrize("path", ["/hooks/clearinghouse", "/hooks/erx"])
def test_the_routes_refuse_unsigned_and_unconfigured_calls(path: str) -> None:
    unconfigured = TestClient(_app(database_url="postgresql+asyncpg://u:p@db.invalid/x"),
                              raise_server_exceptions=False)
    assert unconfigured.post(path, content=BODY).status_code == 503
    settings = _settings()
    configured = TestClient(_app(database_url="postgresql+asyncpg://u:p@db.invalid/x",
                                     hook_secret_clearinghouse=settings.hook_secret_clearinghouse,
                                     hook_secret_erx=settings.hook_secret_erx),
                            raise_server_exceptions=False)
    refused = configured.post(path, content=BODY, headers={"webhook-id": "x"})
    assert refused.status_code == 401
    assert refused.json()["code"] == "unauthenticated"
    assert "signature" not in json.dumps(refused.json()).lower()  # never says which check
