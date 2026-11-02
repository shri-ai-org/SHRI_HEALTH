"""The patient portal's sign-in routes (contract operations startPortalLogin, completePortalLogin,
getPortalSession, refreshPortalSession, signOutOfPortal and enrollInPortal; x-owner thulasi).
The rules are in portal_sign_in.py.

They audit themselves as security events (operations.SELF_AUDITED), with the patient as the
actor once known, and a clinic-less `access-denied` row for a refused enrolment (A47).
"""

import hashlib
import hmac
import json
from datetime import UTC, date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field

from app.core import audit
from app.core import portal_sign_in as portal
from app.core.config import Settings
from app.core.deps import PortalPatient, require_patient
from app.core.errors import ServiceUnavailable, ValidationFailed, field_error
from app.core.public_form import require_portal_origin
from app.core.routing import API_PREFIX
from app.core.session import KeycloakRefused

router = APIRouter(tags=["portal"])
Patient = Annotated[PortalPatient, Depends(require_patient("authenticated"))]


def _keycloak(request: Request) -> portal.PortalKeycloak:
    keycloak: portal.PortalKeycloak | None = getattr(request.app.state, "portal_keycloak", None)
    if keycloak is None:
        raise ServiceUnavailable("The patient realm is unavailable")
    return keycloak


@router.get("/portal/auth/login", operation_id="startPortalLogin", status_code=302)
async def start_portal_login(request: Request) -> RedirectResponse:
    keycloak = _keycloak(request)
    key, state = request.app.state.portal_login_states.new()
    response = RedirectResponse(keycloak.login_redirect(state), status_code=302)
    response.set_cookie(portal.PORTAL_LOGIN_COOKIE, key, max_age=600, httponly=True, secure=True,
                        samesite="lax", path="/")
    return response


def _bad_login(name: str) -> ValidationFailed:
    return ValidationFailed("The sign-in didn't match this login; start again",
                            errors=[field_error("query", name, "invalid-format")])


@router.get("/portal/auth/callback", operation_id="completePortalLogin", status_code=302)
async def complete_portal_login(
    request: Request,
    code: Annotated[str, Query(min_length=1, max_length=2048)],
    state: Annotated[str, Query(min_length=1, max_length=256)],
) -> RedirectResponse:
    keycloak = _keycloak(request)
    login = request.app.state.portal_login_states.take(
        request.cookies.get(portal.PORTAL_LOGIN_COOKIE))
    if login is None or not hmac.compare_digest(state.encode(), login.state.encode()):
        raise _bad_login("state")
    try:
        tokens = await keycloak.exchange(code, login.verifier)
    except KeycloakRefused:
        raise _bad_login("code") from None
    keycloak.check_id_claims(tokens.id_claims, login.nonce)
    found = await portal.sign_in(request, keycloak, tokens)
    settings: Settings = request.app.state.settings
    response = RedirectResponse(settings.portal_after_login_path, status_code=302)
    portal.set_session_cookie(response, found.token)  # a new session ID at every sign-in
    response.delete_cookie(portal.PORTAL_LOGIN_COOKIE, httponly=True, secure=True, samesite="lax",
                           path="/")
    return response


def _found(request: Request) -> portal.PortalSessionRow:
    found: portal.PortalSessionRow | None = getattr(request.state, portal.PORTAL_SESSION_STATE,
                                                     None)
    if found is None:  # the dev_header stand-in: there's no server session to show or end
        raise ServiceUnavailable("There is no sign-in session in this mode")
    return found


def _time(value: Any) -> str:
    return str(value.astimezone(UTC).isoformat().replace("+00:00", "Z"))


async def _session_body(request: Request, found: portal.PortalSessionRow) -> dict[str, Any]:
    settings: Settings = request.app.state.settings
    return {"patient": {"displayName": await portal.display_name(request, found)},
            "csrfToken": portal.csrf_token(settings, found.token),
            "idleExpiresAt": _time(found.idle_expires_at), "expiresAt": _time(found.expires_at)}


@router.get("/portal/auth/session", operation_id="getPortalSession")
async def get_portal_session(request: Request, patient: Patient) -> dict[str, Any]:
    return await _session_body(request, _found(request))


@router.post("/portal/auth/refresh", operation_id="refreshPortalSession")
async def refresh_portal_session(request: Request, patient: Patient) -> dict[str, Any]:
    # current_patient already moved the idle timer: this is a user-initiated request.
    found = _found(request)
    await portal.audit_refresh(request, found)
    return await _session_body(request, found)


@router.post("/portal/auth/logout", operation_id="signOutOfPortal", status_code=204)
async def sign_out_of_portal(request: Request, patient: Patient) -> Response:
    found = _found(request)
    refresh_token = await portal.stored_refresh_token(request, found)
    await portal.revoke(request, found)
    if refresh_token:
        await _keycloak(request).end_session(refresh_token)
    response = Response(status_code=204)
    portal.clear_session_cookie(response)
    return response


class EnrollmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    invitation_code: str = Field(alias="invitationCode", min_length=12, max_length=14,
                                 pattern=r"^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$")
    birth_date: date = Field(alias="birthDate")
    # The realm verifies the address before the first sign-in; this only refuses what can't be one.
    email: str = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@router.post("/portal/enrollments", operation_id="enrollInPortal", status_code=204)
async def enroll_in_portal(request: Request, body: EnrollmentRequest) -> Response:
    """§3: the code, the date of birth and an email, from the portal host only. Every reason
    the code can't be used gets the same 422; a retry with the same Idempotency-Key and body
    gets the same 204."""
    require_portal_origin(request)
    guard: portal.EnrollmentGuard = request.app.state.enrollment_guard
    guard.attempt(audit._client_ip(request) or "unknown")
    key = request.headers.get("idempotency-key")
    body_hash = hashlib.sha256(json.dumps(
        {"c": portal.normalize_code(body.invitation_code) or body.invitation_code,
         "b": body.birth_date.isoformat(), "e": body.email.lower()},
        sort_keys=True).encode()).hexdigest()
    if guard.replayed(key, body_hash):
        return Response(status_code=204)
    try:
        await portal.enroll(request, body.invitation_code, body.birth_date, body.email)
    except ValidationFailed:
        await portal.audit_refused_enrollment(request)
        raise
    guard.finished(key, body_hash)
    return Response(status_code=204)


def register(app: FastAPI, settings: Settings) -> None:
    app.include_router(router, prefix=API_PREFIX)
