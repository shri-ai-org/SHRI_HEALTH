"""What a feature asks the app to close at shutdown, in the order the features registered."""

from collections.abc import Awaitable, Callable

from fastapi import FastAPI

Closer = Callable[[], Awaitable[None]]


def on_shutdown(app: FastAPI, closer: Closer) -> None:
    closers: list[Closer] = getattr(app.state, "closers", [])
    closers.append(closer)
    app.state.closers = closers


async def shut_down(app: FastAPI) -> None:
    for closer in getattr(app.state, "closers", []):
        await closer()
