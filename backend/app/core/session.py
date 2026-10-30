"""Staff sign-in and sessions (ADR-0006, SECURITY_MODEL §2.1-2.2, D21, D94).

- **Login** runs on the server. `/auth/login` keeps the PKCE verifier, `state` and `nonce`
  server-side behind the `__Host-shri_login` cookie, which holds only a key (LoginStates);
  `/auth/callback` checks `state`, exchanges the code with Keycloak directly (server to server,
  over TLS, with the client secret and the PKCE verifier), checks the ID token's claims and its
  `nonce`, finds the user, and creates a **new** session. Keycloak's tokens never reach the
  browser.
- **The ID token's signature is not checked here.** It comes straight from Keycloak's token
  endpoint over TLS, which OpenID Connect Core §3.1.3.7 allows in place of the signature; its
  claims are checked (`iss`, `aud`/`azp`, `exp`, `iat`, `nonce`). Tokens that arrive from
  elsewhere (the back-channel logout token, D94) are verified with PyJWT once it's in the lock.
- **The session cookie** `__Host-shri_session` holds a 256-bit reference token; the database
  keeps only its SHA-256 hash, and Keycloak's tokens only as Transit ciphertext (crypto.py).
- **Idle and absolute limits** (15 minutes, 12 hours): only user-initiated requests move the
  idle timer; reading the session, the event stream and operation polling don't.
- **The 5-minute backstop** (D94): a user-initiated request refreshes the stored Keycloak tokens
  when they are older than token_refresh_minutes. If Keycloak refuses (the user was disabled or
  their sessions ended), the session ends there: 401 `session-expired`.
- **CSRF** (§2.2): on POST, PUT, PATCH and DELETE the `Origin` must be allowed and
  `X-CSRF-Token` must equal an HMAC of the session token with SESSION_SECRET, compared in
  constant time. The token is bound to the session and changes at every login.
- **The clinic comes from the server-side session**, never from a token claim (D21).

Per process for now: the login states live in this process's memory for 10 minutes (as
public_form.py's counters); they move to Postgres before more than one API process serves
logins.
"""

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, Request
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core import audit
from app.core.config import Settings
from app.core.crypto import decrypt_field, encrypt_field
from app.core.db import Database
from app.core.errors import Forbidden, ServiceUnavailable, Unauthorized, ValidationFailed
from app.core.lifecycle import on_shutdown
from app.core.request_id import current_request_id

log = logging.getLogger(__name__)

SESSION_COOKIE = "__Host-shri_session"
LOGIN_COOKIE = "__Host-shri_login"
CSRF_HEADER = "x-csrf-token"
LOGIN_STATE_SECONDS = 600
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
TIMEOUT_SECONDS = 5.0
MAX_LOGIN_STATES = 10_000
CLOCK_SKEW_SECONDS = 60
SESSION_STATE = "shri_session"  # request.state key: the signed-in session, for the auth routes

# Requests that never count as user activity (ADR-0006 §3, T9).
_NOT_ACTIVITY = (("GET", "/api/v1/auth/session"), ("GET", "/api/v1/events/stream"),
                 ("GET", "/api/v1/operations/"))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def is_user_activity(method: str, path: str) -> bool:
    return not any(method == m and (path == p or (p.endswith("/") and path.startswith(p)))
                   for m, p in _NOT_ACTIVITY)


# --------------------------------------------------------------------------- login state
@dataclass(frozen=True)
class LoginState:
    state: str
    nonce: str
    verifier: str
    created: float


