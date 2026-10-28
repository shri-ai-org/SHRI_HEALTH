"""Batch 1 progress for Vimal's modules (contracts/docs/IMPL_BATCH1_PLAN.md §4.2).

Every operation a module has promised (its batch list) is either built or still listed as pending,
so the pending list shrinks PR by PR and can never go stale. Whether each built route matches the
contract (method, path, operationId, permission) is core's startup check (#79); this file goes once
that check is on main.

Routes are found with FastAPI's iter_route_contexts. FastAPI 0.143 keeps an included router's
routes inside it, so a loop over `app.routes` sees the routers, not their routes, and the first
version of this file checked nothing (found by Thulasi on #79). `route_walk_problems` guards
against that ever happening again.
"""

from __future__ import annotations

from functools import cache
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]
from fastapi import FastAPI
from fastapi.routing import APIRoute, iter_route_contexts

from app.core.config import Settings
from app.main import create_app

REPO = Path(__file__).resolve().parents[5]
BUNDLE = REPO / "contracts" / "openapi" / "dist" / "shri-health.bundled.yaml"
METHODS = ("get", "put", "post", "patch", "delete")
# Core's health router is mounted with include_router, so finding its route proves the walk
# reaches routes inside included routers.
NESTED_SENTINEL = "/health"


@cache
def contract_operation_ids() -> frozenset[str]:
    document: dict[str, Any] = yaml.safe_load(BUNDLE.read_text(encoding="utf-8"))
    return frozenset(
        operation["operationId"]
        for item in document["paths"].values()
        for method in METHODS
        if (operation := item.get(method)) is not None
    )


def make_app() -> FastAPI:
    return create_app(Settings(environment="test", auth_mode="dev_header"))


def all_routes(app: FastAPI) -> list[tuple[str, APIRoute]]:
    """Every APIRoute with its full path, routes inside included routers included."""
    return [
        (context.path or "", context.original_route)
        for context in iter_route_contexts(app.routes)
        if isinstance(context.original_route, APIRoute)
    ]


def route_walk_problems(app: FastAPI) -> list[str]:
    """Why the route walk can't be trusted, if it can't: it found nothing, or missed nested ones."""
    paths = {path for path, _ in all_routes(app)}
    if not paths:
        return ["the route walk found no routes at all, so every check would pass on nothing"]
    if NESTED_SENTINEL not in paths:
        return [f"the route walk missed {NESTED_SENTINEL}, a route inside an included router"]
    return []


def built_operation_ids(app: FastAPI, module: str) -> set[str]:
    return {
        route.operation_id for _, route in all_routes(app)
        if route.operation_id and route.endpoint.__module__.startswith(f"app.modules.{module}.")
    }


def progress_problems(module: str, promised: frozenset[str], pending: frozenset[str]) -> list[str]:
    """Each promised operation exists in the contract and is built unless it is still pending."""
    app = make_app()
    problems = route_walk_problems(app)
    contract = contract_operation_ids()
    built = built_operation_ids(app, module)
    problems += [f"{op}: not in the contract (renamed?)"
                 for op in sorted(promised) if op not in contract]
    problems += [f"{op}: listed as pending but not promised" for op in sorted(pending - promised)]
    problems += [f"{op}: built but not promised" for op in sorted(built - promised)]
    for op in sorted(promised & contract):
        if op in pending and op in built:
            problems.append(f"{op}: built, so remove it from PENDING")
        if op not in pending and op not in built:
            problems.append(f"{op}: promised and not pending, but no route")
    return problems
