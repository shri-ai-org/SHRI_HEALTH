"""Tokens in decrypting download links (D105; contract #136, the file service #128).

`GET /files/{fileId}/content?token=…` serves an encrypted file through our API. Its token is
bound to one file, one user and one clinic, lasts about a minute, and is accepted once. It is
never enough on its own: the route also needs that user's session. Every invalid, expired, reused
or other-user token gives the same None, which the route answers with the same 404, so a token
can't be probed.

    tokens = request.app.state.download_tokens          # or Depends(download_tokens)
    token = tokens.sign(tokens.claims(file_id, user.id, user.tenant_id))
    claims = tokens.verify(token, user_id=user.id, file_id=file_id, tenant_id=user.tenant_id)
    # None: 404

A token is `<payload><signature>`, base64url only, as the contract's pattern requires
(`^[A-Za-z0-9_-]{32,512}$`, files.yaml): the payload names its audience, the file,
user, clinic, expiry and a random nonce; the signature, always the last 43 characters, is
HMAC-SHA256 with a key derived from SESSION_SECRET (its own label, so it is never a CSRF token
or the reverse; SESSION_SECRET itself comes from OpenBao outside development). It is a bearer
secret: never log it.
The query string of the content route is kept out of the access logs (access_log.py, nginx).

**Accepted once** is recorded in this process, as for the bot check (public_form.BotCheck): the
API runs as one process (backend/Dockerfile). Running several would need the used nonces in the
database, a table Anand would add.

**The patient portal's links** (#398: `GET /portal/me/files/{fileId}/content?token=…`, used by
the patient's file download, My records and the visit summaries) have their own token keeper,
`PortalDownloadTokens`, with the same rules: one minute, accepted once, every bad token the same
None (404). Its token is bound to the **portal session's patient**, the file and the clinic, and
the route also needs that patient's portal session (`require_patient`). Its key has its own label
and its payload its own audience, so a staff token never works on the portal route and a portal
token never works on `/files/{fileId}/content`; each keeps its own used nonces.

    tokens = request.app.state.portal_download_tokens   # or Depends(portal_download_tokens)
    token = tokens.sign(tokens.claims(file_id, patient.patient_id, patient.organization_id))
    claims = tokens.verify(token, patient_id=patient.patient_id, file_id=file_id,
                           tenant_id=patient.organization_id)
    # None: 404

Both links are audited by their operations (D105: `export`, naming the patient); the token
itself is never logged, audited or put in an event.
"""

import base64
import binascii
import hashlib
import hmac
import json
import re
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
SIGNATURE_LENGTH = 43  # base64url of 32 bytes, unpadded
MAX_TOKEN_LENGTH = 512  # the contract's limit
TOKEN = re.compile(r"^[A-Za-z0-9_-]{32,512}$")  # the contract's pattern (files.yaml)
_LABEL = b"shri-download-token"
_PORTAL_LABEL = b"shri-portal-download-token"
STAFF_AUDIENCE = "staff"
PORTAL_AUDIENCE = "portal"


@dataclass(frozen=True)
class DownloadClaims:
    file_id: UUID
    user_id: UUID
    tenant_id: UUID
    expires_at: datetime


@dataclass(frozen=True)
class PortalDownloadClaims:
    file_id: UUID
    patient_id: UUID
    tenant_id: UUID
    expires_at: datetime


def _encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class _OneTimeLinks:
    """One audience's one-minute, single-use link tokens: (file, subject, clinic), signed with a
    key of its own (``label``) and naming its ``audience`` in the payload."""

    def __init__(self, secret: str, label: bytes, audience: str,
                 clock: Callable[[], float]) -> None:
        self._key = hmac.new(secret.encode(), label, hashlib.sha256).digest()
        self._audience = audience
        self._clock = clock
        self._used: OrderedDict[str, float] = OrderedDict()  # nonce -> expiry

    def _expiry(self) -> datetime:
        return datetime.fromtimestamp(int(self._clock()) + TTL_SECONDS, UTC)

    def _sign(self, file_id: UUID, subject: UUID, tenant_id: UUID, expires_at: datetime) -> str:
        expires = expires_at.timestamp()
        now = self._clock()
        if not now < expires <= now + TTL_SECONDS + 1:
            raise ValueError(f"A download token lasts at most {TTL_SECONDS} seconds")
        payload = _encode(json.dumps({
            "a": self._audience, "f": str(file_id), "u": str(subject), "t": str(tenant_id),
            "e": int(expires), "n": secrets.token_urlsafe(16)}, separators=(",", ":")).encode())
        token = payload + self._signature(payload)
        if not TOKEN.fullmatch(token):  # never: the payload is three UUIDs, a time and a nonce
            raise ValueError("A download token must match the contract's pattern")
        return token

    def _verify(self, token: str, subject: UUID, file_id: UUID,
                tenant_id: UUID) -> tuple[UUID, UUID, UUID, datetime] | None:
        """(file, subject, clinic, expiry) of a genuine, unexpired, unused token of this
        audience for this subject, file and clinic, and it is used up; else None. A token for
        another subject, file or clinic is refused and not used up."""
        if not token or not TOKEN.fullmatch(token) or len(token) <= SIGNATURE_LENGTH:
            return None
        payload, signature = token[:-SIGNATURE_LENGTH], token[-SIGNATURE_LENGTH:]
        if not hmac.compare_digest(self._signature(payload), signature):
            return None
        try:
            data = json.loads(_decode(payload))
            if data["a"] != self._audience:
                return None
            found = (UUID(data["f"]), UUID(data["u"]), UUID(data["t"]),
                     datetime.fromtimestamp(int(data["e"]), UTC))
            nonce = str(data["n"])
        except (binascii.Error, ValueError, KeyError, TypeError):
            return None
        now = self._clock()
        if found[3].timestamp() <= now or found[:3] != (file_id, subject, tenant_id):
            return None
        self._forget_expired(now)
        if nonce in self._used:
            return None
        self._used[nonce] = found[3].timestamp()
        while len(self._used) > MAX_TRACKED:
            self._used.popitem(last=False)
        return found

    def _signature(self, payload: str) -> str:
        return _encode(hmac.new(self._key, payload.encode(), hashlib.sha256).digest())

    def _forget_expired(self, now: float) -> None:
        for nonce, expires in list(self._used.items()):
            if expires > now:
                break  # in expiry order: every token lasts the same minute
            del self._used[nonce]


