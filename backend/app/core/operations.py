"""The contract's operations, as core reads them at runtime: permission, audit and idempotency.

`operations.json` (next to this file) is generated from the bundled contract and committed, so
the API image needs neither the contract nor a YAML parser. Regenerate it after every contract
change; CI fails when it is stale:

    python -m app.core.operations           # rewrite operations.json
    python -m app.core.operations --check   # exit 1 if it differs from the contract

Every route under /api/v1 sets `operation_id` to the contract's operationId. At startup
`route_problems()` checks each route against its operation (method, path, require() with the
operation's x-permission, and tenant_db where the operation is audited); create_app() refuses
to start if anything is wrong, so a route can never ship without the permission or the audit
the contract gives it.
"""

import json
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute, iter_route_contexts

from app.core.routing import API_PREFIX

OPERATIONS_FILE = Path(__file__).with_name("operations.json")
BUNDLE = Path(__file__).resolve().parents[3] / "contracts/openapi/dist/shri-health.bundled.yaml"
METHODS = ("get", "put", "post", "patch", "delete")

# x-permission values that are not a permission: no require() on these routes.
NO_REQUIRE = frozenset({"public", "partner-signed"})

# Audited operations that do not use tenant_db: the sign-in flow audits itself (login, logout
# and refresh are security events written by the session code, and Keycloak's own events).
SELF_AUDITED = frozenset({"startLogin", "finishLogin", "refreshSession", "logout"})


@dataclass(frozen=True)
class AuditRule:
    """The operation's x-audit (EXTENSIONS.md): what the audit row says, and whose chart."""

    action: str  # C, R, U or E
    category: str  # phi-read, phi-write, sign, export, security, ai, admin or none
    patient: str | None = None  # a path parameter, "body:/<pointer>" or "result"
    actor: str = "user"  # or "partner" (partner callbacks, T37)

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


def build_map(bundle: dict[str, Any]) -> dict[str, Any]:
    """The operations map for operations.json, from the parsed bundled contract."""
    operations: dict[str, Any] = {}
    for path, item in bundle["paths"].items():
        # A path item that overrides `servers` with "/" lives outside /api/v1 (/health, /hooks).
        at_root = any(server.get("url") == "/" for server in item.get("servers", ()))
        for method in METHODS:
            operation = item.get(method)
            if operation is None:
                continue
            operation_id = operation["operationId"]
            if operation_id in operations:
                raise ValueError(f"operationId {operation_id!r} is used twice")
            operations[operation_id] = {
                "method": method.upper(),
                "path": path if at_root else f"{API_PREFIX}{path}",
                "permission": operation["x-permission"],
                "audit": operation["x-audit"],
                "idempotency": operation.get("x-idempotency"),
            }
    return {
        "source": "contracts/openapi/dist/shri-health.bundled.yaml",
        "generatedBy": "python -m app.core.operations",
        "operations": dict(sorted(operations.items())),
    }


def render(operations_map: dict[str, Any]) -> str:
    return json.dumps(operations_map, indent=1, sort_keys=True) + "\n"


@cache
def load_operations() -> dict[str, Operation]:
    data = json.loads(OPERATIONS_FILE.read_text(encoding="utf-8"))
    return {
        operation_id: Operation(
            operation_id=operation_id,
            method=item["method"],
            path=item["path"],
            permission=item["permission"],
            audit=AuditRule(**item["audit"]),
            idempotency=item["idempotency"],
        )
        for operation_id, item in data["operations"].items()
    }


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
    from app.core.deps import tenant_db  # deps imports this module's helpers

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
            needs_db = operation.audit.audited and operation.operation_id not in SELF_AUDITED
            if needs_db and tenant_db not in calls:
                problems.append(f"{where}: {operation.operation_id} is audited "
                                f"({operation.audit.category}), so it needs Depends(tenant_db)")
    return problems


def main(argv: list[str]) -> int:
    import yaml  # type: ignore[import-untyped]  # dev dependency: CI and laptops only

    rendered = render(build_map(yaml.safe_load(BUNDLE.read_text(encoding="utf-8"))))
    if "--check" in argv:
        if OPERATIONS_FILE.read_text(encoding="utf-8") != rendered:
            print(f"{OPERATIONS_FILE.name} is stale: run `python -m app.core.operations` in "
                  "backend/ and commit the result", file=sys.stderr)
            return 1
        print(f"{OPERATIONS_FILE.name} matches the contract")
        return 0
    OPERATIONS_FILE.write_text(rendered, encoding="utf-8")
    print(f"wrote {OPERATIONS_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
