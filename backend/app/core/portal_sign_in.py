"""Patient sign-in for the portal (ADR-0013, D84, D85, D92, D93).

The staff model (session.py, ADR-0006) with its own everything, so neither side can use the other:
- **Realm `shri-patients`**, client `shri-portal-web`, its own login-state and session cookies
  (`__Host-shri_portal_login`, `__Host-shri_portal`), its own session table and lookup function,
  its own CSRF key (PORTAL_SESSION_SECRET) and timers (15 minutes idle, 4 hours absolute). A staff
  route never reads the portal cookie and a portal route never reads the staff one.
- **Enrolment only by invitation code** (§3). The front desk issues a code after an ID check
  (`issue_invitation`); it's shown once and stored only as an HMAC (PORTAL_INVITATION_SECRET).
  The patient sends the code, their date of birth and an email (`enroll`). The database checks the
  code and the date of birth together (`admin.redeem_portal_invitation`), so the API never reads
  a date of birth before the patient is known; every failure is the same answer, and a wrong date
  of birth counts toward the fifth, which revokes the code.
- **The realm, not our API, holds the password and the second factor** (D3). Enrolment creates
  the realm user through the service account (`PatientAccounts`, manage-users and view-users in
  that realm only) with the required actions verify-email, set-password and set-up-the-code, and
  asks Keycloak to send its set-up email. Every sign-in then needs the password and the code
  (infra/keycloak/realms/shri-patients.json).
- **The session gives the patient and the clinic**, never the request (D84). Portal reads run as
  shri_portal with app.current_patient_id set (deps.portal_db, D93).

Per process for now, as for staff: the login states, the enrolment counters and the enrolment
Idempotency-Key replays live in this process's memory.
"""

import hashlib
import hmac
import logging
import secrets
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.config import Settings
from app.core.crypto import decrypt_field, encrypt_field
from app.core.db import (
    CORRELATION_SETTING,
    TENANT_ID_INFO_KEY,
    TENANT_SETTING,
    USER_SETTING,
    Database,
)
from app.core.errors import (
    AppError,
    Conflict,
    Forbidden,
    NotFound,
    ServiceUnavailable,
    Unauthorized,
    ValidationFailed,
    field_error,
)
from app.core.lifecycle import on_shutdown
from app.core.request_id import current_request_id
from app.core.session import (
    TIMEOUT_SECONDS,
    UNSAFE_METHODS,
    KeycloakRefused,
    LoginStates,
    OidcClient,
    Tokens,
    token_hash,
)

log = logging.getLogger(__name__)

PORTAL_COOKIE = "__Host-shri_portal"
PORTAL_LOGIN_COOKIE = "__Host-shri_portal_login"
PORTAL_SESSION_STATE = "shri_portal_session_row"  # request.state: the signed-in portal session
MIN_SECRET_LENGTH = 32
INVITATION_HOURS = 72
SETUP_LINK_SECONDS = 12 * 60 * 60  # the realm's set-up email link (§3)
ENROLLMENT_WINDOW_SECONDS = 600
REQUIRED_ACTIONS = ("VERIFY_EMAIL", "UPDATE_PASSWORD", "CONFIGURE_TOTP")

# Crockford base32: no I, L, O or U. 12 characters = 60 bits (§3).
CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 12
_LOOK_ALIKES = str.maketrans({"I": "1", "L": "1", "O": "0"})

# Requests that never move a portal session's idle timer (as for staff, ADR-0006 §3).
_NOT_ACTIVITY = (("GET", "/api/v1/portal/auth/session"),)


class TooManyEnrollments(AppError):
    default_code = "rate-limited"


def _secret(value: Any, name: str) -> bytes:
    raw = value.get_secret_value() if value is not None else ""
    if len(raw) < MIN_SECRET_LENGTH:
        raise ValueError(f"{name} (at least {MIN_SECRET_LENGTH} characters) is needed for the "
                         "patient portal")
    return str(raw).encode()


# ---------------------------------------------------------------------- invitation codes
def new_code() -> str:
    """12 Crockford base32 characters from `secrets`, shown as XXXX-XXXX-XXXX."""
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    return f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"