class LoginStates:
    """PKCE verifier, `state` and `nonce` by login-cookie key, for 10 minutes, used once."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._states: OrderedDict[str, LoginState] = OrderedDict()

    def new(self) -> tuple[str, LoginState]:
        self._forget_old()
        key = secrets.token_urlsafe(32)
        state = LoginState(secrets.token_urlsafe(32), secrets.token_urlsafe(32),
                           secrets.token_urlsafe(64), self._clock())
        self._states[key] = state
        while len(self._states) > MAX_LOGIN_STATES:
            self._states.popitem(last=False)
        return key, state

    def take(self, key: str | None) -> LoginState | None:
        """The state for this key, once; None if unknown, used or older than 10 minutes."""
        self._forget_old()
        return self._states.pop(key, None) if key else None

    def _forget_old(self) -> None:
        cutoff = self._clock() - LOGIN_STATE_SECONDS
        while self._states and next(iter(self._states.values())).created < cutoff:
            self._states.popitem(last=False)


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


# ------------------------------------------------------------------------------ Keycloak
class KeycloakRefused(Exception):
    """Keycloak answered, and said no (an invalid grant, a disabled user, an ended session)."""


@dataclass(frozen=True)
class Tokens:
    access_token: str
    refresh_token: str
    id_claims: dict[str, Any]


def _unverified_claims(id_token: str) -> dict[str, Any]:
    """The ID token's payload. Its signature isn't checked: it came straight from the token
    endpoint over TLS (see the module docstring); its claims are checked by check_id_claims."""
    try:
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError):
        raise ServiceUnavailable("The identity provider sent an unreadable ID token") from None
    if not isinstance(claims, dict):
        raise ServiceUnavailable("The identity provider sent an unreadable ID token")
    return claims


class Keycloak:
    """The staff realm's endpoints, called server to server with the confidential client."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        if not (settings.keycloak_public_url and settings.keycloak_internal_url
                and settings.keycloak_client_secret and settings.keycloak_redirect_uri):
            missing = settings.missing("keycloak_public_url", "keycloak_internal_url",
                                       "keycloak_client_secret", "keycloak_redirect_uri")
            raise ValueError(f"Keycloak sign-in is not configured: set {', '.join(missing)}")
        if settings.session_secret is None or len(settings.session_secret.get_secret_value()) < 32:
            raise ValueError("SESSION_SECRET (at least 32 characters) is needed for sign-in")
        realm = f"/realms/{settings.keycloak_realm}"
        self.issuer = settings.keycloak_public_url.rstrip("/") + realm
        self.authorize_url = f"{self.issuer}/protocol/openid-connect/auth"
        internal = settings.keycloak_internal_url.rstrip("/") + realm + "/protocol/openid-connect"
        self._token_url = f"{internal}/token"
        self._logout_url = f"{internal}/logout"
        self.client_id = settings.keycloak_client_id
        self.redirect_uri = settings.keycloak_redirect_uri
        self._secret = settings.keycloak_client_secret.get_secret_value()
        self._client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=transport)

    def login_redirect(self, state: LoginState) -> str:
        return self.authorize_url + "?" + urlencode({
            "response_type": "code", "client_id": self.client_id,
            "redirect_uri": self.redirect_uri, "scope": "openid", "state": state.state,
            "nonce": state.nonce, "code_challenge": pkce_challenge(state.verifier),
            "code_challenge_method": "S256", "prompt": "login"})

    async def _post(self, url: str, form: dict[str, str]) -> httpx.Response:
        try:
            return await self._client.post(url, data={**form, "client_id": self.client_id,
                                                      "client_secret": self._secret})
        except httpx.HTTPError as error:
            log.error("Keycloak unreachable (%s)", type(error).__name__)
            raise ServiceUnavailable("The identity provider is unavailable") from None

    async def _tokens(self, form: dict[str, str]) -> Tokens:
        response = await self._post(self._token_url, form)
        if response.status_code in (400, 401):
            raise KeycloakRefused(_error_code(response))
        if response.status_code != 200:
            log.error("Keycloak token endpoint answered HTTP %s", response.status_code)
            raise ServiceUnavailable("The identity provider is unavailable")
        try:
            body = response.json()
            access, refresh = body["access_token"], body["refresh_token"]
            id_token = body.get("id_token")
        except (ValueError, KeyError, TypeError):
            raise ServiceUnavailable("The identity provider sent an unreadable answer") from None
        claims = _unverified_claims(id_token) if isinstance(id_token, str) else {}
        return Tokens(str(access), str(refresh), claims)

    async def exchange(self, code: str, verifier: str) -> Tokens:
        return await self._tokens({"grant_type": "authorization_code", "code": code,
                                   "redirect_uri": self.redirect_uri, "code_verifier": verifier})

    async def refresh(self, refresh_token: str) -> Tokens:
        return await self._tokens({"grant_type": "refresh_token", "refresh_token": refresh_token})

    async def end_session(self, refresh_token: str) -> None:
        """Ends the Keycloak login session (back channel). Best effort: ours is ended anyway."""
        try:
            response = await self._post(self._logout_url, {"refresh_token": refresh_token})
            if response.status_code not in (200, 204):
                log.warning("Keycloak logout answered HTTP %s", response.status_code)
        except ServiceUnavailable:
            log.warning("Keycloak logout not reached; our session is ended regardless")

    def check_id_claims(self, claims: dict[str, Any], nonce: str,
                        now: float | None = None) -> None:
        """422 for an ID token that isn't for this login (ADR-0006: a nonce that doesn't match)."""
        now = time.time() if now is None else now
        audience = claims.get("aud")
        audiences = audience if isinstance(audience, list) else [audience]
        problems = [
            claims.get("iss") != self.issuer,
            self.client_id not in audiences,
            len(audiences) > 1 and claims.get("azp") != self.client_id,
            not isinstance(claims.get("exp"), int) or claims["exp"] < now - CLOCK_SKEW_SECONDS,
            not isinstance(claims.get("iat"), int) or claims["iat"] > now + CLOCK_SKEW_SECONDS,
            not isinstance(claims.get("nonce"), str)
            or not hmac.compare_digest(claims["nonce"].encode(), nonce.encode()),
            not isinstance(claims.get("sub"), str) or not claims["sub"],
        ]
        if any(problems):
            log.warning("ID token refused (claims did not match this login)")
            raise ValidationFailed("The sign-in didn't match this login; start again")

    async def aclose(self) -> None:
        await self._client.aclose()


