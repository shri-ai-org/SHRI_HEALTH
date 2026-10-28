"""The building blocks every endpoint uses: current_user, require() and tenant_db.

    @router.get("/patients/{patient_id}")
    async def get_patient(
        patient_id: UUID,
        user: CurrentUser = Depends(require("patients:read")),
        db: AsyncSession = Depends(tenant_db),
    ): ...

These signatures are final. The bodies are Day 1 STAND-INS: in development and test,
current_user reads a synthetic test user from the X-Dev-User header (see DEV_USERS).
Real Keycloak login replaces the body later; endpoint code does not change.
"""

import logging
from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit, idempotency, permissions
from app.core.config import Settings
from app.core.db import Database
from app.core.errors import Forbidden, NotFound, ServiceUnavailable, Unauthorized
from app.core.operations import operation_for
from app.core.request_id import current_request_id

DEV_USER_HEADER = "X-Dev-User"
_PERMISSION_CHECKED = "shri_permission_checked"

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class CurrentUser:
    id: UUID
    organization_id: UUID
    roles: frozenset[str]
    facility_ids: frozenset[UUID] = field(default_factory=frozenset)
    display_name: str = ""

    def can(self, permission: str) -> bool:
        return permissions.roles_allow(self.roles, permission)

    @property
    def is_shared_display(self) -> bool:
        """A shared screen (role DSP only): the status board shows initials and times only."""
        return self.roles == frozenset({permissions.SHARED_DISPLAY_ROLE})


# Synthetic users for local development and tests only (T5): one per role in clinic A, a
# user with no roles for permission-denied tests, and "md-b" in clinic B for cross-clinic
# tests (it must never see clinic A's data).
CLINIC_A = UUID("0a000000-0000-4000-8000-00000000000a")
CLINIC_B = UUID("0b000000-0000-4000-8000-00000000000b")
FACILITY_A = UUID("fa000000-0000-4000-8000-00000000000a")
FACILITY_B = UUID("fb000000-0000-4000-8000-00000000000b")

_DEV_ROLE_ORDER = ("FD", "MA", "RN", "MD", "APP", "BIL", "ADM", "CO", "SUP", "DSP")


def _dev_user(n: int, clinic: UUID, facility: UUID, roles: set[str], name: str) -> CurrentUser:
    return CurrentUser(
        id=UUID(f"d0000000-0000-4000-8000-{n:012d}"),
        organization_id=clinic,
        roles=frozenset(roles),
        facility_ids=frozenset({facility}),
        display_name=name,
    )


DEV_USERS: dict[str, CurrentUser] = {
    role.lower(): _dev_user(n, CLINIC_A, FACILITY_A, {role}, f"Dev {role}")
    for n, role in enumerate(_DEV_ROLE_ORDER, start=1)
}
DEV_USERS["none"] = _dev_user(90, CLINIC_A, FACILITY_A, set(), "Dev No Roles")
DEV_USERS["md-b"] = _dev_user(91, CLINIC_B, FACILITY_B, {"MD"}, "Dev MD (Clinic B)")


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


async def current_user(request: Request) -> CurrentUser:
    settings = _settings(request)
    if settings.auth_mode == "dev_header":
        name = request.headers.get(DEV_USER_HEADER)
        if not name:
            raise Unauthorized(f"Send the {DEV_USER_HEADER} header with a test user name")
        user = DEV_USERS.get(name)
        if user is None:
            raise Unauthorized(f"Unknown test user; use one of: {', '.join(DEV_USERS)}")
        return user
    # Staff sign-in (core/session.py). CSRF first, from the cookie alone, so a forged request
    # never reaches the session, let alone moves its idle timer.
    from app.core import session as sessions  # session builds on this module

    token = request.cookies.get(sessions.SESSION_COOKIE)
    if not token:
        raise Unauthorized("Not signed in")
    sessions.check_csrf(request, settings, token)
    found = await sessions.session_from_cookie(request)
    facts = await sessions.user_facts(request.app.state.db, found)
    setattr(request.state, sessions.SESSION_STATE, found)  # for /auth/session, refresh, logout
    return CurrentUser(id=found.user_id, organization_id=found.tenant_id, roles=facts.roles,
                       facility_ids=facts.facility_ids, display_name=facts.display_name)


