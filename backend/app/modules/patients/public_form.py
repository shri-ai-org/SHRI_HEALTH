"""What the public pre-registration form (D96) needs from core, one FastAPI dependency each, so the
endpoint never changes when core's pieces land, and tests replace them with
``app.dependency_overrides``:

- ``PublicFormGuards`` (Thulasi, T47): the ``Origin`` check (the portal host only), the rate
  limits (per IP, and per email as core's keyed hash, so the limiter never holds an address) and
  the ALTCHA bot check, verified on the server. Core has none of these yet, so the dependency
  **fails closed** with 503: the form takes nothing until they exist.
- ``FieldCipher`` (Thulasi, #102): encryption at rest through OpenBao Transit. It uses
  ``app.core.crypto`` as soon as that module is on main; until then it fails closed with 503, so
  a submission is never stored in clear.

The 30-day deletion of rejected and never-reviewed requests is Anand's
``admin.purge_expired_runtime_rows()``, run as ``shri_maintenance`` (#101); nothing here deletes.
"""

from __future__ import annotations

import importlib
from collections.abc import Awaitable, Callable
from typing import Protocol, cast

from fastapi import Request

from app.core.errors import ServiceUnavailable


class PublicFormGuards(Protocol):
    def origin_allowed(self, origin: str | None) -> bool:
        """True only for the portal host's own origin."""
        ...

    def email_key(self, email: str) -> str:
        """A keyed hash (HMAC, server secret) of an already-normalized email: the rate limit's
        key, never the address itself."""
        ...

    async def retry_after(self, scope: str, key: str) -> int | None:
        """Counts one request against ``scope`` for ``key``; None while within the limit,
        otherwise the seconds to wait (429 with Retry-After)."""
        ...

    async def bot_check_passes(self, payload: str) -> bool:
        """The ALTCHA proof-of-work answer, verified on the server (not expired, not reused)."""
        ...


class FieldCipher(Protocol):
    async def encrypt(self, plaintext: bytes) -> str: ...

    async def decrypt(self, ciphertext: str) -> bytes: ...


def public_form_guards() -> PublicFormGuards:
    """FastAPI dependency. Core's guards (T47) are not built yet: refuse rather than take a
    form without its Origin check, rate limits and bot check."""
    raise ServiceUnavailable("Public forms are not available yet")


class _TransitCipher:
    def __init__(self, request: Request, encrypt: Callable[..., Awaitable[str]],
                 decrypt: Callable[..., Awaitable[bytes]]) -> None:
        self._app = request.app
        self._encrypt = encrypt
        self._decrypt = decrypt

    async def encrypt(self, plaintext: bytes) -> str:
        return await self._encrypt(self._app, plaintext)

    async def decrypt(self, ciphertext: str) -> bytes:
        return await self._decrypt(self._app, ciphertext)


def field_cipher(request: Request) -> FieldCipher:
    """FastAPI dependency: core's field encryption (#102), or 503 until it is on main."""
    try:
        crypto = importlib.import_module("app.core.crypto")
    except ModuleNotFoundError as missing:
        raise ServiceUnavailable("Encryption at rest is not available yet") from missing
    return _TransitCipher(request, cast(Callable[..., Awaitable[str]], crypto.encrypt_field),
                          cast(Callable[..., Awaitable[bytes]], crypto.decrypt_field))


def normalize_email(email: str) -> str:
    """The form of an address the rate limit counts: trimmed, case-folded."""
    return email.strip().casefold()
