"""The operations map (operations.json) and the startup check of routes against the contract."""

from typing import Any

import pytest
import yaml  # type: ignore[import-untyped]
from fastapi import APIRouter, Depends, FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, require, tenant_db
from app.core.operations import (
    BUNDLE,
    OPERATIONS_FILE,
    build_map,
    load_operations,
    render,
    route_problems,
)
from app.core.routing import API_PREFIX


def test_operations_json_matches_the_bundled_contract() -> None:
    bundle = yaml.safe_load(BUNDLE.read_text(encoding="utf-8"))
    assert OPERATIONS_FILE.read_text(encoding="utf-8") == render(build_map(bundle)), (
        "operations.json is stale: run `python -m app.core.operations` in backend/")


def test_every_operation_has_a_permission_and_an_audit_rule() -> None:
    operations = load_operations()
    assert len(operations) > 100
    for operation in operations.values():
        assert operation.permission
        assert operation.audit.action in {"C", "R", "U", "E"}
        if "{patientId}" in operation.path:
            assert operation.audit.patient == "patientId", operation.operation_id


def _op(operation_id: str, **extra: Any) -> dict[str, Any]:
    return {"operationId": operation_id, "x-permission": "patients:read",
            "x-audit": {"action": "R", "category": "phi-read"}, **extra}


def test_build_map_prefixes_api_paths_and_keeps_root_paths() -> None:
    bundle = {"paths": {
        "/patients/{patientId}": {"get": _op("getPatient")},
        "/hooks/{partner}": {"servers": [{"url": "/"}],
                             "post": _op("receiveHook", **{"x-idempotency": "required"})},
    }}
    operations = build_map(bundle)["operations"]
    assert operations["getPatient"]["path"] == f"{API_PREFIX}/patients/{{patientId}}"
    assert operations["receiveHook"]["path"] == "/hooks/{partner}"
    assert operations["receiveHook"]["idempotency"] == "required"
    assert operations["getPatient"]["idempotency"] is None


def test_build_map_refuses_a_duplicate_operation_id() -> None:
    bundle = {"paths": {"/a": {"get": _op("same")}, "/b": {"get": _op("same")}}}
    with pytest.raises(ValueError, match="used twice"):
        build_map(bundle)


async def _endpoint() -> None:
    return None


def _app(*routes: tuple[str, str, str | None, list[Any]]) -> FastAPI:
    router = APIRouter()
    for method, path, operation_id, dependencies in routes:
        router.add_api_route(path, _endpoint, methods=[method], operation_id=operation_id,
                             dependencies=dependencies)
    app = FastAPI()
    app.include_router(router, prefix=API_PREFIX)
    return app


READ = Depends(require("patients:read"))
DB = Depends(tenant_db)


def test_a_route_that_matches_its_operation_passes() -> None:
    assert route_problems(_app(("GET", "/patients/{patientId}", "getPatient", [READ, DB]))) == []


def test_require_inside_another_dependency_counts() -> None:
    async def chart(user: CurrentUser = READ, db: AsyncSession = DB) -> None:
        return None

    app = _app(("GET", "/patients/{patientId}", "getPatient", [Depends(chart)]))
    assert route_problems(app) == []


@pytest.mark.parametrize(("route", "expected"), [
    (("GET", "/patients/{patientId}", None, [READ, DB]), "is not a contract operationId"),
    (("GET", "/patients/{patientId}", "noSuchOperation", [READ, DB]),
     "is not a contract operationId"),
    (("GET", "/patients/{id}", "getPatient", [READ, DB]), "the contract has getPatient at"),
    (("POST", "/patients/{patientId}", "getPatient", [READ, DB]), "the contract has getPatient"),
    (("GET", "/patients/{patientId}", "getPatient", [DB]), "x-permission is 'patients:read'"),
    (("GET", "/patients/{patientId}", "getPatient",
      [Depends(require("patients:update")), DB]), "require() checks ['patients:update']"),
    (("GET", "/patients/{patientId}", "getPatient", [READ, Depends(require("authenticated")), DB]),
     "require() checks ['authenticated', 'patients:read']"),
    (("GET", "/patients/{patientId}", "getPatient", [READ]), "needs Depends(tenant_db)"),
])
def test_a_route_that_differs_from_the_contract_is_reported(
        route: tuple[str, str, str | None, list[Any]], expected: str) -> None:
    problems = route_problems(_app(route))
    assert len(problems) == 1 and expected in problems[0], problems


def test_an_unaudited_operation_needs_no_tenant_db() -> None:
    inbox = Depends(require("inbox:read"))
    assert route_problems(_app(("GET", "/inbox/summary", "getInboxSummary", [inbox]))) == []


def test_routes_in_nested_routers_are_checked() -> None:
    """FastAPI 0.143 keeps included routers' routes inside them, not in app.routes."""
    inner, outer = APIRouter(), APIRouter()
    inner.add_api_route("/{patientId}", _endpoint, methods=["GET"], operation_id="wrongName",
                        dependencies=[READ, DB])
    outer.include_router(inner, prefix="/patients")
    app = FastAPI()
    app.include_router(outer, prefix=API_PREFIX)
    problems = route_problems(app)
    assert len(problems) == 1 and "'wrongName' is not a contract operationId" in problems[0]


def test_router_level_dependencies_count() -> None:
    router = APIRouter()
    router.add_api_route("/patients/{patientId}", _endpoint, methods=["GET"],
                         operation_id="getPatient")
    app = FastAPI()
    app.include_router(router, prefix=API_PREFIX, dependencies=[READ, DB])
    assert route_problems(app) == []


def test_routes_outside_the_api_are_not_checked() -> None:
    app = FastAPI()
    app.add_api_route("/health", _endpoint)
    assert route_problems(app) == []
