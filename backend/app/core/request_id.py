"""X-Request-ID on every request and response, and W3C traceparent propagation (API_STANDARDS §18).

A client-sent X-Request-ID is kept only if it is a valid UUID; anything else is replaced, so
callers cannot inject text into logs. The ID is available as `request.state.request_id`
and, for log records and outbound calls, through `current_request_id()`.
"""

import re
from contextvars import ContextVar
from uuid import UUID, uuid4

from fastapi import FastAPI
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import Settings

REQUEST_ID_HEADER = "X-Request-ID"

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
_traceparent: ContextVar[str | None] = ContextVar("traceparent", default=None)

_TRACEPARENT = re.compile(r"^[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$")


def current_request_id() -> str | None:
    return _request_id.get()


def current_traceparent() -> str | None:
    return _traceparent.get()


def _valid_uuid(value: str | None) -> str | None:
    if not value or len(value) > 36:
        return None
    try:
        return str(UUID(value))
    except ValueError:
        return None


class RequestIdMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        request_id = _valid_uuid(headers.get(REQUEST_ID_HEADER)) or str(uuid4())
        traceparent = headers.get("traceparent")
        if traceparent is not None and not _TRACEPARENT.match(traceparent):
            traceparent = None

        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        state["traceparent"] = traceparent

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_headers = MutableHeaders(scope=message)
                if REQUEST_ID_HEADER not in response_headers:
                    response_headers[REQUEST_ID_HEADER] = request_id
            await send(message)

        request_token = _request_id.set(request_id)
        trace_token = _traceparent.set(traceparent)
        try:
            await self.app(scope, receive, send_with_id)
        finally:
            _request_id.reset(request_token)
            _traceparent.reset(trace_token)


def register(app: FastAPI, settings: Settings) -> None:
    """RequestIdMiddleware (outermost: every answer carries X-Request-ID)."""
    app.add_middleware(RequestIdMiddleware)
