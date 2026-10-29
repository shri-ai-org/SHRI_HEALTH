"""The contract's operations, as core reads them at runtime: permission, audit and idempotency.

The operations map (`operations.json`) is generated from the bundled contract by the contract's
own bundle step, next to the bundle in `contracts/openapi/dist/`, and the contracts CI fails when
it is stale. Core only reads it:

- from `SHRI_OPERATIONS_PATH` when set (the API image sets it: the one JSON file is copied in
  from a named build context, never the contract or a YAML parser);
- otherwise from `contracts/openapi/dist/operations.json` in this repository, found from this
  package's location, never from the working directory.

A missing, unreadable or malformed map stops the app at startup (fail closed): without it no
route can be checked against its permission or audited.

Every route under /api/v1 sets `operation_id` to the contract's operationId. At startup
`route_problems()` checks each route against its operation (method, path, require() with the
operation's x-permission, tenant_db or the portal's dependencies where the operation is
audited); create_app() refuses to start if anything is wrong, so a route can never ship without
the permission or the audit the contract gives it.
"""

import json
import os
from collections.abc import Iterator
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute, iter_route_contexts

from app.core.routing import API_PREFIX

OPERATIONS_PATH_ENV = "SHRI_OPERATIONS_PATH"
DEFAULT_OPERATIONS_FILE = (
    Path(__file__).resolve().parents[3] / "contracts" / "openapi" / "dist" / "operations.json"
)
METHODS = frozenset({"GET", "PUT", "POST", "PATCH", "DELETE"})

# x-audit, as EXTENSIONS.md defines it.
AUDIT_ACTIONS = frozenset({"C", "R", "U", "E"})
AUDIT_CATEGORIES = frozenset(
    {"phi-read", "phi-write", "sign", "export", "security", "ai", "admin", "none"})
# "anonymous": a public form with no account and no session (D96), on public operations only.
AUDIT_ACTORS = frozenset({"user", "partner", "patient", "anonymous"})
AUDIT_KEYS = frozenset({"action", "category", "patient", "actor"})
IDEMPOTENCY = frozenset({"supported", "required"})

# x-audit `patient: session`: the patient is the portal session's, never the request's.
SESSION_PATIENT = "session"

# x-permission values that are not a permission: no require() on these routes.
NO_REQUIRE = frozenset({"public", "partner-signed"})

# Public forms whose own SECURITY DEFINER function writes their `anonymous` audit row, in the same
# call as the data (D96, migration 0009). public_db starts no trail, so any other audited public
# form is refused at startup until core writes one for it.
AUDITED_IN_DATABASE = frozenset({"submitPreRegistration"})
# Public forms whose Idempotency-Key the same function handles (practice + key, 0009, Option A on
# #13), so core's staff-session idempotency (#103) isn't needed and isn't refused for them.
IDEMPOTENT_IN_DATABASE = frozenset({"submitPreRegistration"})

# Audited operations that do not use tenant_db: the sign-in flow audits itself (login, logout
# and refresh are security events written by the session code, and Keycloak's own events).
SELF_AUDITED = frozenset({"startLogin", "finishLogin", "refreshSession", "logout",
                          # The patient portal's sign-in and enrolment (portal_sign_in.py).
                          "startPortalLogin", "completePortalLogin", "refreshPortalSession",
                          "signOutOfPortal", "enrollInPortal"})
# Idempotency-Key handled by the route itself, for a caller with no session yet: enrolment
# replays a finished request's 204 for the same key and body (portal_sign_in.EnrollmentGuard).
IDEMPOTENT_IN_ROUTE = frozenset({"enrollInPortal"})


class OperationsMapError(RuntimeError):
    """The operations map is missing, unreadable or malformed: the app must not start."""


@dataclass(frozen=True)
class AuditRule:
    """The operation's x-audit (EXTENSIONS.md): what the audit row says, and whose chart."""

    action: str  # C, R, U or E
    category: str  # phi-read, phi-write, sign, export, security, ai, admin or none
    patient: str | None = None  # a path parameter, "body:/<pointer>", "result" or "session"
    actor: str = "user"  # or "partner" (partner callbacks, T37), "patient" (the portal) or
    #                      "anonymous" (a public form with no session, D96)

    @property
    def audited(self) -> bool:
        return self.category != "none"


