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

from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions
from app.core.config import Settings
from app.core.db import Database
from app.core.errors import Forbidden, ServiceUnavailable, Unauthorized

DEV_USER_HEADER = "X-Dev-User"


@dataclass(frozen=True)
class CurrentUser:
    id: UUID
    organization_id: UUID
    roles: frozenset[str]
    facility_ids: frozenset[UUID] = field(default_factory=frozenset)
    display_name: str = ""

    def can(self, permission: str) -> bool:
        return permissions.roles_allow(self.roles, permission)


# Synthetic users for local development and tests only. Two clinics, so every endpoint
# can be tested for cross-clinic isolation ("doctor-b" must never see clinic A's data).
CLINIC_A = UUID("0a000000-0000-4000-8000-00000000000a")
CLINIC_B = UUID("0b000000-0000-4000-8000-00000000000b")
FACILITY_A = UUID("fa000000-0000-4000-8000-00000000000a")
FACILITY_B = UUID("fb000000-0000-4000-8000-00000000000b")


def _dev_user(n: int, clinic: UUID, facility: UUID, roles: set[str], name: str) -> CurrentUser:
    return CurrentUser(
        id=UUID(f"d0000000-0000-4000-8000-{n:012d}"),
        organization_id=clinic,
        roles=frozenset(roles),
        facility_ids=frozenset({facility}),
        display_name=name,
    )


DEV_USERS: dict[str, CurrentUser] = {
    "doctor": _dev_user(1, CLINIC_A, FACILITY_A, {"doctor"}, "Dev Doctor"),
    "nurse": _dev_user(2, CLINIC_A, FACILITY_A, {"nurse_ma"}, "Dev Nurse"),
    "front-desk": _dev_user(3, CLINIC_A, FACILITY_A, {"front_desk"}, "Dev Front Desk"),
    "biller": _dev_user(4, CLINIC_A, FACILITY_A, {"biller"}, "Dev Biller"),
    "practice-admin": _dev_user(5, CLINIC_A, FACILITY_A, {"practice_admin"}, "Dev Practice Admin"),
    "platform-admin": _dev_user(6, CLINIC_A, FACILITY_A, {"platform_admin"}, "Dev Platform Admin"),
    "no-access": _dev_user(7, CLINIC_A, FACILITY_A, set(), "Dev No Access"),
    "doctor-b": _dev_user(8, CLINIC_B, FACILITY_B, {"doctor"}, "Dev Doctor (Clinic B)"),
}


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
    # Keycloak login (reference-token sessions) is not built yet.
    raise Unauthorized("Not signed in")


def require(permission: str) -> Callable[..., Coroutine[Any, Any, CurrentUser]]:
    if not permissions.is_valid_permission(permission):
        raise ValueError(f"Permission must look like 'resource:action', got {permission!r}")

    async def check(user: CurrentUser = Depends(current_user)) -> CurrentUser:
        if not user.can(permission):
            raise Forbidden(f"Missing permission {permission}")
        return user

    check.__name__ = f"require_{permission.replace(':', '_').replace('-', '_')}"
    return check


async def tenant_db(
    request: Request, user: CurrentUser = Depends(current_user)
) -> AsyncIterator[AsyncSession]:
    """A session scoped to the caller's clinic. Call `await db.commit()` to save; anything
    not committed when the request ends is rolled back."""
    db: Database | None = request.app.state.db
    if db is None:
        raise ServiceUnavailable("Database is not configured")
    async with db.tenant_session(user.organization_id) as session:
        yield session
