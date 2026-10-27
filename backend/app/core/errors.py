"""Application errors and the global handlers that turn them into Problem Details (RFC 9457).

Shape and codes follow contracts/docs/API_STANDARDS.md §9. Endpoints raise these classes;
they never build error responses themselves. `detail` must never contain PHI or request
values ("Patient not found", never "Patient John Smith not found").

    raise NotFound()
    raise Conflict(code="booking-conflict")
    raise ValidationFailed(errors=[field_error("body", "/birthDate", "out-of-range")])
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, ClassVar, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.request_id import REQUEST_ID_HEADER

log = logging.getLogger(__name__)

PROBLEM_JSON = "application/problem+json"
DEFAULT_TYPE_BASE = "tag:company-domain.invalid,2026:problem/"


@dataclass(frozen=True)
class ProblemType:
    status: int
    title: str


# API_STANDARDS §9.3. Codes are permanent once released; meanings never change. Titles match
# the contract's examples (contracts/openapi/components/examples/Problem*.yaml).
CATALOGUE: dict[str, ProblemType] = {
    "malformed-request": ProblemType(400, "Malformed request"),
    "invalid-cursor": ProblemType(400, "Invalid cursor"),
    "idempotency-key-missing": ProblemType(400, "Idempotency key missing"),
    "unauthenticated": ProblemType(401, "Not signed in"),
    "session-expired": ProblemType(401, "Session expired"),
    "permission-denied": ProblemType(403, "Permission denied"),
    "csrf-check-failed": ProblemType(403, "CSRF check failed"),
    "break-glass-required": ProblemType(403, "Restricted chart"),
    "not-found": ProblemType(404, "Not found"),
    "method-not-allowed": ProblemType(405, "Method not allowed"),
    "not-acceptable": ProblemType(406, "Not acceptable"),
    "invalid-state-transition": ProblemType(409, "Action not allowed in the current state"),
    "record-locked": ProblemType(409, "Record is locked"),
    "booking-conflict": ProblemType(409, "Booking conflict"),
    "possible-duplicate": ProblemType(409, "Possible duplicate patient"),
    "patient-merged": ProblemType(409, "Patient merged"),
    "idempotency-request-in-progress": ProblemType(409, "Request in progress"),
    "feature-disabled": ProblemType(409, "Feature disabled"),
    "consent-required": ProblemType(409, "Consent required"),
    "gone": ProblemType(410, "Gone"),
    "precondition-failed": ProblemType(412, "Record changed"),
    "payload-too-large": ProblemType(413, "Payload too large"),
    "unsupported-media-type": ProblemType(415, "Unsupported media type"),
    "validation-failed": ProblemType(422, "Request validation failed"),
    "business-rule-violation": ProblemType(422, "Business rule violation"),
    "idempotency-key-reused": ProblemType(422, "Idempotency key reused"),
    "file-not-ready": ProblemType(422, "File not ready"),
    "precondition-required": ProblemType(428, "If-Match required"),
    "rate-limited": ProblemType(429, "Too many requests"),
    "internal-error": ProblemType(500, "Internal error"),
    "upstream-error": ProblemType(502, "Upstream error"),
    "service-unavailable": ProblemType(503, "Service unavailable"),
    "upstream-timeout": ProblemType(504, "Upstream timeout"),
}

# Field error codes (API_STANDARDS §9.2).
FIELD_CODES = frozenset({
    "required", "unknown-field", "invalid-format", "invalid-type", "too-short", "too-long",
    "out-of-range", "not-allowed-value", "invalid-reference", "conflicting-fields", "not-editable",
})


# Standard members of every Problem; extensions may never set or overwrite them.
RESERVED_MEMBERS = frozenset({"type", "title", "status", "detail", "instance", "code", "requestId"})


class AppError(Exception):
    """Base class. Each subclass has a default code; `code=` picks another of the same status."""

    default_code: ClassVar[str] = "internal-error"

    def __init__(
        self,
        detail: str | None = None,
        *,
        code: str | None = None,
        headers: dict[str, str] | None = None,
        **extensions: Any,
    ) -> None:
        code = code or self.default_code
        if code not in CATALOGUE:
            raise ValueError(f"Unknown problem code {code!r}")
        expected = CATALOGUE[self.default_code].status
        if CATALOGUE[code].status != expected:
            raise ValueError(f"{type(self).__name__} needs a {expected} code, got {code!r}")
        reserved = RESERVED_MEMBERS & extensions.keys()
        if reserved:
            raise ValueError(f"Extensions cannot set standard Problem members: {sorted(reserved)}")
        super().__init__(detail or code)
        self.code = code
        self.detail = detail
        self.headers = headers
        self.extensions = extensions

    @property
    def status(self) -> int:
        return CATALOGUE[self.code].status


class Unauthorized(AppError):
    default_code = "unauthenticated"


class Forbidden(AppError):
    default_code = "permission-denied"


class NotFound(AppError):
    default_code = "not-found"


class Conflict(AppError):
    default_code = "invalid-state-transition"


class InvalidCursor(AppError):
    """400: a list cursor that is expired, tampered with or from another endpoint (API_STANDARDS
    §9, §8)."""

    default_code = "invalid-cursor"


class PreconditionFailed(AppError):
    """412: `If-Match` names a version that is no longer current (API_STANDARDS §9, §11). Pass the
    current ETag so the client can re-read: `PreconditionFailed(headers={"ETag": '"7"'})`."""

    default_code = "precondition-failed"


class PreconditionRequired(AppError):
    """428: `If-Match` is missing where the operation requires it (API_STANDARDS §9, §11)."""

    default_code = "precondition-required"


class ValidationFailed(AppError):
    default_code = "validation-failed"


class ServiceUnavailable(AppError):
    default_code = "service-unavailable"


def field_error(location: str, where: str, code: str) -> dict[str, str]:
    """One `errors[]` item: `where` is a JSON pointer for the body, else the parameter name."""
    if code not in FIELD_CODES:
        raise ValueError(f"Unknown field error code {code!r}")
    key = "pointer" if location == "body" else "name"
    return {"in": location, key: where, "code": code}


def problem(
    request: Request,
    code: str,
    detail: str | None = None,
    *,
    headers: Mapping[str, str] | None = None,
    **extensions: Any,
) -> JSONResponse:
    problem_type = CATALOGUE[code]
    settings = getattr(request.app.state, "settings", None)
    type_base = getattr(settings, "problem_type_base", DEFAULT_TYPE_BASE)
    request_id: str | None = getattr(request.state, "request_id", None)

    body: dict[str, Any] = {
        "type": f"{type_base}{code}",
        "title": problem_type.title,
        "status": problem_type.status,
    }
    if detail:
        body["detail"] = detail
    body["instance"] = request.url.path
    body["code"] = code
    if request_id:
        body["requestId"] = request_id
    # Extensions never overwrite the standard members (AppError also refuses them up front).
    body.update({k: v for k, v in extensions.items() if k not in RESERVED_MEMBERS})

    response_headers = dict(headers or {})
    # Also set here: a 500 is sent outside the middleware stack (API_STANDARDS §7.2).
    response_headers.setdefault("Cache-Control", "no-store")
    if request_id:
        response_headers[REQUEST_ID_HEADER] = request_id
    if problem_type.status == 401:
        response_headers.setdefault("WWW-Authenticate", 'Cookie realm="shri-health"')
    return JSONResponse(
        body, status_code=problem_type.status, media_type=PROBLEM_JSON, headers=response_headers
    )


# Pydantic error type → field error code. Anything not listed is "invalid-format".
_FIELD_CODE_BY_TYPE = {
    "missing": "required",
    "extra_forbidden": "unknown-field",
    "string_too_short": "too-short",
    "too_short": "too-short",
    "string_too_long": "too-long",
    "too_long": "too-long",
    "greater_than": "out-of-range",
    "greater_than_equal": "out-of-range",
    "less_than": "out-of-range",
    "less_than_equal": "out-of-range",
    "multiple_of": "out-of-range",
    "literal_error": "not-allowed-value",
    "enum": "not-allowed-value",
}
# The contract's FieldError.in allows only these four (no cookie parameters in the API).
_LOCATIONS = {"body", "query", "path", "header"}


_INVALID_TYPE_PREFIXES = ("int_", "float_", "bool_", "string_type", "list_", "dict_", "model_")


def _field_code(error_type: str) -> str:
    if error_type in _FIELD_CODE_BY_TYPE:
        return _FIELD_CODE_BY_TYPE[error_type]
    if error_type.startswith(_INVALID_TYPE_PREFIXES):
        return "invalid-type"
    return "invalid-format"


def _json_pointer(parts: tuple[Any, ...]) -> str:
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in parts)


def _to_field_error(error: dict[str, Any]) -> dict[str, str]:
    loc = tuple(error.get("loc", ()))
    location = loc[0] if loc and loc[0] in _LOCATIONS else "body"
    rest = loc[1:] if loc and loc[0] in _LOCATIONS else loc
    code = _field_code(str(error.get("type", "")))
    if location == "body":
        return {"in": "body", "pointer": _json_pointer(rest), "code": code}
    return {"in": location, "name": str(rest[0]) if rest else "", "code": code}


async def _app_error(request: Request, exc: Exception) -> JSONResponse:
    err = cast(AppError, exc)
    return problem(request, err.code, err.detail, headers=err.headers, **err.extensions)


IDEMPOTENCY_HEADER = "idempotency-key"


def _is_idempotency_header(error: dict[str, Any]) -> bool:
    loc = tuple(error.get("loc", ()))
    return len(loc) == 2 and loc[0] == "header" and str(loc[1]).lower() == IDEMPOTENCY_HEADER


async def _validation_error(request: Request, exc: Exception) -> JSONResponse:
    raw = cast(RequestValidationError, exc).errors()
    if any(e.get("type") == "json_invalid" for e in raw):
        return problem(request, "malformed-request", "Request body is not valid JSON")
    # A missing Idempotency-Key is 400 idempotency-key-missing (API_STANDARDS §9.3, §10). A
    # malformed one stays a field error below: 422 naming the header, like any parameter (§9.2).
    if any(_is_idempotency_header(e) and e.get("type") == "missing" for e in raw):
        return problem(request, "idempotency-key-missing", "Send an Idempotency-Key header")
    # Field errors carry location and code only: never the submitted value (may be PHI).
    errors = [_to_field_error(e) for e in raw]
    detail = "1 field is invalid." if len(errors) == 1 else f"{len(errors)} fields are invalid."
    return problem(request, "validation-failed", detail, errors=errors)


_CODE_BY_STATUS = {
    400: "malformed-request",
    401: "unauthenticated",
    403: "permission-denied",
    404: "not-found",
    405: "method-not-allowed",
    406: "not-acceptable",
    413: "payload-too-large",
    415: "unsupported-media-type",
    429: "rate-limited",
    503: "service-unavailable",
}


async def _http_error(request: Request, exc: Exception) -> JSONResponse:
    err = cast(StarletteHTTPException, exc)
    # Keep the framework's headers, e.g. Allow on a 405 (RFC 9110 §15.5.6).
    return problem(
        request, _CODE_BY_STATUS.get(err.status_code, "internal-error"), headers=err.headers
    )


async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    return problem(request, "internal-error")


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, _app_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(Exception, _unhandled_error)
