"""The demo server's portal sign-in with a mobile number and a date of birth (D121; contract
operation signInToPortalForDemo, x-owner thulasi). Demo servers only, synthetic patients only:
the real sign-in (ADR-0013, D85) returns after the demo.

The rules (D121, Thulasi's review on #433):
- **Off unless switched on**, and the switch needs SHRI_DEMO=true outside production, or the API
  refuses to start (Settings._demo_sign_in_only_on_a_demo_server). Off, the route isn't there (404).
- **One answer for every refusal:** `401 unauthenticated` (contract #458), so charts can't be probed;
  only a body that doesn't match the schema is `422`.
- **Rate-limited per client IP and per number.** The guard keeps only a keyed hash of the number.
- **The number and the date of birth are never logged or audited.** A sign-in is audited naming
  the patient; a refusal names no one (a clinic-less `access-denied` row, as for enrolment).
- **The database decides who matches** (admin.demo_portal_patient, 0027): only the demo seed's
  clinic, only exactly one active, unrestricted chart, never a disabled or suspended account.
- **One portal account per patient:** a chart that already has a Keycloak account (Linda Thompson
  and the seeded portal patients) keeps its normal sign-in and gets the same refusal here.
- **A demo session is an ordinary portal session** (portal_sign_in.session_from_cookie, portal_db as
  shri_portal with the one patient), with `sign_in_method` `demo-phone`: no Keycloak tokens, so it
  never refreshes, and it ends at the normal idle and absolute timeouts.

Per process, as the enrolment guard: the counters live in this process's memory (the API runs as
one process on every environment until the shared store exists; DECISIONS "Scheduled work").
"""

import hashlib
import hmac
import logging
import re
import secrets
import time
from collections import deque
from collections.abc import Callable
from datetime import date
from uuid import UUID, uuid4

from fastapi import Request
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.config import Settings
from app.core.db import Database
from app.core.errors import AppError, ServiceUnavailable, Unauthorized
from app.core.portal_sign_in import (
    PortalSessionRow,
    _patient_session,
    _secret,
    _write,
    security_row,
)
from app.core.request_id import current_request_id
from app.core.session import token_hash

log = logging.getLogger(__name__)

METHOD = "demo-phone"
WINDOW_SECONDS = 600
_E164_DIGITS = re.compile(r"^[1-9][0-9]{7,14}$")
_TYPED = re.compile(r"^\+?[0-9 ().-]{10,25}$")

_LOOKUP = text("SELECT tenant_id, patient_id FROM admin.demo_portal_patient(:digits, :birth_date)")
_ACCOUNT = text("SELECT id, status, sign_in_method FROM admin.portal_account "
                "WHERE patient_id = :patient")
_NEW_ACCOUNT = text(
    "INSERT INTO admin.portal_account (id, tenant_id, patient_id, sign_in_method, status, "
    "enrolled_at) VALUES (:id, :tenant, :patient, 'demo-phone', 'active', now())")
_NEW_SESSION = text(
    "INSERT INTO admin.portal_session (id, tenant_id, account_id, patient_id, token_hash, "
    "sign_in_method, idle_expires_at, expires_at) VALUES (:id, :tenant, :account, :patient, "
    ":hash, 'demo-phone', now() + make_interval(mins => :idle), "
    "now() + make_interval(hours => :absolute)) "
    "RETURNING idle_expires_at, expires_at, tokens_refreshed_at")


class TooManyDemoSignIns(AppError):
    default_code = "rate-limited"


def normalize_mobile(typed: str) -> str | None:
    """The E.164 digits without the `+` (`14085550142`), as admin.demo_portal_patient compares
    them: digits only, a 10-digit number read as a U.S. one. None for anything else."""
    if not _TYPED.fullmatch(typed or ""):
        return None
    digits = re.sub(r"[^0-9]", "", typed)
    if len(digits) == 10:
        digits = "1" + digits
    return digits if _E164_DIGITS.fullmatch(digits) else None


class DemoSignInRefused(Unauthorized):
    """A refused demo sign-in: the one 401 for every reason (#458), never saying which."""


def refused() -> DemoSignInRefused:
    """The one answer for every reason the demo sign-in can't open a chart."""
    return DemoSignInRefused("We couldn't sign you in with those details")


