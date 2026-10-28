"""Field encryption through OpenBao Transit (D3; ADR-0007 "encrypt_field").

Values that may hold patient data or credentials are stored only as Transit ciphertext
(`vault:v1:…`): stored idempotent responses, and Keycloak tokens on staff sessions. The key never
leaves OpenBao; the API's token can only encrypt and decrypt with one key.

    ciphertext = await encrypt_field(request.app, body)      # bytes -> "vault:v1:…"
    body = await decrypt_field(request.app, ciphertext)      # "vault:v1:…" -> bytes

Fails closed: if Transit isn't configured, can't be reached, refuses the token or answers
anything unexpected, both raise InternalError (500), so plaintext is never stored instead and
nothing half-decrypted is used. Values and ciphertext are never logged.

Calls the Transit HTTP API with httpx (already in the lockfile), no OpenBao client library.
Settings: OPENBAO_TRANSIT_ADDR, OPENBAO_TRANSIT_TOKEN (the narrow token, never a root token),
OPENBAO_TRANSIT_MOUNT ("transit"), OPENBAO_TRANSIT_KEY ("shri-fields").
"""

import base64
import binascii
import logging
import re
from typing import Any

import httpx

from app.core.config import Settings
from app.core.errors import InternalError

log = logging.getLogger(__name__)

CIPHERTEXT = re.compile(r"^vault:v[0-9]+:[A-Za-z0-9+/=]+$")  # as 0005's response_body_enc check
TIMEOUT_SECONDS = 5.0


class FieldCrypto:
    """One Transit key, one narrow token. Create once per app (create_app) and close at exit."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        if settings.openbao_transit_addr is None or settings.openbao_transit_token is None:
            raise ValueError("OpenBao Transit is not configured")
        mount = settings.openbao_transit_mount.strip("/")
        key = settings.openbao_transit_key
        self._encrypt_path = f"/v1/{mount}/encrypt/{key}"
        self._decrypt_path = f"/v1/{mount}/decrypt/{key}"
        self._client = httpx.AsyncClient(
            base_url=settings.openbao_transit_addr.rstrip("/"),
            headers={"X-Vault-Token": settings.openbao_transit_token.get_secret_value()},
            timeout=TIMEOUT_SECONDS,
            transport=transport,
        )

    async def _call(self, path: str, payload: dict[str, str], wanted: str) -> str:
        try:
            response = await self._client.post(path, json=payload)
        except httpx.HTTPError as error:
            log.error("OpenBao Transit unreachable (%s)", type(error).__name__)
            raise InternalError("Encryption is unavailable") from None
        if response.status_code != 200:
            log.error("OpenBao Transit refused the request (HTTP %s)", response.status_code)
            raise InternalError("Encryption is unavailable")
        try:
            data: Any = response.json()["data"][wanted]
        except (ValueError, KeyError, TypeError):
            log.error("OpenBao Transit answered without %s", wanted)
            raise InternalError("Encryption is unavailable") from None
        if not isinstance(data, str):
            raise InternalError("Encryption is unavailable")
        return data

    async def encrypt(self, plaintext: bytes) -> str:
        ciphertext = await self._call(self._encrypt_path, {
            "plaintext": base64.b64encode(plaintext).decode("ascii")}, "ciphertext")
        if not CIPHERTEXT.fullmatch(ciphertext):
            log.error("OpenBao Transit answered with something that isn't Transit ciphertext")
            raise InternalError("Encryption is unavailable")
        return ciphertext

    async def decrypt(self, ciphertext: str) -> bytes:
        if not CIPHERTEXT.fullmatch(ciphertext):
            raise InternalError("Stored value is not Transit ciphertext")
        encoded = await self._call(self._decrypt_path, {"ciphertext": ciphertext}, "plaintext")
        try:
            return base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            raise InternalError("Encryption is unavailable") from None

    async def aclose(self) -> None:
        await self._client.aclose()


def field_crypto(app: Any) -> FieldCrypto:
    crypto: FieldCrypto | None = getattr(app.state, "crypto", None)
    if crypto is None:
        log.error("Field encryption needed but OpenBao Transit is not configured")
        raise InternalError("Encryption is unavailable")
    return crypto


async def encrypt_field(app: Any, plaintext: bytes) -> str:
    """Transit ciphertext for `plaintext`; InternalError (500) if it can't be encrypted."""
    return await field_crypto(app).encrypt(plaintext)


async def decrypt_field(app: Any, ciphertext: str) -> bytes:
    """The plaintext of Transit `ciphertext`; InternalError (500) if it can't be decrypted."""
    return await field_crypto(app).decrypt(ciphertext)
