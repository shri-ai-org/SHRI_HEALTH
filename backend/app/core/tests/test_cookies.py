"""Core's cookies at the site root (`__Host-`, Path=/) and under a base path on a shared host
(`__Secure-`, Path=/dep): core/cookies.py, the deploy kit's two modes (infra/deploy/README.md)."""

from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError
from starlette.requests import Request
from starlette.responses import Response

from app.core import cookies
from app.core.config import Settings
from app.core.portal_sign_in import PORTAL_COOKIE
from app.core.session import LOGIN_COOKIE, SESSION_COOKIE

TOKEN = "synthetic-session-reference"  # noqa: S105 (not a real token)


def _settings(**values: Any) -> Settings:
    return Settings(environment="test", **values)


def _request(settings: Settings, cookie_header: str) -> Request:
    scope = {"type": "http", "headers": [(b"cookie", cookie_header.encode())],
             "app": SimpleNamespace(state=SimpleNamespace(settings=settings))}
    return Request(scope)


def _set_cookie(response: Response) -> str:
    return next(v.decode() for k, v in response.raw_headers if k == b"set-cookie")


def test_at_the_site_root_every_cookie_keeps_its_host_prefix() -> None:
    settings = _settings()
    assert settings.cookie_path == "/"
    for name in (SESSION_COOKIE, LOGIN_COOKIE, PORTAL_COOKIE):
        assert cookies.name(settings, name) == name and name.startswith("__Host-")
    response = Response()
    cookies.put(response, settings, SESSION_COOKIE, TOKEN, samesite="strict")
    header = _set_cookie(response)
    assert header.startswith(f"__Host-shri_session={TOKEN};")
    assert "Path=/;" in header + ";" and "Secure" in header and "HttpOnly" in header
    assert "SameSite=strict" in header and "Domain" not in header


def test_under_a_base_path_cookies_are_secure_prefixed_and_scoped_to_it() -> None:
    settings = _settings(cookie_path="/dep")
    assert cookies.name(settings, SESSION_COOKIE) == "__Secure-shri_session"
    assert cookies.name(settings, PORTAL_COOKIE) == "__Secure-shri_portal"
    response = Response()
    cookies.put(response, settings, LOGIN_COOKIE, "k", samesite="lax", max_age=600)
    header = _set_cookie(response)
    assert header.startswith("__Secure-shri_login=k;")
    assert "Path=/dep" in header and "Secure" in header and "HttpOnly" in header
    assert "SameSite=lax" in header and "Domain" not in header

    removed = Response()
    cookies.remove(removed, settings, SESSION_COOKIE, samesite="strict")
    assert "__Secure-shri_session=" in _set_cookie(removed)
    assert "Path=/dep" in _set_cookie(removed)


def test_each_mode_reads_only_its_own_cookie_name() -> None:
    at_root, under_path = _settings(), _settings(cookie_path="/dep")
    both = f"__Host-shri_session=root-{TOKEN}; __Secure-shri_session=path-{TOKEN}"
    assert cookies.read(_request(at_root, both), SESSION_COOKIE) == f"root-{TOKEN}"
    assert cookies.read(_request(under_path, both), SESSION_COOKIE) == f"path-{TOKEN}"
    assert cookies.read(_request(under_path, f"__Host-shri_session={TOKEN}"),
                        SESSION_COOKIE) is None


@pytest.mark.parametrize("path", ["/dep", "/demo/shri", "/a-1"])
def test_a_plain_base_path_is_accepted(path: str) -> None:
    assert _settings(cookie_path=path).cookie_path == path


@pytest.mark.parametrize("path", ["", "dep", "/dep/", "/Dep", "/de p", "/dep;x", "//dep", "/.."])
def test_anything_else_is_refused_at_startup(path: str) -> None:
    with pytest.raises(ValidationError, match="COOKIE_PATH"):
        _settings(cookie_path=path)
