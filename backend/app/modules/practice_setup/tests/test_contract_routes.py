"""The practice-setup module's routes match the contract: every route is a contract operation at
its method and path, with the module's tag, and core's checks (require() with the operation's
x-permission, tenant_db for an audited operation) find nothing wrong.

Routes are found with FastAPI's iter_route_contexts, as core does: in this FastAPI version an
included router stays an `_IncludedRouter` in `app.routes`, so a plain `isinstance(route,
APIRoute)` walk of `app.routes` finds none of them.
"""

from fastapi.routing import APIRoute, iter_route_contexts

from app.core.config import Settings
from app.core.operations import load_operations, route_problems
from app.main import create_app

TAG = "practice-setup"
BUILT = frozenset({
    "listFacilitys", "listProviders", "listAppointmentTypes", "listProviderSchedules",
    "listPayers", "listPracticePayers", "listNoteTemplates", "getNoteTemplate",
})


def _module_routes() -> list[tuple[str, str, APIRoute]]:
    app = create_app(Settings(environment="test", auth_mode="dev_header"))
    found = []
    for context in iter_route_contexts(app.routes):
        route = context.original_route
        if isinstance(route, APIRoute) and route.endpoint.__module__.startswith(
                "app.modules.practice_setup."):
            for method in sorted(context.methods or ()):
                found.append((method, context.path or "", route))
    return found


def test_each_route_is_its_contract_operation() -> None:
    operations = load_operations()
    routes = _module_routes()
    assert {route.operation_id for _, _, route in routes} == BUILT
    for method, path, route in routes:
        operation = operations[route.operation_id or ""]
        assert (operation.method, operation.path) == (method, path), route.operation_id
        assert route.tags == [TAG]


def test_core_finds_no_problem_with_them() -> None:
    app = create_app(Settings(environment="test", auth_mode="dev_header"))
    paths = {path for _, path, _ in _module_routes()}
    assert [p for p in route_problems(app) if any(path in p for path in paths)] == []