class DemoSignInGuard:
    """At most `ip_limit` attempts per client IP and `number_limit` per mobile number in 10
    minutes. The number is kept only as an HMAC under this process's own random key, never as
    typed, and is never logged."""

    def __init__(self, ip_limit: int, number_limit: int,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._limits = {"ip": ip_limit, "number": number_limit}
        self._clock = clock
        self._key = secrets.token_bytes(32)
        self._attempts: dict[str, deque[float]] = {}

    def _number_key(self, number: str) -> str:
        digits = normalize_mobile(number) or re.sub(r"[^0-9]", "", number)
        return "number:" + hmac.new(self._key, digits.encode(), hashlib.sha256).hexdigest()

    def attempt(self, ip: str, number: str) -> None:
        now = self._clock()
        keys = (("ip", "ip:" + ip), ("number", self._number_key(number)))
        windows = []
        for kind, key in keys:
            window = self._attempts.setdefault(key, deque())
            while window and window[0] <= now - WINDOW_SECONDS:
                window.popleft()
            if len(window) >= self._limits[kind]:
                wait = int(window[0] + WINDOW_SECONDS - now) + 1
                raise TooManyDemoSignIns("Too many attempts; try again later",
                                         headers={"Retry-After": str(wait)})
            windows.append(window)
        for window in windows:  # counted only when neither limit refused
            window.append(now)
        while len(self._attempts) > 20_000:
            self._attempts.pop(next(iter(self._attempts)))


async def sign_in(request: Request, mobile_number: str, birth_date: date) -> PortalSessionRow:
    """The chart the database finds for the number and date of birth, its demo-phone account
    (made on the first sign-in) and a new portal session with its audit row, in one transaction.
    Any refusal raises `refused()`."""
    settings: Settings = request.app.state.settings
    db: Database | None = request.app.state.db
    if db is None:
        raise ServiceUnavailable("The demo sign-in is not available")
    _secret(settings.portal_session_secret, "PORTAL_SESSION_SECRET")  # the session's CSRF key
    digits = normalize_mobile(mobile_number)
    if digits is None:
        raise refused()
    async with db.sessions() as s:  # shri_app, no clinic yet: the definer function decides
        found = (await s.execute(_LOOKUP, {"digits": digits, "birth_date": birth_date})
                 ).one_or_none()
        await s.commit()
    if found is None:
        raise refused()
    token = secrets.token_urlsafe(32)  # 256 bits; only its hash is kept
    session_id = uuid4()
    try:
        async with _patient_session(db, found.tenant_id) as s:
            account = (await s.execute(_ACCOUNT, {"patient": found.patient_id})).one_or_none()
            if account is None:
                account_id: UUID = uuid4()
                await s.execute(_NEW_ACCOUNT, {"id": account_id, "tenant": found.tenant_id,
                                               "patient": found.patient_id})
                rows = [security_row(request, found.tenant_id, found.patient_id, "create",
                                     "portal-account", account_id, reason="demo-sign-in")]
            elif account.sign_in_method == METHOD and account.status == "active":
                account_id, rows = account.id, []
            else:  # a Keycloak account keeps its normal sign-in (D121); never two accounts
                await s.rollback()
                raise refused()
            row = (await s.execute(_NEW_SESSION, {
                "id": session_id, "tenant": found.tenant_id, "account": account_id,
                "patient": found.patient_id, "hash": token_hash(token),
                "idle": settings.portal_idle_minutes,
                "absolute": settings.portal_absolute_hours})).one()
            rows.append(security_row(request, found.tenant_id, found.patient_id, "login",
                                     "portal-session", session_id, reason="demo-sign-in"))
            await _write(s, rows)
            await s.commit()
    except IntegrityError:  # two first sign-ins at once: one account per patient
        raise refused() from None
    return PortalSessionRow(session_id, token, found.tenant_id, found.patient_id, account_id,
                            row.idle_expires_at, row.expires_at, row.tokens_refreshed_at)


async def audit_refused(request: Request) -> None:
    """A refused demo sign-in, with no clinic or patient named: only the IP and the request ID,
    never the number or the date of birth. Best effort: the answer is the same either way."""
    db: Database | None = request.app.state.db
    if db is None:
        return
    row = security_row(request, None, None, "access-denied", "portal-session", None,
                       outcome="denied", reason="demo-sign-in-refused")
    row["actor_type"] = "anonymous"
    try:
        async with db.sessions() as s:
            await _write(s, [row])
            await s.commit()
    except Exception:  # noqa: BLE001 (the audit of a refusal must not change the refusal)
        log.warning("Couldn't audit a refused demo sign-in (request %s)", current_request_id())


def guard_for(settings: Settings) -> DemoSignInGuard:
    return DemoSignInGuard(settings.portal_demo_sign_in_ip_limit,
                           settings.portal_demo_sign_in_number_limit)

