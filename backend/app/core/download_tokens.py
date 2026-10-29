"""Tokens in decrypting download links (D105; contract #136, the file service #128).

`GET /files/{fileId}/content?token=…` serves an encrypted file through our API. Its token is
bound to one file, one user and one clinic, lasts about a minute, and is accepted once. It is
never enough on its own: the route also needs that user's session. Every invalid, expired, reused
or other-user token gives the same None, which the route answers with the same 404, so a token
can't be probed.

    tokens = request.app.state.download_tokens          # or Depends(download_tokens)
    token = tokens.sign(tokens.claims(file_id, user.id, user.tenant_id))
    claims = tokens.verify(token, user_id=user.id)       # None: 404

A token is `<payload>.<signature>`, both base64url: the payload names the file, user, clinic,
expiry and a random nonce; the signature is HMAC-SHA256 with a key derived from SESSION_SECRET
(its own label, so it is never a CSRF token or the reverse). It is a bearer secret: never log it.
The query string of the content route is kept out of the access logs (access_log.py, nginx).

**Accepted once** is recorded in this process, as for the bot check (public_form.BotCheck): the
API runs as one process (backend/Dockerfile). Running several would need the used nonces in the
database, a table Anand would add.
"""

import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from fastapi import FastAPI, Request

from app.core.config import Settings
from app.core.errors import ServiceUnavailable

TTL_SECONDS = 60
MIN_SECRET_LENGTH = 32
MAX_TRACKED = 10_000
_LABEL = b"shri-download-token"


@dataclass(frozen=True)
class DownloadClaims:
    file_id: UUID
    user_id: UUID
    tenant_id: UUID
    expires_at: datetime


def _encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class DownloadTokens:
    def __init__(self, secret: str, clock: Callable[[], float] = time.time) -> None:
        self._key = hmac.new(secret.encode(), _LABEL, hashlib.sha256).digest()
        self._clock = clock
        self._used: OrderedDict[str, float] = OrderedDict()  # nonce -> expiry

    def claims(self, file_id: UUID, user_id: UUID, tenant_id: UUID) -> DownloadClaims:
        """Claims for a link made now, expiring in TTL_SECONDS."""
        expires = datetime.fromtimestamp(int(self._clock()) + TTL_SECONDS, UTC)
        return DownloadClaims(file_id, user_id, tenant_id, expires)

    def sign(self, claims: DownloadClaims) -> str:
        """The token for `claims`; ValueError if they aren't a link's next minute."""
        expires = claims.expires_at.timestamp()
        now = self._clock()
        if not now < expires <= now + TTL_SECONDS + 1:
            raise ValueError(f"A download token lasts at most {TTL_SECONDS} seconds")
        payload = _encode(json.dumps({
            "f": str(claims.file_id), "u": str(claims.user_id), "t": str(claims.tenant_id),
            "e": int(expires), "n": secrets.token_urlsafe(16)}, separators=(",", ":")).encode())
        return f"{payload}.{self._signature(payload)}"

    def verify(self, token: str, *, user_id: UUID | None = None) -> DownloadClaims | None:
        """The claims of a genuine, unexpired, unused token (of `user_id`, when given), and it
        is used up; else None. A token of another user is refused and not used up."""
        if not token or len(token) > 1024 or token.count(".") != 1:
            return None
        payload, signature = token.split(".")
        if not hmac.compare_digest(self._signature(payload), signature):
            return None
        try:
            data = json.loads(_decode(payload))
            claims = DownloadClaims(UUID(data["f"]), UUID(data["u"]), UUID(data["t"]),
                                    datetime.fromtimestamp(int(data["e"]), UTC))
            nonce = str(data["n"])
        except (binascii.Error, ValueError, KeyError, TypeError):
            return None
        now = self._clock()
        expires = claims.expires_at.timestamp()
        if expires <= now or (user_id is not None and claims.user_id != user_id):
            return None
        self._forget_expired(now)
        if nonce in self._used:
            return None
        self._used[nonce] = expires
        while len(self._used) > MAX_TRACKED:
            self._used.popitem(last=False)
        return claims

    def _signature(self, payload: str) -> str:
        return _encode(hmac.new(self._key, payload.encode(), hashlib.sha256).digest())

    def _forget_expired(self, now: float) -> None:
        for nonce, expires in list(self._used.items()):
            if expires > now:
                break  # in expiry order: every token lasts the same minute
            del self._used[nonce]


def download_tokens(request: Request) -> DownloadTokens:
    """FastAPI dependency; 503 when SESSION_SECRET isn't set (no token is made or accepted)."""
    tokens: DownloadTokens | None = getattr(request.app.state, "download_tokens", None)
    if tokens is None:
        raise ServiceUnavailable("Downloads are not configured")
    return tokens


def register(app: FastAPI, settings: Settings) -> None:
    """Download tokens, keyed from SESSION_SECRET; without a proper one, none (503)."""
    secret = settings.session_secret.get_secret_value() if settings.session_secret else ""
    app.state.download_tokens = (DownloadTokens(secret) if len(secret) >= MIN_SECRET_LENGTH
                                 else None)
