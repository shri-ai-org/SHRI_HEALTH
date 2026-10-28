"""The operations map (the contract's operations.json) and the startup check of routes."""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.deps import (
    CurrentUser,
    PortalPatient,
    current_patient,
    portal_db,
    portal_session,
    public_db,
    require,
    tenant_db,
)
from app.core.operations import (
    DEFAULT_OPERATIONS_FILE,
    OPERATIONS_PATH_ENV,
    OperationsMapError,
    load_operations,
    operations_file,
    route_problems,
)
from app.core.routing import API_PREFIX
from app.main import create_app

# A portal operation as #73 defines them (patient and actor from the portal session). Public,
# so these tests check the portal rules alone, without a portal permission check.
PORTAL_OP = {"getMyProfile": {
    "method": "GET", "path": f"{API_PREFIX}/portal/me/profile", "permission": "public",
    "audit": {"action": "R", "category": "phi-read", "patient": "session", "actor": "patient"},
    "idempotency": None,
}}


# A public form as #89 defines one (no account, no session; D96).
ANONYMOUS_OP = {"submitTestForm": {
    "method": "POST", "path": f"{API_PREFIX}/portal/test-forms", "permission": "public",
    "audit": {"action": "C", "category": "phi-write", "actor": "anonymous"},
    "idempotency": None,
}}

# The pre-registration form itself (#89): its database function writes its audit row (D96).
PRE_REGISTRATION_OP = {"submitPreRegistration": {
    "method": "POST", "path": f"{API_PREFIX}/portal/practices/{{practiceLinkId}}/pre-registrations",
    "permission": "public", "audit": {"action": "C", "category": "phi-write", "actor": "anonymous"},
    "idempotency": None,
}}