def _error_code(response: httpx.Response) -> str:
    try:
        code = response.json().get("error")
    except ValueError:
        code = None
    return str(code)[:40] if code else f"http-{response.status_code}"


# ------------------------------------------------------------------------------ sessions
@dataclass(frozen=True)
class StaffSession:
    id: UUID
    token: str
    tenant_id: UUID
    user_id: UUID
    idle_expires_at: datetime
    expires_at: datetime
    tokens_refreshed_at: datetime


_LOOKUP_STAFF = text("SELECT user_id, tenant_id, is_active FROM admin.lookup_staff_user(:sub)")
_LOOKUP = text("SELECT session_id, tenant_id, user_id FROM admin.lookup_session(:hash)")
_INSERT = text(
    "INSERT INTO admin.app_session (id, tenant_id, user_id, token_hash, keycloak_access_token_enc, "
    "keycloak_refresh_token_enc, keycloak_sid, idle_expires_at, expires_at, created_by_user_id, "
    "updated_by_user_id) VALUES (:id, :tenant, :user, :hash, :access, :refresh, :sid, "
    "now() + make_interval(mins => :idle), now() + make_interval(hours => :absolute), :user, "
    ":user) RETURNING idle_expires_at, expires_at, tokens_refreshed_at")
_READ = text("SELECT idle_expires_at, expires_at, tokens_refreshed_at, keycloak_refresh_token_enc "
             "FROM admin.app_session WHERE id = :id AND revoked_at IS NULL FOR UPDATE")
_TOUCH = text(
    "UPDATE admin.app_session SET last_activity_at = now(), updated_at = now(), "
    "idle_expires_at = least(expires_at, now() + make_interval(mins => :idle)) "
    "WHERE id = :id RETURNING idle_expires_at")
_NEW_TOKENS = text(
    "UPDATE admin.app_session SET keycloak_access_token_enc = :access, "
    "keycloak_refresh_token_enc = :refresh, tokens_refreshed_at = now(), updated_at = now() "
    "WHERE id = :id")
_REVOKE = text("UPDATE admin.app_session SET revoked_at = now(), updated_at = now() "
               "WHERE id = :id AND revoked_at IS NULL")
_USER = text("SELECT display_name, is_active FROM admin.app_user WHERE id = :id")
_ROLES = text(
    "SELECT r.code, ur.facility_id FROM admin.user_role ur JOIN admin.role r ON r.id = ur.role_id "
    "WHERE ur.user_id = :id AND (ur.valid_from IS NULL OR ur.valid_from <= current_date) "
    "AND (ur.valid_to IS NULL OR ur.valid_to >= current_date)")
_FACILITIES = text("SELECT id FROM admin.facility")
_CLINIC = text("SELECT name FROM admin.tenant WHERE id = :id")


def csrf_token(settings: Settings, session_token: str) -> str:
    if settings.session_secret is None:
        raise ServiceUnavailable("Sign-in is not configured")
    key = settings.session_secret.get_secret_value().encode()
    return hmac.new(key, b"shri-csrf:" + session_token.encode(), hashlib.sha256).hexdigest()


def check_csrf(request: Request, settings: Settings, session_token: str) -> None:
    """ADR-0006 §4: an allowed Origin and the session's CSRF token, on every unsafe method."""
    if request.method not in UNSAFE_METHODS:
        return
    origin = request.headers.get("origin", "")
    allowed = any(hmac.compare_digest(origin.lower().encode(), a.lower().rstrip("/").encode())
                  for a in settings.allowed_origins)
    sent = request.headers.get(CSRF_HEADER, "")
    if not (origin and allowed and hmac.compare_digest(
            sent.encode(), csrf_token(settings, session_token).encode())):
        raise Forbidden("Send the session's CSRF token from an allowed origin",
                        code="csrf-check-failed")


