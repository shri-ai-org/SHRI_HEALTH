"""What create_app() puts together, in order: one line per feature, each its module's
register(app, settings).

The order is the app's behaviour, so it is the one thing to keep in mind when adding a line:
- **App state first** (databases, encryption, public forms, staff sessions): nothing reads it
  until a request arrives, so these may be in any order among themselves.
- **Middleware next, innermost first:** each add_middleware wraps what came before. Audit is
  innermost (it sees the final status); Idempotency sits outside it (it stores that status, audit
  500s included); NoStore; RequestId outermost (every answer carries X-Request-ID).
- **Error handlers**, then the idempotent-replay handler, in that order.
- **Routes last,** in the order they match: /health, sign-in, the bot challenge, events,
  operations, then every module's router.

test_registry.py checks the result against the sequence create_app() used before the registry:
the same middleware stack, routes, error handlers and app state.
"""

from collections.abc import Callable

from fastapi import FastAPI

from app.core import (
    audit,
    auth_api,
    crypto,
    db,
    errors,
    events,
    health,
    idempotency,
    long_running,
    public_form,
    request_id,
    response_headers,
    routing,
    session,
)
from app.core.config import Settings

Register = Callable[[FastAPI, Settings], None]

FEATURES: tuple[tuple[str, Register], ...] = (
    # App state
    ("database", db.register),
    ("field encryption", crypto.register),
    ("public forms", public_form.register),
    ("staff sessions", session.register),
    # Middleware, innermost first
    ("audit", audit.register),
    ("idempotency", idempotency.register),
    ("no-store", response_headers.register),
    ("request ID", request_id.register),
    # Error handlers
    ("errors", errors.register),
    ("idempotent replays", idempotency.register_replays),
    # Routes, in matching order
    ("health", health.register),
    ("staff sign-in", auth_api.register),
    ("bot challenge", public_form.register_routes),
    ("events", events.register),
    ("operations", long_running.register),
    ("modules", routing.register),
)


def register_all(app: FastAPI, settings: Settings) -> None:
    for _name, register in FEATURES:
        register(app, settings)
