"""core/crypto.py with a fake Transit (httpx.MockTransport). The real OpenBao is tested in
test_crypto_openbao.py. Synthetic values only."""

import base64
import json
import logging
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.core.crypto import FieldCrypto, decrypt_field, encrypt_field, field_crypto
from app.core.errors import InternalError

TOKEN = "narrow-test-token"  # noqa: S105 (a fake token for a fake server)
VALUE = b'{"note": "synthetic response body"}'


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {"environment": "test", "openbao_transit_addr": "http://bao.test:8200",
                              "openbao_transit_token": SecretStr(TOKEN)}
    values.update(overrides)
    return Settings(**values)


def _fake_transit(seen: list[httpx.Request]) -> Callable[[httpx.Request], httpx.Response]:
    """Encrypt and decrypt like Transit, with base64 standing in for the cipher."""

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = json.loads(request.content)
        if request.url.path == "/v1/transit/encrypt/shri-fields":
            return httpx.Response(200, json={"data": {
                "ciphertext": f"vault:v1:{body['plaintext']}"}})
        if request.url.path == "/v1/transit/decrypt/shri-fields":
            return httpx.Response(200, json={"data": {
                "plaintext": body["ciphertext"].removeprefix("vault:v1:")}})
        return httpx.Response(404)

    return handle


def _crypto(handler: Callable[[httpx.Request], httpx.Response]) -> FieldCrypto:
    return FieldCrypto(_settings(), transport=httpx.MockTransport(handler))


async def test_a_value_round_trips_through_transit() -> None:
    seen: list[httpx.Request] = []
    crypto = _crypto(_fake_transit(seen))
    ciphertext = await crypto.encrypt(VALUE)
    assert ciphertext.startswith("vault:v1:")
    assert await crypto.decrypt(ciphertext) == VALUE
    assert [r.url.path for r in seen] == ["/v1/transit/encrypt/shri-fields",
                                          "/v1/transit/decrypt/shri-fields"]
    assert all(r.headers["X-Vault-Token"] == TOKEN for r in seen)  # the narrow token only
    await crypto.aclose()


def _failing(kind: str) -> Callable[[httpx.Request], httpx.Response]:
    def handle(request: httpx.Request) -> httpx.Response:
        if kind == "down":
            raise httpx.ConnectError("connection refused", request=request)
        if kind == "timeout":
            raise httpx.ReadTimeout("slow", request=request)
        if kind == "forbidden":
            return httpx.Response(403, json={"errors": ["permission denied"]})
        if kind == "sealed":
            return httpx.Response(503, json={"errors": ["Vault is sealed"]})
        if kind == "not-json":
            return httpx.Response(200, text="<html>proxy error</html>")
        if kind == "no-data":
            return httpx.Response(200, json={"warnings": ["?"]})
        if kind == "plaintext-back":  # anything but Transit ciphertext must never be stored
            return httpx.Response(200, json={"data": {"ciphertext": "not encrypted"}})
        raise AssertionError(kind)

    return handle


@pytest.mark.parametrize("kind", ["down", "timeout", "forbidden", "sealed", "not-json",
                                  "no-data", "plaintext-back"])
async def test_encryption_fails_closed(kind: str, caplog: pytest.LogCaptureFixture) -> None:
    crypto = _crypto(_failing(kind))
    with caplog.at_level(logging.ERROR), pytest.raises(InternalError) as refused:
        await crypto.encrypt(VALUE)
    assert refused.value.status == 500
    assert "synthetic" not in caplog.text  # the value never reaches a log line
    await crypto.aclose()


@pytest.mark.parametrize("kind", ["down", "forbidden", "not-json"])
async def test_decryption_fails_closed(kind: str) -> None:
    crypto = _crypto(_failing(kind))
    with pytest.raises(InternalError):
        await crypto.decrypt("vault:v1:c3ludGhldGlj")
    await crypto.aclose()


async def test_a_value_that_isnt_ciphertext_is_never_sent_to_decrypt() -> None:
    seen: list[httpx.Request] = []
    crypto = _crypto(_fake_transit(seen))
    for stored in ("plain text", "vault:v1:", "vault:vX:abc"):
        with pytest.raises(InternalError):
            await crypto.decrypt(stored)
    assert seen == []
    await crypto.aclose()


class _App:
    class state:  # noqa: N801 (stands in for app.state)
        crypto: FieldCrypto | None = None


async def test_without_transit_configured_encryption_is_refused() -> None:
    app = _App()
    with pytest.raises(InternalError):
        field_crypto(app)
    with pytest.raises(InternalError):
        await encrypt_field(app, VALUE)
    with pytest.raises(InternalError):
        await decrypt_field(app, "vault:v1:c3ludGhldGlj")


@pytest.fixture
def no_transit_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """CI sets the real server's variables; these tests decide the settings themselves."""
    monkeypatch.delenv("OPENBAO_TRANSIT_ADDR", raising=False)
    monkeypatch.delenv("OPENBAO_TRANSIT_TOKEN", raising=False)


def test_an_address_without_a_token_stops_startup(no_transit_env: None) -> None:
    from app.main import create_app

    with pytest.raises(ValueError, match="not configured"):
        create_app(Settings(environment="test", auth_mode="dev_header",
                            openbao_transit_addr="http://bao.test:8200"))


def test_the_app_creates_one_crypto_client_when_configured(no_transit_env: None) -> None:
    from app.main import create_app

    assert create_app(Settings(environment="test", auth_mode="dev_header")).state.crypto is None
    app = create_app(_settings(auth_mode="dev_header"))
    assert isinstance(app.state.crypto, FieldCrypto)


def test_base64_is_what_travels() -> None:
    """Transit takes base64 plaintext; a body with any bytes survives."""
    raw = bytes(range(256))
    assert base64.b64decode(base64.b64encode(raw)) == raw
