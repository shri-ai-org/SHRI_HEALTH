"""Routes ↔ contract conformance for Vimal's modules (contracts/docs/IMPL_BATCH1_PLAN.md §4.2).

Every route a module defines must be a contract operation: same method, same path (under
/api/v1), the contract's operationId as its operation_id, the module's tag, and require() with
the operation's x-permission. Every operation a module has promised (its batch list) is either
built or still listed as pending, so the pending list shrinks PR by PR and can never go stale.
Reads the bundled contract, which is committed (contracts/openapi/dist/), so no new dependency
is needed.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]
from fastapi.routing import APIRoute

from app.core.config import Settings
from app.core.routing import API_PREFIX
from app.main import create_app

REPO = Path(__file__).resolve().parents[5]
BUNDLE = REPO / "contracts" / "openapi" / "dist" / "shri-health.bundled.yaml"
METHODS = ("get", "put", "post", "patch", "delete")
SPECIAL_PERMISSIONS = frozenset({"public", "partner-signed"})


@dataclass(frozen=True)
class ContractOperation:
    operation_id: str
    method: str
    path: str
    tag: str
    permission: str


@dataclass(frozen=True)
class BuiltRoute:
    operation_id: str | None
    method: str
    path: str
    tags: tuple[str, ...]
    requires: frozenset[str]  # require() dependency names, e.g. require_patients_read


@cache
def contract_operations() -> dict[str, ContractOperation]:
    document: dict[str, Any] = yaml.safe_load(BUNDLE.read_text(encoding="utf-8"))
    operations: dict[str, ContractOperation] = {}
    for path, item in document["paths"].items():
        for method in METHODS:
            operation = item.get(method)
            if operation is None:
                continue
            operations[operation["operationId"]] = ContractOperation(
                operation_id=operation["operationId"], method=method.upper(), path=path,
                tag=operation["tags"][0], permission=operation["x-permission"],
            )
    return operations


def require_name(permission: str) -> str:
    """The name require() gives its dependency (app/core/deps.py)."""
    return f"require_{permission.replace(':', '_').replace('-', '_')}"


def built_routes(module: str) -> list[BuiltRoute]:
    app = create_app(Settings(environment="test", auth_mode="dev_header"))
    routes: list[BuiltRoute] = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        if not route.endpoint.__module__.startswith(f"app.modules.{module}."):
            continue
        requires = frozenset(
            name for dependency in route.dependant.dependencies
            if (name := getattr(dependency.call, "__name__", "")).startswith("require_")
        )
        for method in sorted(route.methods or ()):
            routes.append(BuiltRoute(
                operation_id=route.operation_id, method=method,
                path=route.path.removeprefix(API_PREFIX),
                tags=tuple(str(tag) for tag in route.tags), requires=requires,
            ))
    return routes


def route_problems(module: str, tag: str) -> list[str]:
    """What is wrong with the routes a module has built, measured against the contract."""
    contract = contract_operations()
    problems: list[str] = []
    for route in built_routes(module):
        where = f"{route.method} {route.path}"
        operation = contract.get(route.operation_id or "")
        if operation is None:
            problems.append(
                f"{where}: operation_id {route.operation_id!r} is not a contract operationId")
            continue
        if (operation.method, operation.path) != (route.method, route.path):
            problems.append(f"{where}: the contract has {operation.operation_id} at "
                            f"{operation.method} {operation.path}")
        if operation.tag != tag or route.tags != (tag,):
            problems.append(f"{where}: tags {route.tags}, the contract's tag is {operation.tag!r}")
        if operation.permission in SPECIAL_PERMISSIONS:
            if route.requires:
                problems.append(f"{where}: {operation.permission} operations use no require()")
        elif route.requires != {require_name(operation.permission)}:
            problems.append(f"{where}: needs exactly Depends(require({operation.permission!r})), "
                            f"has {sorted(route.requires)}")
    return problems


def progress_problems(module: str, promised: frozenset[str], pending: frozenset[str]) -> list[str]:
    """Each promised operation exists in the contract and is built unless it is still pending."""
    contract = contract_operations()
    built = {route.operation_id for route in built_routes(module)}
    problems = [f"{op}: not in the contract (renamed?)"
                for op in sorted(promised) if op not in contract]
    problems += [f"{op}: listed as pending but not promised" for op in sorted(pending - promised)]
    for op in sorted(promised & contract.keys()):
        if op in pending and op in built:
            problems.append(f"{op}: built, so remove it from PENDING")
        if op not in pending and op not in built:
            problems.append(f"{op}: promised and not pending, but no route")
    return problems