@pytest.fixture
def use_map(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Callable[..., Path]:
    """Points core at a map made of the current one plus `extra`, or at `raw` text."""

    def _use(extra: dict[str, Any] | None = None, raw: str | None = None) -> Path:
        path = tmp_path / "operations.json"
        if raw is None:
            current = json.loads(operations_file().read_text(encoding="utf-8"))
            current["operations"].update(extra or {})
            raw = json.dumps(current)
        path.write_text(raw, encoding="utf-8")
        monkeypatch.setenv(OPERATIONS_PATH_ENV, str(path))
        return path

    return _use


def test_the_default_map_is_the_contracts_found_from_the_package(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(OPERATIONS_PATH_ENV, raising=False)
    monkeypatch.chdir("/")  # the working directory plays no part
    assert operations_file() == DEFAULT_OPERATIONS_FILE
    assert DEFAULT_OPERATIONS_FILE.is_absolute()
    assert DEFAULT_OPERATIONS_FILE.parts[-4:] == ("contracts", "openapi", "dist", "operations.json")


def test_the_environment_variable_points_elsewhere(use_map: Callable[..., Path]) -> None:
    path = use_map(PORTAL_OP)
    assert operations_file() == path
    assert load_operations()["getMyProfile"].portal


def test_every_operation_has_a_permission_and_an_audit_rule() -> None:
    operations = load_operations()
    assert len(operations) > 100
    for operation in operations.values():
        assert operation.permission
        assert operation.audit.action in {"C", "R", "U", "E"}
        if "{patientId}" in operation.path:
            assert operation.audit.patient == "patientId", operation.operation_id


def _op(**changes: Any) -> str:
    item = {"method": "GET", "path": "/api/v1/x", "permission": "patients:read",
            "audit": {"action": "R", "category": "phi-read"}, "idempotency": None}
    item.update(changes)
    return json.dumps({"operations": {"getX": item}})


@pytest.mark.parametrize(("raw", "expected"), [
    ("{not json", "not valid JSON"),
    ("[]", "has no operations"),
    ('{"operations": {}}', "has no operations"),
    (_op(method="TRACE"), "method 'TRACE'"),
    (_op(path="api/v1/x"), "must start with /"),
    (_op(permission=""), "permission is missing"),
    (_op(audit={"action": "R", "category": "phi-read", "who": "me"}), "x-audit must be an object"),
    (_op(audit={"action": "X", "category": "phi-read"}), "action 'X'"),
    (_op(audit={"action": "R", "category": "phi-read", "actor": "robot"}), "actor 'robot'"),
    (_op(idempotency="always"), "x-idempotency 'always'"),
])
def test_a_malformed_map_is_refused(use_map: Callable[..., Path], raw: str, expected: str) -> None:
    use_map(raw=raw)
    with pytest.raises(OperationsMapError, match=expected):
        load_operations()


def test_the_app_refuses_to_start_without_the_map(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(OPERATIONS_PATH_ENV, str(tmp_path / "missing.json"))
    with pytest.raises(RuntimeError, match="Cannot start: The operations map .* does not exist"):
        create_app(Settings(environment="test", auth_mode="dev_header"))


def test_the_app_refuses_to_start_with_an_unreadable_map(use_map: Callable[..., Path]) -> None:
    use_map(raw="{not json")
    with pytest.raises(RuntimeError, match="Cannot start: .* not valid JSON"):
        create_app(Settings(environment="test", auth_mode="dev_header"))


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
SESSION = Depends(portal_session)
PORTAL_DB = Depends(portal_db)


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


def test_a_portal_route_with_the_portal_session_passes(use_map: Callable[..., Path]) -> None:
    use_map(PORTAL_OP)
    assert route_problems(_app(("GET", "/portal/me/profile", "getMyProfile",
                                [SESSION, PORTAL_DB]))) == []


@pytest.mark.parametrize(("dependencies", "expected"), [
    ([PORTAL_DB], None),  # portal_db depends on portal_session itself
    ([DB], "needs Depends(portal_session)"),
    ([SESSION, DB], "never uses the staff tenant_db"),
    ([SESSION], "needs Depends(portal_db)"),
])
def test_a_portal_route_without_the_portal_dependencies_is_refused(
        use_map: Callable[..., Path], dependencies: list[Any], expected: str | None) -> None:
    use_map(PORTAL_OP)
    problems = route_problems(_app(("GET", "/portal/me/profile", "getMyProfile", dependencies)))
    if expected is None:
        assert problems == []
    else:
        assert any(expected in p for p in problems), problems


def test_the_portal_placeholders_refuse_by_default() -> None:
    """Routes outside /api/v1, so the startup check leaves them alone."""
    app = create_app(Settings(environment="test", auth_mode="dev_header"))

    @app.get("/session")
    async def by_session(patient: PortalPatient = SESSION) -> None:
        return None

    @app.get("/db")
    async def by_db(db: AsyncSession = PORTAL_DB) -> None:
        return None

    client = TestClient(app, raise_server_exceptions=False)
    refused = client.get("/session")
    assert refused.status_code == 401  # no patient sign-in yet
    assert refused.json()["code"] == "unauthenticated"
    patient = UUID("0c000000-0000-4000-8000-0000000000aa")
    app.dependency_overrides[current_patient] = lambda: PortalPatient(
        patient_id=patient, organization_id=patient)
    assert client.get("/session").status_code == 200
    assert client.get("/db").status_code == 503  # no shri_portal database yet


def test_the_map_accepts_the_anonymous_actor(use_map: Callable[..., Path]) -> None:
    use_map(ANONYMOUS_OP)
    assert load_operations()["submitTestForm"].audit.actor == "anonymous"


PUBLIC_DB = Depends(public_db)


def test_a_public_form_with_public_db_passes(use_map: Callable[..., Path]) -> None:
    use_map(PRE_REGISTRATION_OP)
    assert route_problems(_app(("POST", "/portal/practices/{practiceLinkId}/pre-registrations",
                                "submitPreRegistration", [PUBLIC_DB]))) == []


def test_pre_registrations_idempotency_is_its_database_functions(
        use_map: Callable[..., Path]) -> None:
    """x-idempotency: required on the public form is handled by 0009's function (practice + key),
    so the staff-only idempotency rule (#103) doesn't refuse it; another public form still is."""
    required = {"submitPreRegistration": {**PRE_REGISTRATION_OP["submitPreRegistration"],
                                          "idempotency": "required"}}
    use_map(required)
    assert route_problems(_app(("POST", "/portal/practices/{practiceLinkId}/pre-registrations",
                                "submitPreRegistration", [PUBLIC_DB]))) == []
    other = {"submitTestForm": {**ANONYMOUS_OP["submitTestForm"], "idempotency": "required"}}
    use_map(other)
    problems = route_problems(_app(("POST", "/portal/test-forms", "submitTestForm", [PUBLIC_DB])))
    assert any("core handles only for staff sessions so far" in p for p in problems), problems


def test_an_audited_public_form_must_be_audited_by_its_database_function(
        use_map: Callable[..., Path]) -> None:
    """public_db starts no audit trail, so an audited public form other than pre-registration
    (whose function writes the row) would go unaudited: refused at startup."""
    use_map(ANONYMOUS_OP)
    problems = route_problems(_app(("POST", "/portal/test-forms", "submitTestForm",
                                    [PUBLIC_DB])))
    assert any("core writes no audit trail for public forms" in p for p in problems), problems


@pytest.mark.parametrize(("dependencies", "expected"), [
    ([], "needs Depends(public_db)"),
    ([DB], "uses neither tenant_db nor portal_session"),
    ([SESSION, PUBLIC_DB], "uses neither tenant_db nor portal_session"),
])
def test_a_public_form_without_public_db_or_with_a_session_is_refused(
        use_map: Callable[..., Path], dependencies: list[Any], expected: str) -> None:
    use_map(ANONYMOUS_OP)
    problems = route_problems(_app(("POST", "/portal/test-forms", "submitTestForm",
                                    dependencies)))
    assert any(expected in p for p in problems), problems


def test_anonymous_is_only_for_public_operations(use_map: Callable[..., Path]) -> None:
    signed_in = {"submitTestForm": {**ANONYMOUS_OP["submitTestForm"],
                                    "permission": "patients:read"}}
    use_map(signed_in)
    problems = route_problems(_app(("POST", "/portal/test-forms", "submitTestForm",
                                    [READ, PUBLIC_DB])))
    assert any("only a public operation may be" in p for p in problems), problems


def test_the_public_db_placeholder_refuses_by_default() -> None:
    app = create_app(Settings(environment="test", auth_mode="dev_header"))

    @app.post("/form")
    async def form(db: AsyncSession = PUBLIC_DB) -> None:
        return None

    r = TestClient(app, raise_server_exceptions=False).post("/form")
    assert r.status_code == 503 and r.json()["code"] == "service-unavailable"