def require(permission: str) -> Callable[..., Coroutine[Any, Any, CurrentUser]]:
    """`require("patients:read")`, or `require("authenticated")` for any signed-in user.

    Unknown permission names fail at import time, so a typo never ships as an open endpoint.
    """
    if not permissions.is_known_permission(permission):
        raise ValueError(
            f"Unknown permission {permission!r}: use a name from the catalogue in "
            "app/core/permissions.py (SECURITY_MODEL §4.2), or 'authenticated'"
        )

    async def check(request: Request, user: CurrentUser = Depends(current_user)) -> CurrentUser:
        await _check_permission(request, user, permission)
        return user

    check.__name__ = f"require_{permission.replace(':', '_').replace('-', '_')}"
    check.shri_permission = permission  # type: ignore[attr-defined]  # read by route_problems()
    return check


async def _check_permission(request: Request, user: CurrentUser, permission: str) -> None:
    if not user.can(permission):
        await audit.record_denial(request, user, permission)
        raise Forbidden(f"Requires {permission}")
    setattr(request.state, _PERMISSION_CHECKED, permission)  # tenant_db looks for this


def _require_was_checked(request: Request) -> None:
    """Runs at the session's first query, after all of the endpoint's dependencies, so the order
    in which an endpoint lists require() and tenant_db does not matter."""
    if getattr(request.state, _PERMISSION_CHECKED, None):
        return
    log.error("tenant_db used without require() on %s %s", request.method, request.url.path)
    if _settings(request).environment in ("development", "test"):
        # Loud in development and tests, so the missing check is fixed before it ships.
        raise RuntimeError("tenant_db needs Depends(require(...)) on the same endpoint")
    raise Forbidden("This endpoint does not check a permission")


async def tenant_db(
    request: Request, user: CurrentUser = Depends(current_user)
) -> AsyncIterator[AsyncSession]:
    """A session scoped to the caller's clinic. Call `await db.commit()` to save; anything
    not committed when the request ends is rolled back.

    Only for endpoints that also use require(): row-level security separates clinics, but not
    users within a clinic. Without a permission check the first query fails (500 in development
    and tests, 403 elsewhere).

    The operation's audit rows (x-audit) go in with the endpoint's first commit, or are written
    before the response if it makes none (app/core/audit.py).

    For an operation with x-idempotency, the Idempotency-Key is claimed here, before the
    endpoint runs, and a finished key's stored response is sent instead of running it again
    (app/core/idempotency.py)."""
    db: Database | None = request.app.state.db
    if db is None:
        raise ServiceUnavailable("Database is not configured")
    # The clinic and user come from the server-side session (current_user), never from
    # request headers or the body (D21).
    from app.core.access import check_facility_query  # access builds on this module

    operation = operation_for(request.scope.get("route"))
    if operation is not None and idempotency.applies(operation, request.method):
        # Only a caller who may run the operation, at a facility of theirs, claims a key,
        # whichever order the endpoint lists require() and tenant_db in (403 before 404).
        if getattr(request.state, _PERMISSION_CHECKED, None) != operation.permission:
            await _check_permission(request, user, operation.permission)
        check_facility_query(user, request.query_params.getlist("facilityId"))
        await idempotency.claim(request, db, user.organization_id, user.id, operation)

    def guard() -> None:
        # Both run at the first query, after all of the endpoint's dependencies, so a missing
        # permission is always reported (403) before a facility that isn't the user's (404).
        _require_was_checked(request)
        check_facility_query(user, request.query_params.getlist("facilityId"))

    session = db.tenant_session(user.organization_id, user.id, current_request_id(), guard=guard)
    audit.start_trail(request, user, session)  # the route's x-audit rows (app/core/audit.py)
    async with session:
        yield session


# The patient portal (ADR-0013, D84, D93). Portal routes never use current_user or tenant_db:
#
#     @router.get("/portal/me/profile", operation_id="getMyProfile")
#     async def my_profile(
#         patient: PortalPatient = Depends(portal_session),
#         db: AsyncSession = Depends(portal_db),
#     ): ...
#
# The patient comes only from the server-side portal session, never from the request, and the
# audit rows of `x-audit: {patient: session, actor: patient}` operations take it from there.
# create_app() refuses a route that serves such an operation without portal_session.
PORTAL_SESSION_STATE = "shri_portal_session"
PATIENT_ROLE = "PAT"  # own record only, no staff permission (D84)

