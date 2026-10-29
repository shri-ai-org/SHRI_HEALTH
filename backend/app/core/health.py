"""GET /health (the process is up) and GET /ready (it can serve requests).

Both sit at the root, outside /api/v1, so load-balancer checks never change with the API
version (API_STANDARDS §2). Nginx exposes /health publicly; /ready is for internal checks.
"""

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse

from app.core.config import Settings
from app.core.db import Database
from app.core.errors import problem

log = logging.getLogger(__name__)

router = APIRouter(tags=["platform"])

READY_TIMEOUT_SECONDS = 2.0
RETRY_AFTER_SECONDS = "5"


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready", response_model=None)
async def ready(request: Request) -> dict[str, Any] | JSONResponse:
    db: Database | None = request.app.state.db
    if db is None:
        log.warning("Readiness check: database not configured")
        return _not_ready(request)
    try:
        bypasses_rls = await asyncio.wait_for(db.role_bypasses_rls(), READY_TIMEOUT_SECONDS)
    except Exception:
        # Log the cause, but never return connection details to the caller.
        log.warning("Readiness check: database unavailable", exc_info=True)
        return _not_ready(request)
    if bypasses_rls:
        # D23: the API's role may never bypass row-level security. Refuse traffic instead.
        log.error("Readiness check: the API's database role bypasses row-level security")
        return _not_ready(request)
    public: Database | None = getattr(request.app.state, "public_db", None)
    if public is not None:
        try:
            public_bypasses = await asyncio.wait_for(public.role_bypasses_rls(),
                                                     READY_TIMEOUT_SECONDS)
        except Exception:
            log.warning("Readiness check: the public forms' database unavailable", exc_info=True)
            return _not_ready(request)
        if public_bypasses:
            log.error("Readiness check: the public forms' database role bypasses row-level "
                      "security")
            return _not_ready(request)
    return {"status": "ready"}


def _not_ready(request: Request) -> JSONResponse:
    return problem(
        request, "service-unavailable", "Not ready", headers={"Retry-After": RETRY_AFTER_SECONDS}
    )


def register(app: FastAPI, settings: Settings) -> None:
    """At the root: /health, /ready."""
    app.include_router(router)
