"""uvicorn's access log names paths only, never a query string (core/access_log.py, T53)."""

import logging
import secrets

from fastapi import FastAPI

from app.core.access_log import ACCESS_LOGGER, DropSecretQueries, register
from app.core.config import Settings

TOKEN = f"{secrets.token_urlsafe(24)}.{secrets.token_urlsafe(32)}"  # made at run time


def _record(path: str) -> logging.LogRecord:
    return logging.LogRecord(ACCESS_LOGGER, logging.INFO, __file__, 1,
                             '%s - "%s %s HTTP/%s" %d',
                             ("10.0.0.1:5000", "GET", path, "1.1", 200), None)


def test_the_content_routes_query_is_dropped() -> None:
    record = _record(f"/api/v1/files/0b1c/content?token={TOKEN}")
    assert DropSecretQueries().filter(record)
    message = record.getMessage()
    assert TOKEN not in message and "/api/v1/files/0b1c/content?…" in message


def test_the_sign_in_callbacks_code_and_state_are_dropped() -> None:
    code, state = secrets.token_urlsafe(32), secrets.token_urlsafe(16)
    for route in ("/api/v1/auth/callback", "/api/v1/portal/auth/callback"):
        record = _record(f"{route}?state={state}&session_state=x&code={code}")
        assert DropSecretQueries().filter(record)
        message = record.getMessage()
        assert code not in message and state not in message and f"{route}?…" in message


def test_every_query_is_dropped() -> None:
    record = _record("/api/v1/appointments?dateFrom=2026-11-01&patient=a?b")
    DropSecretQueries().filter(record)
    message = record.getMessage()
    assert "dateFrom" not in message and "/api/v1/appointments?…" in message


def test_paths_without_a_query_are_left_alone() -> None:
    for path in ("/api/v1/files/0b1c", "/health"):
        record = _record(path)
        DropSecretQueries().filter(record)
        assert path in record.getMessage() and "?" not in record.getMessage()


def test_the_filter_is_installed_once() -> None:
    settings = Settings(environment="test")
    register(FastAPI(), settings)
    register(FastAPI(), settings)
    filters = logging.getLogger(ACCESS_LOGGER).filters
    assert sum(isinstance(f, DropSecretQueries) for f in filters) == 1
