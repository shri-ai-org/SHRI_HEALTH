"""core/crypto.py against a real OpenBao development server with Transit (CI starts one and runs
infra/compose/openbao/transit-init.sh). Needs OPENBAO_TRANSIT_ADDR and OPENBAO_TRANSIT_TOKEN (the
API's narrow token); skipped otherwise. Synthetic values only."""

import os

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.core.crypto import FieldCrypto
from app.core.errors import InternalError

ADDR = os.environ.get("OPENBAO_TRANSIT_ADDR")
TOKEN = os.environ.get("OPENBAO_TRANSIT_TOKEN")

pytestmark = [
    pytest.mark.openbao,
    pytest.mark.skipif(not (ADDR and TOKEN) and os.environ.get("REQUIRE_OPENBAO") != "1",
                       reason="OPENBAO_TRANSIT_ADDR/TOKEN not set"),
]


def test_openbao_is_configured_where_it_is_required() -> None:
    """CI sets REQUIRE_OPENBAO=1: a missing server fails there instead of skipping silently."""
    assert ADDR and TOKEN, "OPENBAO_TRANSIT_ADDR and OPENBAO_TRANSIT_TOKEN must be set"


def _crypto(token: str | None = None) -> FieldCrypto:
    return FieldCrypto(Settings(environment="test", openbao_transit_addr=ADDR,
                                openbao_transit_token=SecretStr(token or TOKEN or "")))


async def test_values_round_trip_and_are_really_encrypted() -> None:
    crypto = _crypto()
    value = b'{"id": "0c000000-0000-4000-8000-0000000000b1", "note": "synthetic"}'
    first, second = await crypto.encrypt(value), await crypto.encrypt(value)
    assert first.startswith("vault:v1:") and second.startswith("vault:v1:")
    assert first != second  # a fresh nonce each time
    assert b"synthetic" not in first.encode()
    assert await crypto.decrypt(first) == value == await crypto.decrypt(second)
    await crypto.aclose()


async def test_tampered_ciphertext_is_refused() -> None:
    crypto = _crypto()
    ciphertext = await crypto.encrypt(b"synthetic")
    prefix, body = ciphertext.rsplit(":", 1)
    flipped = body[:-4] + ("AAAA" if body[-4:] != "AAAA" else "BBBB")
    with pytest.raises(InternalError):
        await crypto.decrypt(f"{prefix}:{flipped}")
    await crypto.aclose()


async def test_a_wrong_token_fails_closed() -> None:
    crypto = _crypto(token="not-the-token")  # noqa: S106
    with pytest.raises(InternalError):
        await crypto.encrypt(b"synthetic")
    await crypto.aclose()


@pytest.mark.parametrize(("method", "path"), [
    ("GET", "/v1/transit/keys/shri-fields"),  # read the key's settings
    ("GET", "/v1/transit/export/encryption-key/shri-fields"),  # export the key
    ("POST", "/v1/transit/encrypt/another-key"),  # any other key
    ("POST", "/v1/transit/keys/shri-fields/rotate"),  # change the key
    ("POST", "/v1/auth/token/create"),  # make tokens
    ("GET", "/v1/sys/mounts"),  # look around
])
async def test_the_api_token_can_do_nothing_else(method: str, path: str) -> None:
    async with httpx.AsyncClient(base_url=ADDR or "", headers={"X-Vault-Token": TOKEN or ""}) as c:
        response = await c.request(method, path, json={"plaintext": "c3ludGhldGlj"})
    assert response.status_code == 403, (method, path, response.status_code)
