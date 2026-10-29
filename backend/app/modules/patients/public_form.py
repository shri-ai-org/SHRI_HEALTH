"""What the public pre-registration form (D96) takes from core, one FastAPI dependency each, so
tests replace them with ``app.dependency_overrides``:

- ``public_form_guards`` (core, #110, T47): the ``Origin`` check (the portal host only), the rate
  limits (per IP, and per email as core's keyed hash, so the limiter never holds an address) and
  the ALTCHA bot check, verified on the server and accepted once per Idempotency-Key. Without
  ``PORTAL_ORIGIN`` and ``PUBLIC_FORM_SECRET`` it fails closed with 503.
- ``field_cipher`` (core, #102): encryption at rest through OpenBao Transit; it fails closed, so a
  submission is never stored in clear.

The 30-day deletion of rejected and never-reviewed requests is Anand's
``admin.purge_expired_runtime_rows()``, run as ``shri_maintenance`` (#101); nothing here deletes.
"""

from __future__ import annotations

from typing import Protocol

from fastapi import Request

from app.core.crypto import decrypt_field, encrypt_field
from app.core.public_form import public_form_guards

__all__ = ["FieldCipher", "PublicFormGuards", "field_cipher", "normalize_email",
           "public_form_guards"]


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

    async def bot_check_passes(self, payload: str, idempotency_key: str | None = None) -> bool:
        """The ALTCHA proof-of-work answer, verified on the server: signed by us, not expired,
        and not used by another request. A retry with the same Idempotency-Key may send it
        again."""
        ...


class FieldCipher(Protocol):
    async def encrypt(self, plaintext: bytes) -> str: ...

    async def decrypt(self, ciphertext: str) -> bytes: ...


class _TransitCipher:
    def __init__(self, request: Request) -> None:
        self._app = request.app

    async def encrypt(self, plaintext: bytes) -> str:
        return await encrypt_field(self._app, plaintext)

    async def decrypt(self, ciphertext: str) -> bytes:
        return await decrypt_field(self._app, ciphertext)


def field_cipher(request: Request) -> FieldCipher:
    """FastAPI dependency: core's field encryption (#102), which fails closed."""
    return _TransitCipher(request)


def normalize_email(email: str) -> str:
    """The form of an address the rate limit counts: trimmed, case-folded."""
    return email.strip().casefold()
