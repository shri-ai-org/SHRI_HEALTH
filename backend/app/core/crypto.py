"""Field encryption through OpenBao Transit (D3; ADR-0007 "encrypt_field").

Values that may hold patient data or credentials are stored only as Transit ciphertext
(`vault:v1:…`): stored idempotent responses, and Keycloak tokens on staff sessions. The key never
leaves OpenBao; the API's token can only encrypt and decrypt with one key.

    ciphertext = await encrypt_field(request.app, body)      # bytes -> "vault:v1:…"
    body = await decrypt_field(request.app, ciphertext)      # "vault:v1:…" -> bytes

Files use envelope encryption with a second key, `shri-files` (Anand's file service, #128): each
file gets a fresh 256-bit data key from Transit, the file service encrypts the file with it and
keeps only the wrapped key (`binary_object.wrapped_data_key`):

    key = await new_data_key(request.app)       # .plaintext (32 bytes), .wrapped "vault:v1:…"
    plaintext = await unwrap_data_key(request.app, key.wrapped)   # the same 32 bytes, later

The key-encryption key never leaves OpenBao, and the API's token can only make data keys with
`shri-files` and unwrap them; it can't unwrap a field's ciphertext or wrap with `shri-fields`.

Fails closed: if Transit isn't configured, can't be reached, refuses the token or answers
anything unexpected, both raise InternalError (500), so plaintext is never stored instead and
nothing half-decrypted is used. Values and ciphertext are never logged.

Calls the Transit HTTP API with httpx (already in the lockfile), no OpenBao client library.
Settings: OPENBAO_TRANSIT_ADDR, OPENBAO_TRANSIT_TOKEN (the narrow token, never a root token),
OPENBAO_TRANSIT_MOUNT ("transit"), OPENBAO_TRANSIT_KEY ("shri-fields"),
OPENBAO_TRANSIT_FILES_KEY ("shri-files").
"""

import base64
import binascii
import logging
import re
from dataclasses import dataclass, field
from typing import Any

import httpx
from fastapi import FastAPI

from app.core.config import Settings
from app.core.errors import InternalError
from app.core.lifecycle import on_shutdown

log = logging.getLogger(__name__)

CIPHERTEXT = re.compile(r"^vault:v[0-9]+:[A-Za-z0-9+/=]+$")  # as 0005's response_body_enc check
TIMEOUT_SECONDS = 5.0
DATA_KEY_BYTES = 32  # AES-256


@dataclass(frozen=True)
class DataKey:
    """A file's data key: use `plaintext` for this one file and drop it; store only `wrapped`.
    Neither is ever logged (no repr)."""

    plaintext: bytes = field(repr=False)
    wrapped: str = field(repr=False)


class FieldCrypto:
    """One Transit key, one narrow token. Create once per app (create_app) and close at exit."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        if settings.openbao_transit_addr is None or settings.openbao_transit_token is None:
            missing = settings.missing("openbao_transit_addr", "openbao_transit_token")
            raise ValueError(f"OpenBao Transit is not configured: set {', '.join(missing)}")
        mount = settings.openbao_transit_mount.strip("/")
        key = settings.openbao_transit_key
        self._encrypt_path = f"/v1/{mount}/encrypt/{key}"
        self._decrypt_path = f"/v1/{mount}/decrypt/{key}"
        files_key = settings.openbao_transit_files_key
        self._datakey_path = f"/v1/{mount}/datakey/plaintext/{files_key}"
        self._unwrap_path = f"/v1/{mount}/decrypt/{files_key}"
        self._client = httpx.AsyncClient(
            base_url=settings.openbao_transit_addr.rstrip("/"),
            headers={"X-Vault-Token": settings.openbao_transit_token.get_secret_value()},
            timeout=TIMEOUT_SECONDS,
            transport=transport,
        )

    async def _call(self, path: str, payload: dict[str, str | int], *wanted: str) -> list[str]:
        try:
            response = await self._client.post(path, json=payload)
        except httpx.HTTPError as error:
            log.error("OpenBao Transit unreachable (%s)", type(error).__name__)
            raise InternalError("Encryption is unavailable") from None
        if response.status_code != 200:
            log.error("OpenBao Transit refused the request (HTTP %s)", response.status_code)
            raise InternalError("Encryption is unavailable")
        try:
            data: Any = response.json()["data"]
            values = [data[name] for name in wanted]
        except (ValueError, KeyError, TypeError):
            log.error("OpenBao Transit answered without %s", ", ".join(wanted))
            raise InternalError("Encryption is unavailable") from None
        if not all(isinstance(value, str) for value in values):
            raise InternalError("Encryption is unavailable")
        return values

    async def encrypt(self, plaintext: bytes) -> str:
        (ciphertext,) = await self._call(self._encrypt_path, {
            "plaintext": base64.b64encode(plaintext).decode("ascii")}, "ciphertext")
        if not CIPHERTEXT.fullmatch(ciphertext):
            log.error("OpenBao Transit answered with something that isn't Transit ciphertext")
            raise InternalError("Encryption is unavailable")
        return ciphertext

    async def decrypt(self, ciphertext: str) -> bytes:
        if not CIPHERTEXT.fullmatch(ciphertext):
            raise InternalError("Stored value is not Transit ciphertext")
        (encoded,) = await self._call(self._decrypt_path, {"ciphertext": ciphertext}, "plaintext")
        return _base64(encoded)

    async def new_data_key(self) -> DataKey:
        encoded, wrapped = await self._call(self._datakey_path, {"bits": DATA_KEY_BYTES * 8},
                                            "plaintext", "ciphertext")
        plaintext = _base64(encoded)
        if len(plaintext) != DATA_KEY_BYTES or not CIPHERTEXT.fullmatch(wrapped):
            log.error("OpenBao Transit answered with something that isn't a data key")
            raise InternalError("Encryption is unavailable")
        return DataKey(plaintext, wrapped)

    async def unwrap_data_key(self, wrapped: str) -> bytes:
        if not CIPHERTEXT.fullmatch(wrapped):
            raise InternalError("Stored value is not a wrapped data key")
        (encoded,) = await self._call(self._unwrap_path, {"ciphertext": wrapped}, "plaintext")
        plaintext = _base64(encoded)
        if len(plaintext) != DATA_KEY_BYTES:
            raise InternalError("Stored value is not a wrapped data key")
        return plaintext

    async def aclose(self) -> None:
        await self._client.aclose()


def _base64(encoded: str) -> bytes:
    try:
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise InternalError("Encryption is unavailable") from None


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


async def new_data_key(app: Any) -> DataKey:
    """A fresh data key for one file; InternalError (500) if Transit can't make one."""
    return await field_crypto(app).new_data_key()


async def unwrap_data_key(app: Any, wrapped: str) -> bytes:
    """The data key inside `wrapped`; InternalError (500) if it can't be unwrapped."""
    return await field_crypto(app).unwrap_data_key(wrapped)


def register(app: FastAPI, settings: Settings) -> None:
    """Field encryption through Transit; unconfigured, encryption fails closed (500)."""
    app.state.crypto = FieldCrypto(settings) if settings.openbao_transit_addr else None
    if app.state.crypto is not None:
        on_shutdown(app, app.state.crypto.aclose)