@dataclass(frozen=True)
class Operation:
    operation_id: str
    method: str  # upper case
    path: str  # the full path the route serves, e.g. /api/v1/patients/{patientId}
    permission: str
    audit: AuditRule
    idempotency: str | None = None  # x-idempotency: supported, required or absent

    @property
    def portal(self) -> bool:
        """Served to a signed-in patient: the patient comes from the portal session."""
        return self.audit.patient == SESSION_PATIENT


def operations_file() -> Path:
    value = os.environ.get(OPERATIONS_PATH_ENV)
    return Path(value) if value else DEFAULT_OPERATIONS_FILE


def _operation(operation_id: str, item: Any) -> Operation:
    where = f"operation {operation_id!r}"
    if not isinstance(item, dict):
        raise OperationsMapError(f"{where} is not an object")
    method, path, permission = item.get("method"), item.get("path"), item.get("permission")
    audit, idempotency = item.get("audit"), item.get("idempotency")
    if method not in METHODS:
        raise OperationsMapError(f"{where}: method {method!r} is not one of {sorted(METHODS)}")
    if not isinstance(path, str) or not path.startswith("/"):
        raise OperationsMapError(f"{where}: path {path!r} must start with /")
    if not isinstance(permission, str) or not permission:
        raise OperationsMapError(f"{where}: permission is missing")
    if not isinstance(audit, dict) or not AUDIT_KEYS.issuperset(audit):
        raise OperationsMapError(
            f"{where}: x-audit must be an object with only {sorted(AUDIT_KEYS)}")
    action, category = audit.get("action"), audit.get("category")
    patient, actor = audit.get("patient"), audit.get("actor", "user")
    if action not in AUDIT_ACTIONS or category not in AUDIT_CATEGORIES:
        raise OperationsMapError(f"{where}: x-audit action {action!r} or category {category!r} "
                                 "is not allowed")
    if actor not in AUDIT_ACTORS:
        raise OperationsMapError(f"{where}: x-audit actor {actor!r} is not allowed")
    if patient is not None and (not isinstance(patient, str) or not patient):
        raise OperationsMapError(f"{where}: x-audit patient must be a non-empty string")
    rule = AuditRule(action=str(action), category=str(category), patient=patient,
                     actor=str(actor))
    if idempotency is not None and idempotency not in IDEMPOTENCY:
        raise OperationsMapError(f"{where}: x-idempotency {idempotency!r} is not allowed")
    return Operation(operation_id=operation_id, method=method, path=path,
                     permission=permission, audit=rule, idempotency=idempotency)


@cache
def _load(path: Path) -> dict[str, Operation]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise OperationsMapError(
            f"The operations map {path} does not exist. It is generated by the contract bundle "
            f"step (contracts/openapi/dist/); set {OPERATIONS_PATH_ENV} to use another file"
        ) from None
    except (OSError, UnicodeDecodeError) as error:
        raise OperationsMapError(f"The operations map {path} cannot be read: {error}") from None
    except json.JSONDecodeError as error:
        raise OperationsMapError(f"The operations map {path} is not valid JSON: {error}") from None
    operations = data.get("operations") if isinstance(data, dict) else None
    if not isinstance(operations, dict) or not operations:
        raise OperationsMapError(f"The operations map {path} has no operations")
    return {operation_id: _operation(operation_id, item)
            for operation_id, item in operations.items()}


def load_operations() -> dict[str, Operation]:
    """The operations map; raises OperationsMapError if it can't be used."""
    return _load(operations_file())


def operation_for(route: object) -> Operation | None:
    """The contract operation a matched route serves (`request.scope["route"]`), if any."""
    operation_id = getattr(route, "operation_id", None)
    return load_operations().get(operation_id) if operation_id else None


def _calls(dependant: Dependant) -> Iterator[Any]:
    for dependency in dependant.dependencies:
        yield dependency.call
        yield from _calls(dependency)