async def find_staff_user(db: Database, subject: str) -> tuple[UUID, UUID]:
    """(user, clinic) for a Keycloak subject. Needs admin.lookup_staff_user() (Anand): until it
    exists, sign-in fails closed with 503."""
    try:
        async with db.sessions() as s:
            row = (await s.execute(_LOOKUP_STAFF, {"sub": subject})).one_or_none()
    except DBAPIError:
        log.error("admin.lookup_staff_user() is missing or failed; staff sign-in is unavailable")
        raise ServiceUnavailable("Sign-in is not available yet") from None
    if row is None or not row.is_active or row.tenant_id is None:
        raise Forbidden("This account can't sign in")  # unknown, deactivated or no clinic
    return row.user_id, row.tenant_id


async def create_session(request: Request, keycloak: Keycloak, tokens: Tokens, user_id: UUID,
                         tenant_id: UUID) -> StaffSession:
    settings: Settings = request.app.state.settings
    db: Database = request.app.state.db
    token = secrets.token_urlsafe(32)  # 256 bits; only its hash is kept
    access = await encrypt_field(request.app, tokens.access_token.encode())
    refresh = await encrypt_field(request.app, tokens.refresh_token.encode())
    session_id = uuid4()
    async with db.tenant_session(tenant_id, user_id, current_request_id()) as s:
        row = (await s.execute(_INSERT, {
            "id": session_id, "tenant": tenant_id, "user": user_id, "hash": token_hash(token),
            "access": access, "refresh": refresh,
            "sid": str(tokens.id_claims.get("sid") or "")[:100] or None,
            "idle": settings.session_idle_minutes,
            "absolute": settings.session_absolute_hours})).one()
        await s.run_sync(lambda sync: audit.insert_rows(sync.connection(), [_security_row(
            request, tenant_id, user_id, "login", "session", session_id)]))
        await s.commit()
    return StaffSession(session_id, token, tenant_id, user_id, row.idle_expires_at,
                        row.expires_at, row.tokens_refreshed_at)


def _security_row(request: Request, tenant_id: UUID, user_id: UUID, action: str,
                  entity: str | None, entity_id: UUID | None,
                  reason: str | None = None) -> dict[str, Any]:
    return {"tenant_id": tenant_id, "actor_type": "user", "actor_user_id": user_id,
            "actor_display": None, "action": action, "outcome": "success",
            "category": "security", "entity_type": entity,
            "entity_id": str(entity_id) if entity_id else None, "patient_id": None,
            "purpose_of_use": None, "reason": reason, "source_ip": audit._client_ip(request),
            "user_agent": (request.headers.get("user-agent") or "")[:300] or None,
            "correlation_id": current_request_id()}


async def revoke(request: Request, session: StaffSession, *, reason: str | None = None,
                 action: str = "logout") -> None:
    db: Database = request.app.state.db
    async with db.tenant_session(session.tenant_id, session.user_id, current_request_id()) as s:
        await s.execute(_REVOKE, {"id": session.id})
        await s.run_sync(lambda sync: audit.insert_rows(sync.connection(), [_security_row(
            request, session.tenant_id, session.user_id, action, "session", session.id,
            reason)]))
        await s.commit()


