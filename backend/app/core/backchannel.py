"""Staff back-channel logout (D94; OpenID Connect Back-Channel Logout 1.0; contract operation
receiveKeycloakBackchannelLogout, x-owner thulasi).

Keycloak calls `POST /hooks/keycloak/backchannel-logout` when a staff member's Keycloak session
ends: an admin disables the user or signs out their sessions, or the user signs out elsewhere.
Every matching session of ours ends at once, not at the next 5-minute token refresh (D101).

The `logout_token` is checked in full before anything happens:
- **the signature:** RS256 only (never `none`, never HS256 or any other algorithm), with the key
  its `kid` names from the staff realm's published keys (JWKS), fetched from Keycloak's internal
  URL, cached, and fetched again once when a `kid` isn't known (key rotation);
- **the claims:** `iss` is the staff realm, `aud` is `shri-web`, `exp` not passed, `iat` within
  the last 5 minutes (60 seconds of clock skew), the back-channel logout `events` member, `sid`
  or `sub`, a `jti`, and **no** `nonce` (§2.4: a logout token must never carry one);
- **used once:** `admin.end_backchannel_sessions` records the `jti` in
  `admin.consumed_logout_token` and refuses it a second time, then ends the matching sessions
  (by `sid`, else every session of the `sub`). Each ended session's `security` audit row, with
  Keycloak as the partner actor, is written in the same transaction (the contract's x-audit).

Every failure is the same `400 malformed-request` (the specification's answer), which never says
which check failed. The token is never logged. Nginx keeps `/hooks/keycloak/` off the public
host: only Keycloak, on the internal network, reaches it.
"""

import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs

import httpx
import jwt
from fastapi import APIRouter, FastAPI, Request, Response
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core import audit
from app.core.config import Settings
from app.core.db import CORRELATION_SETTING, TENANT_SETTING, USER_SETTING, Database
from app.core.errors import AppError, ServiceUnavailable
from app.core.lifecycle import on_shutdown
from app.core.request_id import current_request_id
from app.core.safe_logging import log_failure

log = logging.getLogger(__name__)

ALGORITHM = "RS256"
LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout"
MAX_TOKEN_AGE_SECONDS = 300
LEEWAY_SECONDS = 60
MAX_BODY_BYTES = 16 * 1024
JWKS_REFRESH_SECONDS = 60  # an unknown kid fetches the keys again at most this often
TIMEOUT_SECONDS = 5.0
PATH = "/hooks/keycloak/backchannel-logout"
REPLAYED = "P0001"  # admin.end_backchannel_sessions: "logout token: already used"
OPERATION = "receiveKeycloakBackchannelLogout"


class LogoutTokenRefused(AppError):
    """Any problem with the logout token: always the same 400 (never says which)."""

    default_code = "malformed-request"


def refused() -> LogoutTokenRefused:
    return LogoutTokenRefused("The logout token was not accepted")


