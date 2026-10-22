"""GET /health (the process is up) and GET /ready (it can serve requests).

Both sit at the root, outside /api/v1, so load-balancer checks never change with the API
version (API_STANDARDS §2). Nginx exposes /health publicly; /ready is for internal checks.
"""

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

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
        await asyncio.wait_for(db.ping(), READY_TIMEOUT_SECONDS)
    except Exception:
        # Log the cause, but never return connection details to the caller.
        log.warning("Readiness check: database unavailable", exc_info=True)
        return _not_ready(request)
    return {"status": "ready"}


def _not_ready(request: Request) -> JSONResponse:
    return problem(
        request, "service-unavailable", "Not ready", headers={"Retry-After": RETRY_AFTER_SECONDS}
    )
