"""Mounting test stand-in routes ahead of the real ones.

Core's tests serve real contract operationIds from stand-in routes, so the operation's x-audit,
x-permission and x-idempotency apply. create_app() has already mounted the modules' real routers
(include_module_routers), and Starlette uses the first route that matches; a stand-in mounted
after them on the same path (GET /patients/{patientId} once PR-1 lands, #78) would never be
reached. include_first() puts it in front.
"""

from typing import Any

from fastapi import APIRouter, FastAPI


def include_first(app: FastAPI, router: APIRouter, **kwargs: Any) -> None:
    """`app.include_router(router, **kwargs)`, ahead of every route already mounted."""
    before = len(app.router.routes)
    app.include_router(router, **kwargs)
    added = app.router.routes[before:]
    del app.router.routes[before:]
    app.router.routes[:0] = added
