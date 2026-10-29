"""Envelope encryption of every stored file (D3, D105; Anand's guide Step 6).

Each file gets a fresh 256-bit data key from core (``new_data_key()``, OpenBao Transit's
``shri-files`` key, #140). The file service encrypts the file with it, AES-256-GCM, and keeps
only the wrapped key, in ``admin.binary_object.wrapped_data_key``. The plaintext key is used
for that one file and dropped; the key-encryption key never leaves OpenBao.

``FileCrypto`` is the module's interface:

- ``seal(data, context=...)`` returns the bytes to store and the wrapped key;
- ``open(sealed, wrapped_data_key, context=...)`` unwraps the key through core and returns the
  plaintext, only after the whole file has been verified, so nothing unverified is ever sent.

The stored form is ``SHF1`` (the format and its version), a 12-byte random nonce, then the
ciphertext and its 16-byte tag. The associated data is the file's storage key
(``<clinic>/<file>``), so ciphertext moved to another file's key, or another clinic's, does not
open. Anything that doesn't verify (changed bytes, a wrong key, another file's bytes, a file
stored without encryption) raises ``FileTampered``, which is answered with ``500``: the stored
file is not what was written, and no byte of it is served.

Core's key service failing (not configured, unreachable, refusing) is ``503
service-unavailable``: an upload then stays ``pending-upload`` and can be finished later, and a
download can be tried again. Keys and plaintext are never logged.
"""

from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass, field
from typing import Any, Protocol

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from starlette.requests import Request

from app.core import crypto as core_crypto
from app.core.crypto import DataKey
from app.core.errors import InternalError, ServiceUnavailable

log = logging.getLogger(__name__)

FORMAT = b"SHF1"
NONCE_BYTES = 12
TAG_BYTES = 16
KEY_BYTES = 32  # AES-256
_AAD_LABEL = b"shri-file:"


class FileTampered(InternalError):
    """A stored file that doesn't verify: never served (500)."""


@dataclass(frozen=True)
class SealedFile:
    data: bytes = field(repr=False)  # what the store keeps
    wrapped_data_key: str = field(repr=False)  # admin.binary_object.wrapped_data_key


class DataKeys(Protocol):
    """Where data keys come from: core (``CoreDataKeys``), or a test's stand-in."""

    async def new_data_key(self) -> DataKey: ...

    async def unwrap_data_key(self, wrapped: str) -> bytes: ...


class FileCrypto(Protocol):
    async def seal(self, data: bytes, *, context: str) -> SealedFile:
        """``data`` encrypted with a new data key; ``ServiceUnavailable`` if there is none."""
        ...

    async def open(self, sealed: bytes, wrapped_data_key: str | None, *, context: str) -> bytes:
        """The plaintext of ``sealed``; ``ServiceUnavailable`` if its key can't be unwrapped,
        ``FileTampered`` if it doesn't verify."""
        ...


def _aad(context: str) -> bytes:
    return _AAD_LABEL + context.encode("ascii")


class AesGcmFileCrypto:
    """AES-256-GCM with one data key per file (module docstring)."""

    def __init__(self, keys: DataKeys) -> None:
        self._keys = keys

    async def seal(self, data: bytes, *, context: str) -> SealedFile:
        key = await self._keys.new_data_key()
        if len(key.plaintext) != KEY_BYTES:
            raise ServiceUnavailable("File encryption is not available")
        nonce = secrets.token_bytes(NONCE_BYTES)
        sealed = AESGCM(key.plaintext).encrypt(nonce, data, _aad(context))
        return SealedFile(data=FORMAT + nonce + sealed, wrapped_data_key=key.wrapped)

    async def open(self, sealed: bytes, wrapped_data_key: str | None, *, context: str) -> bytes:
        header = len(FORMAT) + NONCE_BYTES
        if (wrapped_data_key is None or not sealed.startswith(FORMAT)
                or len(sealed) < header + TAG_BYTES):
            raise FileTampered("A stored file could not be decrypted")
        key = await self._keys.unwrap_data_key(wrapped_data_key)
        try:
            return AESGCM(key).decrypt(sealed[len(FORMAT):header], sealed[header:],
                                       _aad(context))
        except (InvalidTag, ValueError):
            raise FileTampered("A stored file could not be decrypted") from None


class CoreDataKeys:
    """Core's data keys (``app.core.crypto``, #140). Core fails closed with ``500`` when the key
    service isn't configured or answers anything unexpected; for files that is ``503``, as the
    contract says (files.yaml), so an upload can be finished and a download tried again."""

    def __init__(self, app: Any) -> None:
        self._app = app

    async def new_data_key(self) -> DataKey:
        try:
            return await core_crypto.new_data_key(self._app)
        except InternalError:
            raise ServiceUnavailable("File encryption is not available") from None

    async def unwrap_data_key(self, wrapped: str) -> bytes:
        try:
            return await core_crypto.unwrap_data_key(self._app, wrapped)
        except InternalError:
            raise ServiceUnavailable("File encryption is not available") from None


def file_crypto(request: Request) -> FileCrypto:
    """FastAPI dependency: AES-256-GCM with core's data keys."""
    return AesGcmFileCrypto(CoreDataKeys(request.app))
