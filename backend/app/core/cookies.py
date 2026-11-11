"""Core's cookies (staff and portal sessions, their login cookies) and where they apply.

At the site root (`COOKIE_PATH=/`, the default) every cookie keeps its `__Host-` name: the
browser then insists on Secure, no Domain and Path=/, so no other host can set or read it.

Under a path on a shared host (`COOKIE_PATH=/dep`, the deploy kit's path mode) a `__Host-`
cookie is impossible, since that prefix requires Path=/. The cookies become `__Secure-` with
Path=/dep, so the browser sends them only to our paths; the prefix still requires Secure. Every
other attribute (HttpOnly, SameSite) is unchanged. The subdomain mode keeps `__Host-`, which is
one reason it is recommended (infra/deploy/README.md).
"""

from typing import Any, Literal

from fastapi import Request

from app.core.config import Settings

HOST_PREFIX = "__Host-"
SECURE_PREFIX = "__Secure-"
SameSite = Literal["strict", "lax"]


def name(settings: Settings, host_name: str) -> str:
    """The cookie's name for this deployment: `host_name` (a `__Host-` name) at the root,
    otherwise the same name with `__Secure-`."""
    if settings.cookie_path == "/":
        return host_name
    return SECURE_PREFIX + host_name.removeprefix(HOST_PREFIX)


def read(request: Request, host_name: str) -> str | None:
    settings: Settings = request.app.state.settings
    value: str | None = request.cookies.get(name(settings, host_name))
    return value


def put(response: Any, settings: Settings, host_name: str, value: str, *, samesite: SameSite,
        max_age: int | None = None) -> None:
    response.set_cookie(name(settings, host_name), value, max_age=max_age, httponly=True,
                        secure=True, samesite=samesite, path=settings.cookie_path)


def remove(response: Any, settings: Settings, host_name: str, *, samesite: SameSite) -> None:
    response.delete_cookie(name(settings, host_name), httponly=True, secure=True,
                           samesite=samesite, path=settings.cookie_path)
