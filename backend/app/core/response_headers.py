"""Cache-Control: no-store on every response (API_STANDARDS §7.2), so PHI never sits in browser
or proxy caches. An endpoint that sets its own Cache-Control keeps it."""

from fastapi import FastAPI
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import Settings


class NoStoreMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if "cache-control" not in headers:
                    headers["Cache-Control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_no_store)


def register(app: FastAPI, settings: Settings) -> None:
    """NoStoreMiddleware (Cache-Control: no-store on API answers)."""
    app.add_middleware(NoStoreMiddleware)
