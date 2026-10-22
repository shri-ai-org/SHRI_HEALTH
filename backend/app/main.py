"""App factory. Run with: uvicorn app.main:app"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core import health
from app.core.config import Settings, get_settings
from app.core.db import Database
from app.core.errors import install_error_handlers
from app.core.routing import API_PREFIX, include_module_routers

log = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        yield
        if application.state.db is not None:
            await application.state.db.dispose()

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

    install_error_handlers(application)
    application.include_router(health.router, prefix=API_PREFIX)
    modules = include_module_routers(application)

    if settings.auth_mode == "dev_header":
        log.warning("STAND-IN LOGIN ACTIVE: users come from the X-Dev-User header (%s)",
                    settings.environment)
    log.info("Modules with routes: %s", ", ".join(modules) or "none")
    return application


app = create_app()
