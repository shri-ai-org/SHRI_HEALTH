"""Application errors and the global handlers that turn them into Problem JSON (RFC 9457).

Endpoints raise these classes; they never build error responses themselves.
"""

import logging
from http import HTTPStatus
from typing import Any, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger(__name__)

PROBLEM_JSON = "application/problem+json"


class AppError(Exception):
    status: int = 500

    def __init__(self, detail: str | None = None, **extra: Any) -> None:
        super().__init__(detail)
        self.detail = detail
        self.extra = extra


class Unauthorized(AppError):
    status = 401


class Forbidden(AppError):
    status = 403


class NotFound(AppError):
    status = 404


class Conflict(AppError):
    status = 409


class ValidationFailed(AppError):
    status = 422


class ServiceUnavailable(AppError):
    status = 503


def problem(
    status: int, detail: str | None = None, *, instance: str | None = None, **extra: Any
) -> JSONResponse:
    body: dict[str, Any] = {
        "type": "about:blank",
        "title": HTTPStatus(status).phrase,
        "status": status,
    }
    if detail:
        body["detail"] = detail
    if instance:
        body["instance"] = instance
    body.update(extra)
    headers = {"WWW-Authenticate": "Cookie"} if status == 401 else None
    return JSONResponse(body, status_code=status, media_type=PROBLEM_JSON, headers=headers)


async def _app_error(request: Request, exc: Exception) -> JSONResponse:
    err = cast(AppError, exc)
    return problem(err.status, err.detail, instance=request.url.path, **err.extra)


async def _validation_error(request: Request, exc: Exception) -> JSONResponse:
    # Only location, message and type: never echo the submitted value, which may be patient data.
    errors = [
        {"loc": list(e.get("loc", ())), "msg": e.get("msg", ""), "type": e.get("type", "")}
        for e in cast(RequestValidationError, exc).errors()
    ]
    return problem(422, "Request validation failed", instance=request.url.path, errors=errors)


async def _http_error(request: Request, exc: Exception) -> JSONResponse:
    err = cast(StarletteHTTPException, exc)
    detail: str | None = err.detail if isinstance(err.detail, str) else None
    if detail == HTTPStatus(err.status_code).phrase:
        detail = None
    return problem(err.status_code, detail, instance=request.url.path)


async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    return problem(500, instance=request.url.path)


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, _app_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(Exception, _unhandled_error)
