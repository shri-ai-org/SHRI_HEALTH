"""GET /health (the process is up) and GET /ready (it can serve requests)."""

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


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready", response_model=None)
async def ready(request: Request) -> dict[str, Any] | JSONResponse:
    db: Database | None = request.app.state.db
    checks: dict[str, str] = {}
    if db is None:
        checks["database"] = "not_configured"
    else:
        try:
            await asyncio.wait_for(db.ping(), READY_TIMEOUT_SECONDS)
            checks["database"] = "ok"
        except Exception:
            # Log the cause, but never return connection details to the caller.
            log.warning("Readiness check: database unavailable", exc_info=True)
            checks["database"] = "unavailable"
    if all(value == "ok" for value in checks.values()):
        return {"status": "ready", "checks": checks}
    return problem(503, "Not ready", instance=request.url.path, checks=checks)
