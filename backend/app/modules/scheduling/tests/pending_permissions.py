"""The check-out and follow-up permissions core doesn't have yet (NOTE_FOR_THULASI T50, D98), for
the tests only: ``grant`` adds them to core's catalogue and roles as T50 proposes them, for one
test (pytest's monkeypatch undoes it), and ``mount`` adds the routes that wait for them to a test
app, then runs core's startup check on the app again, so each route's permission, path and
dependencies are still checked against the contract.

Once core has T50, ``grant`` adds nothing, the routes are mounted at import, ``mount`` adds
nothing, and the PENDING lists in the contract-route tests fail until those operations are taken
off them.
"""

from __future__ import annotations

from types import ModuleType

import pytest
from fastapi import APIRouter, FastAPI

from app.core import permissions
from app.core.operations import route_problems
from app.core.routing import API_PREFIX

#: T50 as proposed: the permission and the roles that hold it (SECURITY_MODEL §4.2).
T50_GRANTS: dict[str, tuple[str, ...]] = {
    "appointments:check-out": ("FD", "ADM"),
    "follow-ups:decline": ("FD", "ADM"),
    "after-visit-summaries:read": ("FD", "MA", "RN", "MD", "APP", "ADM"),
}


def grant(monkeypatch: pytest.MonkeyPatch) -> None:
    missing = {p for p in T50_GRANTS if not permissions.is_known_permission(p)}
    if not missing:
        return
    monkeypatch.setattr(permissions, "CATALOGUE", permissions.CATALOGUE | missing)
    for permission in missing:
        for role in T50_GRANTS[permission]:
            monkeypatch.setitem(permissions.ROLE_PERMISSIONS, role,
                                permissions.ROLE_PERMISSIONS[role] | {permission})


def _modules() -> list[ModuleType]:
    """The API modules with routes waiting for T50."""
    from app.modules.encounters import api as encounters
    from app.modules.scheduling import api as scheduling
    return [m for m in (encounters, scheduling) if hasattr(m, "mount_pending_routes")]


def mount(app: FastAPI) -> None:
    """The waiting routes not already mounted, then core's startup check again. Call after
    ``grant``."""
    extra = APIRouter()
    for module in _modules():
        module.mount_pending_routes(extra, exclude=module.MOUNTED_PENDING)
    app.include_router(extra, prefix=API_PREFIX)
    problems = route_problems(app)
    assert problems == [], problems