class DownloadTokens(_OneTimeLinks):
    """Staff links (`/files/{fileId}/content`): bound to the user, the file and the clinic."""

    def __init__(self, secret: str, clock: Callable[[], float] = time.time) -> None:
        super().__init__(secret, _LABEL, STAFF_AUDIENCE, clock)

    def claims(self, file_id: UUID, user_id: UUID, tenant_id: UUID) -> DownloadClaims:
        """Claims for a link made now, expiring in TTL_SECONDS."""
        return DownloadClaims(file_id, user_id, tenant_id, self._expiry())

    def sign(self, claims: DownloadClaims) -> str:
        """The token for `claims`; ValueError if they aren't a link's next minute."""
        return self._sign(claims.file_id, claims.user_id, claims.tenant_id, claims.expires_at)

    def verify(self, token: str, *, user_id: UUID, file_id: UUID,
               tenant_id: UUID) -> DownloadClaims | None:
        """The claims of a genuine, unexpired, unused token for this user, file and clinic, and
        it is used up; else None. All three are required (no default), so no caller can skip
        the binding: a token for another user, file or clinic is refused and not used up."""
        found = self._verify(token, user_id, file_id, tenant_id)
        return DownloadClaims(found[0], found[1], found[2], found[3]) if found else None


class PortalDownloadTokens(_OneTimeLinks):
    """The patient portal's links (`/portal/me/files/{fileId}/content`): bound to the portal
    session's patient, the file and the clinic; never accepted on the staff route, nor the
    staff token here."""

    def __init__(self, secret: str, clock: Callable[[], float] = time.time) -> None:
        super().__init__(secret, _PORTAL_LABEL, PORTAL_AUDIENCE, clock)

    def claims(self, file_id: UUID, patient_id: UUID, tenant_id: UUID) -> PortalDownloadClaims:
        """Claims for a link made now, expiring in TTL_SECONDS."""
        return PortalDownloadClaims(file_id, patient_id, tenant_id, self._expiry())

    def sign(self, claims: PortalDownloadClaims) -> str:
        """The token for `claims`; ValueError if they aren't a link's next minute."""
        return self._sign(claims.file_id, claims.patient_id, claims.tenant_id,
                          claims.expires_at)

    def verify(self, token: str, *, patient_id: UUID, file_id: UUID,
               tenant_id: UUID) -> PortalDownloadClaims | None:
        """The claims of a genuine, unexpired, unused portal token for this patient, file and
        clinic, and it is used up; else None. All three are required (no default): a token
        for another patient, file or clinic is refused and not used up."""
        found = self._verify(token, patient_id, file_id, tenant_id)
        return PortalDownloadClaims(found[0], found[1], found[2], found[3]) if found else None


def download_tokens(request: Request) -> DownloadTokens:
    """FastAPI dependency; 503 when SESSION_SECRET isn't set (no token is made or accepted)."""
    tokens: DownloadTokens | None = getattr(request.app.state, "download_tokens", None)
    if tokens is None:
        raise ServiceUnavailable("Downloads are not configured")
    return tokens


def portal_download_tokens(request: Request) -> PortalDownloadTokens:
    """FastAPI dependency for the portal's links; 503 when SESSION_SECRET isn't set."""
    tokens: PortalDownloadTokens | None = getattr(request.app.state, "portal_download_tokens",
                                                  None)
    if tokens is None:
        raise ServiceUnavailable("Downloads are not configured")
    return tokens


def register(app: FastAPI, settings: Settings) -> None:
    """Download tokens, staff and portal, keyed from SESSION_SECRET; without a proper one,
    none (503)."""
    secret = settings.session_secret.get_secret_value() if settings.session_secret else ""
    proper = len(secret) >= MIN_SECRET_LENGTH
    app.state.download_tokens = DownloadTokens(secret) if proper else None
    app.state.portal_download_tokens = PortalDownloadTokens(secret) if proper else None