# The development stand-in for patient sign-in (patient_auth_mode=dev_header, development and
# test only): the patient and its clinic as UUIDs, synthetic patients only.
DEV_PATIENT_HEADER = "X-Dev-Patient"
DEV_PATIENT_CLINIC_HEADER = "X-Dev-Patient-Clinic"


@dataclass(frozen=True)
class PortalPatient:
    """A signed-in patient: the chart they may see, and their clinic."""

    patient_id: UUID
    organization_id: UUID
    account_id: UUID | None = None
    roles: frozenset[str] = frozenset({PATIENT_ROLE})


def _header_uuid(request: Request, name: str) -> UUID:
    value = request.headers.get(name)
    if not value:
        raise Unauthorized(f"Send the {name} header with a test patient's UUID")
    try:
        return UUID(value)
    except ValueError:
        raise Unauthorized(f"{name} must be a UUID") from None


async def current_patient(request: Request) -> PortalPatient:
    """The signed-in patient. Signature final. In development and test, patient_auth_mode
    dev_header takes the patient and its clinic from the X-Dev-Patient headers; otherwise every
    request is refused until patient sign-in exists. TODO(ADR-0013, T45): the
    `__Host-shri_portal` cookie looked up as a portal session (realm `shri-patients`)."""
    if _settings(request).patient_auth_mode == "dev_header":
        return PortalPatient(patient_id=_header_uuid(request, DEV_PATIENT_HEADER),
                             organization_id=_header_uuid(request, DEV_PATIENT_CLINIC_HEADER))
    raise Unauthorized("Not signed in to the patient portal")


def require_own_record(patient: PortalPatient, record_patient_id: UUID | None) -> None:
    """A record named in a portal path (an appointment, a result) must be the session patient's;
    anything else is 404, exactly as for a record that doesn't exist (D84)."""
    if record_patient_id is None or record_patient_id != patient.patient_id:
        raise NotFound()


async def portal_session(
    request: Request, patient: PortalPatient = Depends(current_patient)
) -> PortalPatient:
    """Every portal route depends on this. It records the session's patient for the audit
    rows, which take the patient from here and nowhere else."""
    setattr(request.state, PORTAL_SESSION_STATE, patient)
    return patient


async def portal_db(
    request: Request, patient: PortalPatient = Depends(portal_session)
) -> AsyncIterator[AsyncSession]:
    """The portal's database session. Signature final; the body is a placeholder that refuses
    until the shri_portal role exists. TODO(D93, T45): connect as shri_portal
    (PORTAL_DATABASE_URL), set app.current_tenant_id and app.current_patient_id, and start
    the audit trail with audit.start_portal_trail(request, patient, session)."""
    raise ServiceUnavailable("The patient portal's database is not available yet")
    yield  # pragma: no cover  (makes this an async generator, like the real dependency)


async def public_db(request: Request) -> AsyncIterator[AsyncSession]:
    """The database session of a public form (D96: online pre-registration), with no account and
    no session: PUBLIC_DATABASE_URL, the shri_public role, which has no table privileges and can
    only run the form's own SECURITY DEFINER function (migration 0009).

    - **`Origin` first:** anything but the portal host is 403 `csrf-check-failed`, whatever the
      route checks itself (core/public_form.py).
    - **No clinic is set here.** The clinic comes only from the practice code in the path, and the
      function resolves it in the database (D96, D21); nothing in the request names it.
    - **No audit trail from core.** The function writes the request and its `anonymous` audit row
      in one call (D96); create_app() accepts this only for the operations in
      operations.AUDITED_IN_DATABASE.
    - Nothing is saved unless the endpoint commits; the rest is rolled back.

    Unconfigured (no PUBLIC_DATABASE_URL, portal origin or form secret): 503, never an open
    form."""
    from app.core.public_form import require_portal_origin  # public_form builds on errors only

    db: Database | None = getattr(request.app.state, "public_db", None)
    if db is None:
        raise ServiceUnavailable("Public forms are not available")
    require_portal_origin(request)
    async with db.sessions() as session:
        yield session
