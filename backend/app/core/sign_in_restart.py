"""A sign-in callback that can't finish sends a browser back to start again (finishLogin and
completePortalLogin, contract #309).

When the callback has no matching login (``code`` or ``state`` missing, as when Keycloak returns
``error=access_denied`` or an expired login; no login cookie; an unknown, used or expired key;
another ``state``), a browser navigation gets ``303`` to the sign-in start next to the callback,
and lands on Keycloak's form again. An API client keeps the ``422`` problem response. A refused
code or a nonce mismatch is never a restart: those stay ``422``.

``Location`` is relative (``login``, next to ``callback``), so it holds under a base path the API
never sees. The login cookie is cleared. Nothing is signed in, so a forged or replayed callback
gains nothing, and Keycloak's form (``prompt=login``) waits for the user, so it can't loop.

No audit row: before the login matches there is no clinic or user to record it against (audit
rows are clinic rows under row security). It is logged as a security warning instead, with no
request values: never the code, the state or a cookie.
"""

import logging

from fastapi.responses import RedirectResponse
from starlette.requests import Request

from app.core import cookies

log = logging.getLogger(__name__)

_HTML = "text/html"
_JSON = ("application/json", "application/problem+json")


def _quality(accept: str, media_types: tuple[str, ...]) -> float:
    """The highest q this Accept header gives any of these exact media types (0 if none)."""
    best = 0.0
    for item in accept.split(","):
        parts = [p.strip() for p in item.split(";")]
        if parts[0].lower() not in media_types:
            continue
        q = 1.0
        for param in parts[1:]:
            name, _, value = param.partition("=")
            if name.strip().lower() == "q":
                try:
                    q = float(value)
                except ValueError:
                    q = 0.0
        best = max(best, q)
    return best


def browser_navigation(request: Request) -> bool:
    """True when the request's Accept prefers text/html to JSON and problem+json: a browser
    following Keycloak's redirect. An API client, or a wildcard-only Accept, is not."""
    accept = request.headers.get("accept", "")
    return _quality(accept, (_HTML,)) > _quality(accept, _JSON)


def start_again(request: Request, cookie: str, which: str) -> RedirectResponse:
    """303 to the sign-in start next to the callback, with the login cookie cleared."""
    log.warning("%s sign-in callback without a matching login; the browser starts again", which)
    response = RedirectResponse("login", status_code=303)
    response.headers["Cache-Control"] = "no-store"
    cookies.remove(response, request.app.state.settings, cookie, samesite="lax")
    return response