async def session_from_cookie(request: Request) -> StaffSession:
    """The live session the cookie names; 401 otherwise. Moves the idle timer for user-initiated
    requests, and refreshes Keycloak's tokens when they are older than the backstop allows."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token or len(token) > 100:
        raise Unauthorized("Not signed in")
    db: Database | None = request.app.state.db
    if db is None:
        raise ServiceUnavailable("Database is not configured")
    async with db.sessions() as s:
        found = (await s.execute(_LOOKUP, {"hash": token_hash(token)})).one_or_none()
    if found is None:
        raise Unauthorized("Your session has ended; sign in again", code="session-expired")
    settings: Settings = request.app.state.settings
    activity = is_user_activity(request.method, request.url.path)
    async with db.tenant_session(found.tenant_id, found.user_id, current_request_id()) as s:
        row = (await s.execute(_READ, {"id": found.session_id})).one_or_none()
        if row is None:
            raise Unauthorized("Your session has ended; sign in again", code="session-expired")
        idle = row.idle_expires_at
        if activity:
            idle = (await s.execute(_TOUCH, {"id": found.session_id,
                                             "idle": settings.session_idle_minutes})).scalar_one()
        await s.commit()
    session = StaffSession(found.session_id, token, found.tenant_id, found.user_id, idle,
                           row.expires_at, row.tokens_refreshed_at)
    stale = datetime.now(UTC) - row.tokens_refreshed_at > timedelta(
        minutes=settings.token_refresh_minutes)
    if activity and stale:
        await _refresh_tokens(request, session, row.keycloak_refresh_token_enc)
    return session


async def _refresh_tokens(request: Request, session: StaffSession, refresh_enc: str) -> None:
    keycloak: Keycloak | None = getattr(request.app.state, "keycloak", None)
    if keycloak is None:
        raise ServiceUnavailable("Sign-in is not configured")
    refresh_token = (await decrypt_field(request.app, refresh_enc)).decode()
    try:
        tokens = await keycloak.refresh(refresh_token)
    except KeycloakRefused:
        # Disabled, or the Keycloak session ended: the D94 backstop ends ours too.
        await revoke(request, session, reason="identity-provider-refused-refresh")
        raise Unauthorized("Your session has ended; sign in again",
                           code="session-expired") from None
    db: Database = request.app.state.db
    access = await encrypt_field(request.app, tokens.access_token.encode())
    refresh = await encrypt_field(request.app, tokens.refresh_token.encode())
    async with db.tenant_session(session.tenant_id, session.user_id, current_request_id()) as s:
        await s.execute(_NEW_TOKENS, {"id": session.id, "access": access, "refresh": refresh})
        await s.commit()


async def audit_refresh(request: Request, session: StaffSession) -> None:
    """POST /auth/refresh is a security event (x-audit E security; SELF_AUDITED)."""
    db: Database = request.app.state.db
    async with db.tenant_session(session.tenant_id, session.user_id, current_request_id()) as s:
        await s.run_sync(lambda sync: audit.insert_rows(sync.connection(), [_security_row(
            request, session.tenant_id, session.user_id, "update", "session", session.id,
            "session-extended")]))
        await s.commit()


async def stored_refresh_token(request: Request, session: StaffSession) -> str | None:
    db: Database = request.app.state.db
    async with db.tenant_session(session.tenant_id, session.user_id, current_request_id()) as s:
        row = (await s.execute(_READ, {"id": session.id})).one_or_none()
        await s.rollback()
    if row is None:
        return None
    return (await decrypt_field(request.app, row.keycloak_refresh_token_enc)).decode()


@dataclass(frozen=True)
class UserFacts:
    display_name: str
    roles: frozenset[str]
    facility_ids: frozenset[UUID]
    clinic_name: str


async def user_facts(db: Database, session: StaffSession) -> UserFacts:
    """Who the session's user is today: name, roles and facilities (a role with no facility
    covers every facility of the clinic). 403 for a deactivated account."""
    async with db.tenant_session(session.tenant_id, session.user_id, current_request_id()) as s:
        user = (await s.execute(_USER, {"id": session.user_id})).one_or_none()
        if user is None or not user.is_active:
            raise Forbidden("This account is deactivated")
        roles = (await s.execute(_ROLES, {"id": session.user_id})).all()
        facilities: set[UUID] = {r.facility_id for r in roles if r.facility_id is not None}
        if any(r.facility_id is None for r in roles):
            facilities |= set((await s.execute(_FACILITIES)).scalars().all())
        clinic = (await s.execute(_CLINIC, {"id": session.tenant_id})).scalar_one_or_none()
        await s.rollback()
    return UserFacts(user.display_name, frozenset(r.code for r in roles), frozenset(facilities),
                     clinic or "")


def set_session_cookie(response: Any, token: str) -> None:
    response.set_cookie(SESSION_COOKIE, token, httponly=True, secure=True, samesite="strict",
                        path="/")


def clear_session_cookie(response: Any) -> None:
    response.delete_cookie(SESSION_COOKIE, httponly=True, secure=True, samesite="strict",
                           path="/")


def register(app: FastAPI, settings: Settings) -> None:
    """Staff sign-in; unconfigured, the sign-in routes answer 503."""
    app.state.keycloak = Keycloak(settings) if settings.keycloak_public_url else None
    if app.state.keycloak is not None:
        on_shutdown(app, app.state.keycloak.aclose)
    app.state.login_states = LoginStates()