def normalize_code(code: str) -> str | None:
    """The code as stored: upper case, no dashes, look-alikes read as digits. None if it can't be
    a code (the caller answers the same as for any other failure)."""
    value = code.strip().upper().replace("-", "").translate(_LOOK_ALIKES)
    if len(value) != CODE_LENGTH or any(c not in CODE_ALPHABET for c in value):
        return None
    return value


def code_hmac(key: bytes, normalized: str) -> str:
    return hmac.new(key, b"shri-portal-invitation:" + normalized.encode(),
                    hashlib.sha256).hexdigest()


# ---------------------------------------------------------------------------- the realm
class PortalKeycloak(OidcClient):
    """The patient realm's sign-in endpoints, with shri-portal-web."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        if not (settings.keycloak_public_url and settings.keycloak_internal_url
                and settings.portal_client_secret and settings.portal_redirect_uri):
            missing = settings.missing("keycloak_public_url", "keycloak_internal_url",
                                       "portal_client_secret", "portal_redirect_uri")
            raise ValueError(f"Patient sign-in is not configured: set {', '.join(missing)}")
        super().__init__(public_url=settings.keycloak_public_url,
                         internal_url=settings.keycloak_internal_url,
                         realm=settings.portal_keycloak_realm,
                         client_id=settings.portal_client_id,
                         secret=settings.portal_client_secret.get_secret_value(),
                         redirect_uri=settings.portal_redirect_uri, transport=transport)


class EmailInUse(Exception):
    """The realm already has an account with this email."""


class PatientAccounts:
    """The service account (shri-portal-admin) on the patient realm's admin API: create a
    patient's account, send its set-up email, enable, disable, sign out, reset factors. Its token
    carries manage-users and view-users in this realm only (the realm file)."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None,
                 clock: Callable[[], float] = time.monotonic):
        if not (settings.keycloak_internal_url and settings.portal_admin_client_secret
                and settings.portal_redirect_uri):
            missing = settings.missing("keycloak_internal_url", "portal_admin_client_secret",
                                       "portal_redirect_uri")
            raise ValueError(f"Patient accounts are not configured: set {', '.join(missing)}")
        base = settings.keycloak_internal_url.rstrip("/")
        realm = settings.portal_keycloak_realm
        self._token_url = f"{base}/realms/{realm}/protocol/openid-connect/token"
        self._users_url = f"{base}/admin/realms/{realm}/users"
        self._client_id = settings.portal_admin_client_id
        self._secret = settings.portal_admin_client_secret.get_secret_value()
        self._portal_client = settings.portal_client_id
        self._redirect_uri = settings.portal_redirect_uri
        self._client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=transport)
        self._clock = clock
        self._token: tuple[str, float] | None = None

    async def _call(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        try:
            if method == "TOKEN":
                return await self._client.post(url, data=kwargs["data"])
            headers = {"Authorization": f"Bearer {await self._access_token()}"}
            return await self._client.request(method, url, headers=headers, **kwargs)
        except httpx.HTTPError as error:
            log.error("Patient realm unreachable (%s)", type(error).__name__)
            raise ServiceUnavailable("The patient realm is unavailable") from None

    async def _access_token(self) -> str:
        if self._token and self._token[1] > self._clock():
            return self._token[0]
        response = await self._call("TOKEN", self._token_url, data={
            "grant_type": "client_credentials", "client_id": self._client_id,
            "client_secret": self._secret})
        if response.status_code != 200:
            log.error("Patient realm refused the service account (HTTP %s)", response.status_code)
            raise ServiceUnavailable("The patient realm is unavailable")
        try:
            body = response.json()
            token, lifetime = str(body["access_token"]), int(body.get("expires_in", 60))
        except (ValueError, KeyError, TypeError):
            raise ServiceUnavailable("The patient realm is unavailable") from None
        self._token = (token, self._clock() + max(lifetime - 30, 5))
        return token

    def _expect(self, response: httpx.Response, *ok: int) -> None:
        if response.status_code not in ok:
            log.error("Patient realm admin call answered HTTP %s", response.status_code)
            raise ServiceUnavailable("The patient realm is unavailable")

    async def create_user(self, email: str) -> str:
        """The new realm user's ID; EmailInUse if the address has an account already."""
        response = await self._call("POST", self._users_url, json={
            "username": email, "email": email, "enabled": True, "emailVerified": False,
            "requiredActions": list(REQUIRED_ACTIONS)})
        if response.status_code == 409:
            raise EmailInUse()
        self._expect(response, 201)
        user_id = str(response.headers.get("location", "")).rstrip("/").rsplit("/", 1)[-1]
        if not user_id or len(user_id) > 100:
            raise ServiceUnavailable("The patient realm is unavailable")
        return user_id

    async def send_setup_email(self, user_id: str) -> None:
        response = await self._call(
            "PUT", f"{self._users_url}/{user_id}/execute-actions-email",
            params={"lifespan": SETUP_LINK_SECONDS, "client_id": self._portal_client,
                    "redirect_uri": self._redirect_uri},
            json=list(REQUIRED_ACTIONS))
        self._expect(response, 204)

    async def delete_user(self, user_id: str) -> None:
        """Only to undo a realm user whose enrolment didn't commit."""
        response = await self._call("DELETE", f"{self._users_url}/{user_id}")
        self._expect(response, 204, 404)

    async def set_enabled(self, user_id: str, enabled: bool) -> None:
        response = await self._call("PUT", f"{self._users_url}/{user_id}",
                                    json={"enabled": enabled})
        self._expect(response, 204)

    async def sign_out(self, user_id: str) -> None:
        response = await self._call("POST", f"{self._users_url}/{user_id}/logout")
        self._expect(response, 204)

    async def aclose(self) -> None:
        await self._client.aclose()


# ----------------------------------------------------------------------------- sessions
@dataclass(frozen=True)
class PortalSessionRow:
    id: UUID
    token: str
    tenant_id: UUID
    patient_id: UUID
    account_id: UUID
    idle_expires_at: datetime
    expires_at: datetime
    tokens_refreshed_at: datetime


_LOOKUP = text("SELECT session_id, tenant_id, patient_id FROM admin.lookup_portal_session(:hash)")
_LOOKUP_ACCOUNT = text("SELECT account_id, tenant_id, patient_id, status "
                       "FROM admin.lookup_portal_account(:sub)")
_ACTIVATE = text("UPDATE admin.portal_account SET status = 'active', enrolled_at = now(), "
                 "updated_at = now() WHERE id = :id AND status = 'pending-setup'")
_INSERT = text(
    "INSERT INTO admin.portal_session (id, tenant_id, account_id, patient_id, token_hash, "
    "keycloak_access_token_enc, keycloak_refresh_token_enc, keycloak_sid, idle_expires_at, "
    "expires_at) VALUES (:id, :tenant, :account, :patient, :hash, :access, :refresh, :sid, "
    "now() + make_interval(mins => :idle), now() + make_interval(hours => :absolute)) "
    "RETURNING idle_expires_at, expires_at, tokens_refreshed_at")
_READ = text("SELECT account_id, idle_expires_at, expires_at, tokens_refreshed_at, "
             "keycloak_refresh_token_enc FROM admin.portal_session "
             "WHERE id = :id AND revoked_at IS NULL FOR UPDATE")
_TOUCH = text(
    "UPDATE admin.portal_session SET last_activity_at = now(), updated_at = now(), "
    "idle_expires_at = least(expires_at, now() + make_interval(mins => :idle)) "
    "WHERE id = :id RETURNING idle_expires_at")
_NEW_TOKENS = text(
    "UPDATE admin.portal_session SET keycloak_access_token_enc = :access, "
    "keycloak_refresh_token_enc = :refresh, tokens_refreshed_at = now(), updated_at = now() "
    "WHERE id = :id")
_REVOKE = text("UPDATE admin.portal_session SET revoked_at = now(), updated_at = now() "
               "WHERE id = :id AND revoked_at IS NULL")
_NAME = text(
    "SELECT given, text FROM clinical.human_name WHERE patient_id = :patient "
    "AND (use IS NULL OR use <> 'old') ORDER BY CASE use WHEN 'nickname' THEN 0 "
    "WHEN 'usual' THEN 1 WHEN 'official' THEN 2 ELSE 3 END LIMIT 1")


def _patient_session(db: Database, tenant_id: UUID) -> AsyncSession:
    """A shri_app session in the clinic, with no staff user: the portal's own sign-in rows."""
    return db.system_session(tenant_id, current_request_id())


def csrf_token(settings: Settings, session_token: str) -> str:
    key = _secret(settings.portal_session_secret, "PORTAL_SESSION_SECRET")
    return hmac.new(key, b"shri-portal-csrf:" + session_token.encode(),
                    hashlib.sha256).hexdigest()


def check_csrf(request: Request, settings: Settings, session_token: str) -> None:
    """ADR-0013 §5: on every unsafe method, `Origin` is the portal host and `X-CSRF-Token` is
    the portal session's HMAC."""
    if request.method not in UNSAFE_METHODS:
        return
    from app.core.public_form import origin_matches  # one rule for the portal host's Origin

    sent = request.headers.get("x-csrf-token", "")
    if not (settings.portal_origin
            and origin_matches(request.headers.get("origin"), settings.portal_origin)
            and hmac.compare_digest(sent.encode(), csrf_token(settings, session_token).encode())):
        raise Forbidden("Send the session's CSRF token from the portal", code="csrf-check-failed")


def security_row(request: Request, tenant_id: UUID | None, patient_id: UUID | None, action: str,
                 entity: str | None, entity_id: UUID | None, *, outcome: str = "success",
                 reason: str | None = None) -> dict[str, Any]:
    """An audit row with the patient as the actor (§6); never a code, a date of birth, an email
    or a token."""
    return {"tenant_id": tenant_id, "actor_type": "patient", "actor_user_id": None,
            "actor_display": None, "action": action, "outcome": outcome,
            "category": "security", "entity_type": entity,
            "entity_id": str(entity_id) if entity_id else None, "patient_id": patient_id,
            "purpose_of_use": None, "reason": reason, "source_ip": audit._client_ip(request),
            "user_agent": (request.headers.get("user-agent") or "")[:300] or None,
            "correlation_id": current_request_id()}


async def _write(session: AsyncSession, rows: list[dict[str, Any]]) -> None:
    await session.run_sync(lambda sync: audit.insert_rows(sync.connection(), rows))


async def sign_in(request: Request, keycloak: PortalKeycloak, tokens: Tokens) -> PortalSessionRow:
    """At /callback: the account behind the realm user, then a new portal session. A
    pending-setup account becomes active (the realm only issues tokens once its set-up is done).
    An unknown, disabled or suspended account can't sign in: 422 (the contract's only refusal
    here), with nothing that says which."""
    settings: Settings = request.app.state.settings
    db: Database = request.app.state.db
    async with db.sessions() as s:
        account = (await s.execute(_LOOKUP_ACCOUNT, {"sub": str(tokens.id_claims["sub"])})
                   ).one_or_none()
    if account is None:
        log.warning("Portal sign-in refused: no live account for this realm user")
        raise ValidationFailed("This account can't sign in to the portal; ask your clinic",
                               errors=[field_error("query", "code", "not-allowed-value")])
    token = secrets.token_urlsafe(32)  # 256 bits; only its hash is kept
    access = await encrypt_field(request.app, tokens.access_token.encode())
    refresh = await encrypt_field(request.app, tokens.refresh_token.encode())
    session_id = uuid4()
    async with _patient_session(db, account.tenant_id) as s:
        if account.status == "pending-setup":
            await s.execute(_ACTIVATE, {"id": account.account_id})
        row = (await s.execute(_INSERT, {
            "id": session_id, "tenant": account.tenant_id, "account": account.account_id,
            "patient": account.patient_id, "hash": token_hash(token), "access": access,
            "refresh": refresh, "sid": str(tokens.id_claims.get("sid") or "")[:100] or None,
            "idle": settings.portal_idle_minutes,
            "absolute": settings.portal_absolute_hours})).one()
        await _write(s, [security_row(request, account.tenant_id, account.patient_id, "login",
                                      "portal-session", session_id)])
        await s.commit()
    return PortalSessionRow(session_id, token, account.tenant_id, account.patient_id,
                            account.account_id, row.idle_expires_at, row.expires_at,
                            row.tokens_refreshed_at)


async def session_from_cookie(request: Request) -> PortalSessionRow:
    """The live portal session the cookie names; 401 otherwise. Moves the idle timer for
    user-initiated requests, and refreshes the realm's tokens when they are older than the
    backstop allows (a patient disabled in the realm loses the session there)."""
    token = request.cookies.get(PORTAL_COOKIE)
    if not token or len(token) > 100:
        raise Unauthorized("Not signed in to the patient portal")
    db: Database | None = request.app.state.db
    if db is None:
        raise ServiceUnavailable("Database is not configured")
    async with db.sessions() as s:
        found = (await s.execute(_LOOKUP, {"hash": token_hash(token)})).one_or_none()
    if found is None:
        raise Unauthorized("Your session has ended; sign in again", code="session-expired")
    settings: Settings = request.app.state.settings
    activity = (request.method, request.url.path) not in _NOT_ACTIVITY
    async with _patient_session(db, found.tenant_id) as s:
        row = (await s.execute(_READ, {"id": found.session_id})).one_or_none()
        if row is None:
            raise Unauthorized("Your session has ended; sign in again", code="session-expired")
        idle = row.idle_expires_at
        if activity:
            idle = (await s.execute(_TOUCH, {"id": found.session_id,
                                             "idle": settings.portal_idle_minutes})).scalar_one()
        await s.commit()
    session = PortalSessionRow(found.session_id, token, found.tenant_id, found.patient_id,
                               row.account_id, idle, row.expires_at, row.tokens_refreshed_at)
    stale = datetime.now(UTC) - row.tokens_refreshed_at > timedelta(
        minutes=settings.token_refresh_minutes)
    if activity and stale:
        await _refresh_tokens(request, session, row.keycloak_refresh_token_enc)
    return session


async def _refresh_tokens(request: Request, session: PortalSessionRow, refresh_enc: str) -> None:
    keycloak: PortalKeycloak | None = getattr(request.app.state, "portal_keycloak", None)
    if keycloak is None:
        raise ServiceUnavailable("Patient sign-in is not configured")
    refresh_token = (await decrypt_field(request.app, refresh_enc)).decode()
    try:
        tokens = await keycloak.refresh(refresh_token)
    except KeycloakRefused:
        await revoke(request, session, reason="identity-provider-refused-refresh")
        raise Unauthorized("Your session has ended; sign in again",
                           code="session-expired") from None
    db: Database = request.app.state.db
    access = await encrypt_field(request.app, tokens.access_token.encode())
    refresh = await encrypt_field(request.app, tokens.refresh_token.encode())
    async with _patient_session(db, session.tenant_id) as s:
        await s.execute(_NEW_TOKENS, {"id": session.id, "access": access, "refresh": refresh})
        await s.commit()


async def revoke(request: Request, session: PortalSessionRow, *, reason: str | None = None,
                 action: str = "logout") -> None:
    db: Database = request.app.state.db
    async with _patient_session(db, session.tenant_id) as s:
        await s.execute(_REVOKE, {"id": session.id})
        await _write(s, [security_row(request, session.tenant_id, session.patient_id, action,
                                      "portal-session", session.id, reason=reason)])
        await s.commit()


async def audit_refresh(request: Request, session: PortalSessionRow) -> None:
    db: Database = request.app.state.db
    async with _patient_session(db, session.tenant_id) as s:
        await _write(s, [security_row(request, session.tenant_id, session.patient_id, "update",
                                      "portal-session", session.id, reason="session-extended")])
        await s.commit()


async def stored_refresh_token(request: Request, session: PortalSessionRow) -> str | None:
    db: Database = request.app.state.db
    async with _patient_session(db, session.tenant_id) as s:
        row = (await s.execute(_READ, {"id": session.id})).one_or_none()
        await s.rollback()
    if row is None:
        return None
    return (await decrypt_field(request.app, row.keycloak_refresh_token_enc)).decode()


async def display_name(request: Request, session: PortalSessionRow) -> str:
    """The name the portal greets the patient by: their preferred name (D57), else the given
    name; never the family name alone."""
    db: Database = request.app.state.db
    async with _patient_session(db, session.tenant_id) as s:
        row = (await s.execute(_NAME, {"patient": session.patient_id})).one_or_none()
        await s.rollback()
    if row is None:
        return ""
    given = [g for g in (row.given or []) if g]
    return str(given[0] if given else (row.text or ""))[:200]


def set_session_cookie(response: Any, token: str) -> None:
    response.set_cookie(PORTAL_COOKIE, token, httponly=True, secure=True, samesite="strict",
                        path="/")


def clear_session_cookie(response: Any) -> None:
    response.delete_cookie(PORTAL_COOKIE, httponly=True, secure=True, samesite="strict",
                           path="/")


# --------------------------------------------------------------------------- invitations
_OPEN_INVITATIONS = text(
    "UPDATE admin.portal_invitation SET revoked_at = now(), updated_at = now(), "
    "updated_by_user_id = :user WHERE patient_id = :patient AND used_at IS NULL "
    "AND revoked_at IS NULL")
_NEW_INVITATION = text(
    "INSERT INTO admin.portal_invitation (id, tenant_id, patient_id, code_hmac, "
    "issued_by_user_id, expires_at, created_by_user_id, updated_by_user_id) VALUES (:id, "
    ":tenant, :patient, :hmac, :user, now() + make_interval(hours => :hours), :user, :user) "
    "RETURNING expires_at")
_REVOKE_INVITATION = text(
    "UPDATE admin.portal_invitation SET revoked_at = now(), updated_at = now(), "
    "updated_by_user_id = :user WHERE id = :id AND patient_id = :patient AND used_at IS NULL "
    "AND revoked_at IS NULL RETURNING id")
_INVITATION_STATE = text(
    "SELECT used_at IS NOT NULL AS used FROM admin.portal_invitation "
    "WHERE id = :id AND patient_id = :patient")
_ACCOUNT_STATE = text("SELECT status FROM admin.portal_account WHERE patient_id = :patient "
                      "AND status IN ('pending-setup', 'active')")


@dataclass(frozen=True)
class IssuedInvitation:
    id: UUID
    code: str  # shown once, never stored or logged
    expires_at: datetime


async def issue_invitation(db: AsyncSession, settings: Settings, patient_id: UUID,
                           user_id: UUID) -> IssuedInvitation:
    """For createPortalInvitation (x-owner Vimal), in the staff request's tenant session
    (tenant_db): revoke the patient's open invitation, if any, and make a new one (one open per
    patient, §3). 409 `invalid-state-transition` if the chart already has a live account. The
    caller has checked the chart (ensure_chart_access, not merged), audits and commits; the code
    is in the response only, never logged."""
    key = _secret(settings.portal_invitation_secret, "PORTAL_INVITATION_SECRET")
    tenant_id = db.info.get(TENANT_ID_INFO_KEY)
    if not isinstance(tenant_id, UUID):
        raise RuntimeError("issue_invitation needs a clinic session (tenant_db)")
    account = (await db.execute(_ACCOUNT_STATE, {"patient": patient_id})).scalar_one_or_none()
    if account is not None:
        raise Conflict("This patient already has a portal account", currentState=account)
    code = new_code()
    invitation_id = uuid4()
    await db.execute(_OPEN_INVITATIONS, {"patient": patient_id, "user": user_id})
    expires = (await db.execute(_NEW_INVITATION, {
        "id": invitation_id, "tenant": tenant_id, "patient": patient_id,
        "hmac": code_hmac(key, normalize_code(code) or ""), "user": user_id,
        "hours": INVITATION_HOURS})).scalar_one()
    return IssuedInvitation(invitation_id, code, expires)


async def revoke_invitation(db: AsyncSession, patient_id: UUID, invitation_id: UUID,
                            user_id: UUID) -> None:
    """For revokePortalInvitation (x-owner Vimal): 404 for an invitation that isn't this
    patient's, 409 for one already used; one already revoked or expired stays as it is (safe to
    repeat)."""
    revoked = (await db.execute(_REVOKE_INVITATION, {"id": invitation_id, "patient": patient_id,
                                                     "user": user_id})).first()
    if revoked is not None:
        return
    state = (await db.execute(_INVITATION_STATE, {"id": invitation_id, "patient": patient_id})
             ).one_or_none()
    if state is None:
        raise NotFound()
    if state.used:
        raise Conflict("This invitation was already used", currentState="used")


# ---------------------------------------------------------------------------- enrolment
_REDEEM = text("SELECT tenant_id, patient_id, invitation_id "
               "FROM admin.redeem_portal_invitation(:hmac, :birth_date)")
_LIVE_ACCOUNT = text("SELECT 1 FROM admin.portal_account WHERE patient_id = :patient "
                     "AND status IN ('pending-setup', 'active')")
_NEW_ACCOUNT = text(
    "INSERT INTO admin.portal_account (id, tenant_id, keycloak_user_id, patient_id) "
    "VALUES (:id, :tenant, :kc, :patient)")


def code_refused() -> ValidationFailed:
    """The one answer for every reason a code can't be used (§3): unknown, expired, used,
    revoked, a wrong date of birth, a chart that already has an account, an email in use."""
    return ValidationFailed("We couldn't use that code", code="business-rule-violation",
                            errors=[field_error("body", "/invitationCode", "not-allowed-value")])


class EnrollmentGuard:
    """Per client IP, at most `limit` enrolment attempts in 10 minutes (nginx limits too), and the
    replay of a finished request for its Idempotency-Key: the same body gets the same 204, another
    body 422 `idempotency-key-reused`."""

    def __init__(self, limit: int, clock: Callable[[], float] = time.monotonic) -> None:
        self._limit = limit
        self._clock = clock
        self._attempts: dict[str, deque[float]] = {}
        self._done: OrderedDict[str, tuple[str, float]] = OrderedDict()

    def attempt(self, ip: str) -> None:
        now = self._clock()
        window = self._attempts.setdefault(ip, deque())
        while window and window[0] <= now - ENROLLMENT_WINDOW_SECONDS:
            window.popleft()
        if len(window) >= self._limit:
            wait = int(window[0] + ENROLLMENT_WINDOW_SECONDS - now) + 1
            raise TooManyEnrollments("Too many attempts; try again later",
                                     headers={"Retry-After": str(wait)})
        window.append(now)
        if len(self._attempts) > 10_000:
            self._attempts.pop(next(iter(self._attempts)))

    def replayed(self, key: str | None, body_hash: str) -> bool:
        if not key:
            return False
        now = self._clock()
        while self._done and next(iter(self._done.values()))[1] <= now:
            self._done.popitem(last=False)
        done = self._done.get(key)
        if done is None:
            return False
        if not hmac.compare_digest(done[0], body_hash):
            raise ValidationFailed("This Idempotency-Key was used with a different body",
                                   code="idempotency-key-reused")
        return True

    def finished(self, key: str | None, body_hash: str) -> None:
        if key:
            self._done[key] = (body_hash, self._clock() + 24 * 60 * 60)
            while len(self._done) > 10_000:
                self._done.popitem(last=False)


async def enroll(request: Request, code: str, birth_date: date, email: str) -> None:
    """§3, steps 2 and 3, in one transaction: redeem the code with the date of birth, create the
    realm user, record its account (pending-setup) and the audit row. A failure to redeem still
    commits, so wrong dates of birth count. If the realm user is created but the transaction
    doesn't commit, the realm user is deleted again. The set-up email goes after the commit; if
    it can't be sent, the patient can still use "Forgot password" on the sign-in page, which
    reaches the same verified-email and set-up steps."""
    settings: Settings = request.app.state.settings
    db: Database | None = request.app.state.db
    accounts: PatientAccounts | None = getattr(request.app.state, "patient_accounts", None)
    if db is None or accounts is None:
        raise ServiceUnavailable("Enrolment is not available")
    key = _secret(settings.portal_invitation_secret, "PORTAL_INVITATION_SECRET")
    normalized = normalize_code(code)
    if normalized is None:
        raise code_refused()
    async with db.sessions() as s:
        redeemed = (await s.execute(_REDEEM, {"hmac": code_hmac(key, normalized),
                                              "birth_date": birth_date})).one_or_none()
        if redeemed is None:
            await s.commit()  # a wrong date of birth counted toward the fifth (§3)
            raise code_refused()
        # The clinic is known from here: the same transaction continues inside it.
        for name, value in ((TENANT_SETTING, str(redeemed.tenant_id)), (USER_SETTING, ""),
                            (CORRELATION_SETTING, current_request_id() or "")):
            await s.execute(text("SELECT set_config(:n, :v, true)"), {"n": name, "v": value})
        if (await s.execute(_LIVE_ACCOUNT, {"patient": redeemed.patient_id})).first():
            await s.rollback()  # one account per chart (§3.5); the code stays usable
            raise code_refused()
        try:
            realm_user = await accounts.create_user(email)
        except EmailInUse:
            await s.rollback()
            raise code_refused() from None
        account_id = uuid4()
        try:
            await s.execute(_NEW_ACCOUNT, {"id": account_id, "tenant": redeemed.tenant_id,
                                           "kc": realm_user, "patient": redeemed.patient_id})
            await _write(s, [security_row(request, redeemed.tenant_id, redeemed.patient_id,
                                          "create", "portal-account", account_id,
                                          reason="enrolled")])
            await s.commit()
        except BaseException:
            await s.rollback()
            try:
                await accounts.delete_user(realm_user)
            except ServiceUnavailable:
                log.error("Enrolment failed and its realm user couldn't be deleted (request %s)",
                          current_request_id())
            raise
    try:
        await accounts.send_setup_email(realm_user)
    except ServiceUnavailable:
        log.error("The set-up email couldn't be sent; the patient can use Forgot password "
                  "(request %s)", current_request_id())


async def audit_refused_enrollment(request: Request) -> None:
    """A refused enrolment, with no clinic or patient known (§6, A47): only the IP and the
    request ID. Best effort: the answer is the same either way."""
    db: Database | None = request.app.state.db
    if db is None:
        return
    # A clinic-less row may only be a security event, `login` or `access-denied` (A47, 0005).
    row = security_row(request, None, None, "access-denied", "portal-invitation", None,
                       outcome="denied", reason="enrolment-refused")
    row["actor_type"] = "anonymous"
    try:
        async with db.sessions() as s:
            await _write(s, [row])
            await s.commit()
    except Exception:  # noqa: BLE001 (the audit of a refusal must not change the refusal)
        log.warning("Couldn't audit a refused enrolment (request %s)", current_request_id())


def register(app: FastAPI, settings: Settings) -> None:
    """Patient sign-in and enrolment; unconfigured, their routes answer 503."""
    app.state.portal_keycloak = (PortalKeycloak(settings) if settings.portal_client_secret
                                 else None)
    if app.state.portal_keycloak is not None:
        on_shutdown(app, app.state.portal_keycloak.aclose)
    app.state.patient_accounts = (PatientAccounts(settings)
                                  if settings.portal_admin_client_secret else None)
    if app.state.patient_accounts is not None:
        on_shutdown(app, app.state.patient_accounts.aclose)
    if settings.portal_client_secret or settings.portal_admin_client_secret:
        _secret(settings.portal_session_secret, "PORTAL_SESSION_SECRET")
        _secret(settings.portal_invitation_secret, "PORTAL_INVITATION_SECRET")
    app.state.portal_db = (Database(settings, settings.portal_database_url)
                           if settings.portal_database_url else None)
    if app.state.portal_db is not None:
        on_shutdown(app, app.state.portal_db.dispose)
    app.state.portal_login_states = LoginStates()
    app.state.enrollment_guard = EnrollmentGuard(settings.portal_enrollment_ip_limit)
