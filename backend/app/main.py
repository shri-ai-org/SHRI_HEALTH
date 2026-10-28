"""App factory. Run with: uvicorn app.main:app"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core import auth_api, health
from app.core.audit import AuditMiddleware
from app.core.config import Settings, get_settings
from app.core.crypto import FieldCrypto
from app.core.db import Database
from app.core.errors import install_error_handlers
from app.core.idempotency import IdempotencyMiddleware, Replay, replay_response
from app.core.operations import OperationsMapError, load_operations, route_problems
from app.core.request_id import RequestIdMiddleware
from app.core.response_headers import NoStoreMiddleware
from app.core.routing import API_PREFIX, include_module_routers
from app.core.session import Keycloak, LoginStates

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
        if application.state.db is not None:
            await application.state.db.dispose()
        if application.state.crypto is not None:
            await application.state.crypto.aclose()
        if application.state.keycloak is not None:
            await application.state.keycloak.aclose()

    application = FastAPI(
        title="Shri Health API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=f"{API_PREFIX}/docs" if settings.show_docs else None,
        redoc_url=None,
        openapi_url=f"{API_PREFIX}/openapi.json" if settings.show_docs else None,
    )
    application.state.settings = settings
    application.state.db = Database(settings) if settings.database_url else None
    application.state.crypto = FieldCrypto(settings) if settings.openbao_transit_addr else None
    # Staff sign-in (core/session.py); unconfigured, the sign-in routes answer 503.
    application.state.keycloak = Keycloak(settings) if settings.keycloak_public_url else None
    application.state.login_states = LoginStates()

    application.add_middleware(AuditMiddleware)  # innermost: sees the final status
    application.add_middleware(IdempotencyMiddleware)  # stores it, audit 500s included
    application.add_middleware(NoStoreMiddleware)
    application.add_middleware(RequestIdMiddleware)
    install_error_handlers(application)
    application.add_exception_handler(Replay, replay_response)
    application.include_router(health.router)  # root: /health, /ready
    application.include_router(auth_api.router, prefix=API_PREFIX)  # staff sign-in
    modules = include_module_routers(application)
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
    log.info("Modules with routes: %s", ", ".join(modules) or "none")
    return application


app = create_app()
