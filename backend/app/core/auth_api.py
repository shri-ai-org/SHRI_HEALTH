"""The staff sign-in routes (contract operations startLogin, finishLogin, getSession,
refreshSession, logout; x-owner thulasi). The rules are in session.py.

Login and logout audit themselves as security events (operations.SELF_AUDITED). Staff
back-channel logout (D94, POST /hooks/keycloak/backchannel-logout) is backchannel.py; the
5-minute token refresh stays the backstop if Keycloak can't reach it.
"""

import hmac
import logging
from datetime import UTC
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, Query, Request, Response
from fastapi.responses import RedirectResponse

from app.core import cookies
from app.core import session as sessions
from app.core.config import Settings
from app.core.deps import CurrentUser, require
from app.core.errors import ServiceUnavailable, ValidationFailed, field_error
from app.core.routing import API_PREFIX

log = logging.getLogger(__name__)

router = APIRouter(tags=["platform"])
Signed = Annotated[CurrentUser, Depends(require("authenticated"))]


def _keycloak(request: Request) -> sessions.Keycloak:
    keycloak: sessions.Keycloak | None = getattr(request.app.state, "keycloak", None)
    if keycloak is None:
        raise ServiceUnavailable("Sign-in is not configured")
    return keycloak


def _login_states(request: Request) -> sessions.LoginStates:
    states: sessions.LoginStates = request.app.state.login_states
    return states


@router.get("/auth/login", operation_id="startLogin", status_code=302)
async def start_login(request: Request) -> RedirectResponse:
    keycloak = _keycloak(request)
    key, state = _login_states(request).new()
    response = RedirectResponse(keycloak.login_redirect(state), status_code=302)
    cookies.put(response, request.app.state.settings, sessions.LOGIN_COOKIE, key,
                samesite="lax", max_age=sessions.LOGIN_STATE_SECONDS)
    return response


def _bad_login(name: str) -> ValidationFailed:
    return ValidationFailed("The sign-in didn't match this login; start again",
                            errors=[field_error("query", name, "invalid-format")])


def _start_again(request: Request, cookie: str) -> RedirectResponse:
    """A callback with no matching login (no login cookie, an unknown, used or expired key, or
    another state): 303 back to the sign-in start, never a JSON error, so the browser lands on
    Keycloak's form again. The Location is relative ("login", next to "callback"), so it holds
    under a base path the API never sees. Nothing is signed in, so a forged or replayed callback
    gains nothing; Keycloak's form (prompt=login) waits for the user, so it can't loop on its
    own. The login cookie is cleared; nothing from the request is logged."""
    log.info("Sign-in callback without a matching login; sent back to the sign-in start")
    response = RedirectResponse("login", status_code=303)
    cookies.remove(response, request.app.state.settings, cookie, samesite="lax")
    return response


@router.get("/auth/callback", operation_id="finishLogin", status_code=302)
async def finish_login(
    request: Request,
    code: Annotated[str, Query(min_length=1, max_length=2048)],
    state: Annotated[str, Query(min_length=1, max_length=256)],
) -> RedirectResponse:
    keycloak = _keycloak(request)
    login = _login_states(request).take(cookies.read(request, sessions.LOGIN_COOKIE))
    if login is None:  # no login cookie, an unknown or used key, or older than 10 minutes
        return _start_again(request, sessions.LOGIN_COOKIE)
    if not hmac.compare_digest(state.encode(), login.state.encode()):
        return _start_again(request, sessions.LOGIN_COOKIE)
    try:
        tokens = await keycloak.exchange(code, login.verifier)
    except sessions.KeycloakRefused:
        raise _bad_login("code") from None
    keycloak.check_id_claims(tokens.id_claims, login.nonce)
    user_id, tenant_id = await sessions.find_staff_user(request.app.state.db,
                                                        str(tokens.id_claims["sub"]))
    session = await sessions.create_session(request, keycloak, tokens, user_id, tenant_id)
    settings: Settings = request.app.state.settings
    response = RedirectResponse(settings.after_login_path, status_code=302)
    sessions.set_session_cookie(response, settings, session.token)  # a new ID at every login
    cookies.remove(response, settings, sessions.LOGIN_COOKIE, samesite="lax")
    return response


def _session(request: Request) -> sessions.StaffSession:
    found: sessions.StaffSession | None = getattr(request.state, sessions.SESSION_STATE, None)
    if found is None:  # dev_header sign-in: there's no server session to show or end
        raise ServiceUnavailable("There is no sign-in session in this mode")
    return found


async def _session_body(request: Request, user: CurrentUser,
                        found: sessions.StaffSession) -> dict[str, Any]:
    settings: Settings = request.app.state.settings
    facts = await sessions.user_facts(request.app.state.db, found)
    return {
        "user": sessions.user_body(user, facts.practitioner_id),
        "organization": {"id": str(user.organization_id), "name": facts.clinic_name},
        "csrfToken": sessions.csrf_token(settings, found.token),
        "idleExpiresAt": _time(found.idle_expires_at), "expiresAt": _time(found.expires_at),
        "build": {"version": settings.build_version, "commit": settings.build_commit_short},
    }


def _time(value: Any) -> str:
    return str(value.astimezone(UTC).isoformat().replace("+00:00", "Z"))


@router.get("/auth/session", operation_id="getSession")
async def get_session(request: Request, user: Signed) -> dict[str, Any]:
    return await _session_body(request, user, _session(request))


@router.post("/auth/refresh", operation_id="refreshSession")
async def refresh_session(request: Request, user: Signed) -> dict[str, Any]:
    # current_user already moved the idle timer: this is a user-initiated request (ADR-0006 §3).
    found = _session(request)
    await sessions.audit_refresh(request, found)
    return await _session_body(request, user, found)


@router.post("/auth/logout", operation_id="logout", status_code=204)
async def logout(request: Request, user: Signed) -> Response:
    found = _session(request)
    refresh_token = await sessions.stored_refresh_token(request, found)
    await sessions.revoke(request, found)
    if refresh_token:
        await _keycloak(request).end_session(refresh_token)
    response = Response(status_code=204)
    sessions.clear_session_cookie(response, request.app.state.settings)
    return response


def register(app: FastAPI, settings: Settings) -> None:
    app.include_router(router, prefix=API_PREFIX)