def route_problems(app: FastAPI) -> list[str]:
    """What is wrong with the app's /api/v1 routes, measured against the contract."""
    from app.core.deps import (  # deps uses this module
        portal_db,
        portal_session,
        public_db,
        tenant_db,
    )

    operations = load_operations()
    problems: list[str] = []
    # FastAPI 0.143 keeps an included router's routes inside it (app.routes holds the router,
    # not its routes); iter_route_contexts gives each one with its full path and dependencies,
    # the router-level ones included.
    for context in iter_route_contexts(app.routes):
        route, path = context.original_route, context.path or ""
        if not isinstance(route, APIRoute) or not path.startswith(f"{API_PREFIX}/"):
            continue
        for method in sorted(context.methods or ()):
            where = f"{method} {path}"
            operation = operations.get(route.operation_id or "")
            if operation is None:
                problems.append(f"{where}: operation_id {route.operation_id!r} is not a contract "
                                "operationId (set operation_id= on the route)")
                continue
            if (operation.method, operation.path) != (method, path):
                problems.append(f"{where}: the contract has {operation.operation_id} at "
                                f"{operation.method} {operation.path}")
            calls = list(_calls(context.dependant))
            checked = {getattr(call, "shri_permission", "") for call in calls} - {""}
            wanted = set() if operation.permission in NO_REQUIRE else {operation.permission}
            if checked != wanted:
                problems.append(f"{where}: require() checks {sorted(checked)}, the contract's "
                                f"x-permission is {operation.permission!r}")
            if operation.idempotency is not None and method in ("POST", "PUT", "PATCH"):
                staff = operation.audit.actor == "user" and operation.permission not in NO_REQUIRE
                if operation.operation_id in IDEMPOTENT_IN_DATABASE | IDEMPOTENT_IN_ROUTE:
                    pass
                elif operation.portal or not staff:
                    problems.append(f"{where}: {operation.operation_id} has x-idempotency, which "
                                    "core handles only for staff sessions so far (not yet for "
                                    "the portal, public forms or partners)")
                elif tenant_db not in calls:
                    problems.append(f"{where}: {operation.operation_id} has x-idempotency, so it "
                                    "needs Depends(tenant_db), which claims the key")
            if operation.audit.actor == "anonymous":
                # A public form: no staff session and no portal session, and the clinic comes
                # from the portal host, never the request (D96).
                if operation.permission != "public":
                    problems.append(f"{where}: {operation.operation_id} is audited as anonymous, "
                                    "which only a public operation may be")
                if tenant_db in calls or portal_session in calls:
                    problems.append(f"{where}: {operation.operation_id} is a public form, so it "
                                    "uses neither tenant_db nor portal_session")
                if operation.audit.audited and public_db not in calls:
                    problems.append(f"{where}: {operation.operation_id} is audited "
                                    f"({operation.audit.category}), so it needs Depends(public_db)")
                if operation.audit.audited and operation.operation_id not in AUDITED_IN_DATABASE:
                    problems.append(f"{where}: {operation.operation_id} is an audited public "
                                    "form, and core writes no audit trail for public forms: its "
                                    "database function must (operations.AUDITED_IN_DATABASE)")
                continue
            if operation.portal:
                # The patient is the portal session's; a staff session never serves these.
                if portal_session not in calls:
                    problems.append(f"{where}: {operation.operation_id} takes the patient from the "
                                    "portal session, so it needs Depends(portal_session)")
                if tenant_db in calls:
                    problems.append(f"{where}: {operation.operation_id} is a portal operation, so "
                                    "it never uses the staff tenant_db")
                if (operation.audit.audited and portal_db not in calls
                        and operation.operation_id not in SELF_AUDITED):
                    problems.append(f"{where}: {operation.operation_id} is audited "
                                    f"({operation.audit.category}), so it needs Depends(portal_db)")
                continue
            needs_db = operation.audit.audited and operation.operation_id not in SELF_AUDITED
            if needs_db and tenant_db not in calls:
                problems.append(f"{where}: {operation.operation_id} is audited "
                                f"({operation.audit.category}), so it needs Depends(tenant_db)")
    return problems
