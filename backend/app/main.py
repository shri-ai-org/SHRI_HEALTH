"""App factory. Run with: uvicorn app.main:app"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.config import Settings, get_settings
from app.core.lifecycle import shut_down
from app.core.operations import OperationsMapError, load_operations, route_problems
from app.core.registry import register_all
from app.core.routing import API_PREFIX

log = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    # Fail closed: without the contract's operations map no route can be checked or audited.
    try:
        load_operations()
    except OperationsMapError as error:
        raise RuntimeError(f"Cannot start: {error}") from error

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        yield
        await shut_down(application)

    application = FastAPI(
        title="Shri Health API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=f"{API_PREFIX}/docs" if settings.show_docs else None,
        redoc_url=None,
        openapi_url=f"{API_PREFIX}/openapi.json" if settings.show_docs else None,
    )
    application.state.settings = settings
    register_all(application, settings)  # every feature, in order (app/core/registry.py)
    # Every /api/v1 route is a contract operation with its x-permission and, where it is
    # audited, tenant_db (app/core/operations.py). A mismatch never starts.
    problems = route_problems(application)
    if problems:
        raise RuntimeError("Routes do not match the contract:\n  " + "\n  ".join(problems))

    if settings.patient_auth_mode == "dev_header":
        log.warning("STAND-IN PATIENT LOGIN ACTIVE: patients come from the X-Dev-Patient "
                    "headers (%s)", settings.environment)
    if settings.auth_mode == "dev_header":
        log.warning("STAND-IN LOGIN ACTIVE: users come from the X-Dev-User header (%s)",
                    settings.environment)
    return application


app = create_app()