class StaffRealmKeys:
    """The staff realm's signing keys (JWKS), by kid; RSA signature keys only."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        if not settings.keycloak_internal_url:
            raise ValueError("Back-channel logout is not configured: set KEYCLOAK_INTERNAL_URL")
        base = settings.keycloak_internal_url.rstrip("/")
        self._url = f"{base}/realms/{settings.keycloak_realm}/protocol/openid-connect/certs"
        self._client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=transport)
        self._clock = clock
        self._keys: dict[str, Any] = {}
        self._fetched_at: float | None = None

    async def key(self, kid: str) -> Any:
        if kid not in self._keys and (self._fetched_at is None
                                      or self._clock() - self._fetched_at >= JWKS_REFRESH_SECONDS):
            await self._fetch()
        found = self._keys.get(kid)
        if found is None:
            raise refused()
        return found

    async def _fetch(self) -> None:
        self._fetched_at = self._clock()
        try:
            response = await self._client.get(self._url)
        except httpx.HTTPError as error:
            log.error("Staff realm keys unreachable (%s)", type(error).__name__)
            raise ServiceUnavailable("The identity provider is unavailable") from None
        if response.status_code != 200:
            log.error("Staff realm keys answered HTTP %s", response.status_code)
            raise ServiceUnavailable("The identity provider is unavailable")
        keys: dict[str, Any] = {}
        try:
            for entry in response.json().get("keys", []):
                if (entry.get("kty") == "RSA" and entry.get("use", "sig") == "sig"
                        and entry.get("alg", ALGORITHM) == ALGORITHM and entry.get("kid")):
                    keys[str(entry["kid"])] = jwt.PyJWK(entry, ALGORITHM).key
        except (ValueError, TypeError, AttributeError, jwt.PyJWKError):
            log.error("Staff realm keys were unreadable")
            raise ServiceUnavailable("The identity provider is unavailable") from None
        self._keys = keys

    async def aclose(self) -> None:
        await self._client.aclose()


async def verify(keys: StaffRealmKeys, settings: Settings, token: str,
                 now: float | None = None) -> dict[str, Any]:
    """The checked claims of a logout token (module docstring); `refused()` otherwise."""
    if not settings.keycloak_public_url:
        raise ServiceUnavailable("Back-channel logout is not configured")
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise refused() from None
    if header.get("alg") != ALGORITHM or not isinstance(header.get("kid"), str):
        raise refused()  # alg none, HS256 or anything else never reaches a key
    key = await keys.key(header["kid"])
    issuer = settings.keycloak_public_url.rstrip("/") + f"/realms/{settings.keycloak_realm}"
    try:
        claims: dict[str, Any] = jwt.decode(
            token, key, algorithms=[ALGORITHM], audience=settings.keycloak_client_id,
            issuer=issuer, leeway=LEEWAY_SECONDS,
            options={"require": ["iss", "aud", "iat", "exp", "jti"]})
    except jwt.PyJWTError:
        raise refused() from None
    current = time.time() if now is None else now
    events = claims.get("events")
    problems = [
        not isinstance(events, dict) or not isinstance(events.get(LOGOUT_EVENT), dict),
        "nonce" in claims,
        not (isinstance(claims.get("sid"), str) and claims["sid"])
        and not (isinstance(claims.get("sub"), str) and claims["sub"]),
        not isinstance(claims.get("iat"), int)
        or not current - MAX_TOKEN_AGE_SECONDS - LEEWAY_SECONDS <= claims["iat"]
        <= current + LEEWAY_SECONDS,
        not isinstance(claims.get("jti"), str) or not 0 < len(claims["jti"]) <= 255,
    ]
    if any(problems):
        raise refused()
    return claims


_END = text("SELECT session_id, tenant_id, user_id FROM admin.end_backchannel_sessions("
            ":jti, :jti_expires_at, :sid, :sub)")
_SET = text("SELECT set_config(:t_name, :t, true), set_config(:u_name, :u, true), "
            "set_config(:c_name, :c, true)")


async def end_sessions(request: Request, db: Database, claims: dict[str, Any]) -> int:
    """One transaction: the jti recorded once, the matching sessions ended, and one security row
    per ended session, in its own clinic. A replayed jti is `refused()`."""
    expires = datetime.fromtimestamp(int(claims["exp"]), UTC)
    async with db.sessions() as s:
        try:
            ended = (await s.execute(_END, {
                "jti": claims["jti"], "jti_expires_at": expires,
                "sid": claims.get("sid") or None, "sub": claims.get("sub") or None})).all()
        except DBAPIError as error:
            await s.rollback()
            if getattr(getattr(error, "orig", None), "sqlstate", None) != REPLAYED:
                # Not a replay: the database failed. Keycloak won't retry, so this logout falls
                # back to the 5-minute refresh (D94's backstop); make that visible.
                log_failure(log, "Back-channel logout could not end sessions (request %s)",
                            current_request_id())
            raise refused() from None
        for row in ended:
            await s.execute(_SET, {"t_name": TENANT_SETTING, "t": str(row.tenant_id),
                                   "u_name": USER_SETTING, "u": "",
                                   "c_name": CORRELATION_SETTING,
                                   "c": current_request_id() or ""})
            entry: dict[str, Any] = {
                "tenant_id": row.tenant_id, "actor_type": "partner", "actor_user_id": None,
                "actor_display": "keycloak", "action": "logout", "outcome": "success",
                "category": "security", "entity_type": "session",
                "entity_id": str(row.session_id), "patient_id": None, "purpose_of_use": None,
                "reason": "keycloak-backchannel-logout", "source_ip": audit._client_ip(request),
                "user_agent": (request.headers.get("user-agent") or "")[:300] or None,
                "correlation_id": current_request_id()}

            def write(sync: Any, rows: list[dict[str, Any]] = [entry]) -> None:  # noqa: B006
                audit.insert_rows(sync.connection(), rows)

            await s.run_sync(write)
        await s.commit()
    return len(ended)


router = APIRouter(tags=["partner-callbacks"])


@router.post(PATH, operation_id=OPERATION, include_in_schema=False)
async def receive_backchannel_logout(request: Request) -> Response:
    keys: StaffRealmKeys | None = getattr(request.app.state, "staff_realm_keys", None)
    db: Database | None = request.app.state.db
    if keys is None or db is None:
        raise ServiceUnavailable("Back-channel logout is not configured")
    if "application/x-www-form-urlencoded" not in request.headers.get("content-type", ""):
        raise refused()
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise refused()
    try:
        form = parse_qs(body.decode("ascii"), strict_parsing=True)
    except (UnicodeDecodeError, ValueError):
        raise refused() from None
    tokens = form.get("logout_token", [])
    if set(form) != {"logout_token"} or len(tokens) != 1:
        raise refused()
    claims = await verify(keys, request.app.state.settings, tokens[0])
    count = await end_sessions(request, db, claims)
    log.info("Back-channel logout: %s session(s) ended", count)
    return Response(status_code=200, headers={"Cache-Control": "no-store"})


def register(app: FastAPI, settings: Settings) -> None:
    """Back-channel logout, when staff sign-in is configured; otherwise its route answers 503."""
    app.state.staff_realm_keys = (StaffRealmKeys(settings) if settings.keycloak_internal_url
                                  and settings.keycloak_public_url else None)
    if app.state.staff_realm_keys is not None:
        on_shutdown(app, app.state.staff_realm_keys.aclose)


def register_routes(app: FastAPI, settings: Settings) -> None:
    """At the root, outside /api/v1, like the other /hooks."""
    app.include_router(router)
