"""Staff sign-in rules that need no database: PKCE, the login state, the ID token's claims, CSRF,
what counts as activity, and the Keycloak calls (a fake Keycloak). The whole flow against
PostgreSQL is in test_session_postgres.py. Synthetic values only."""

import json
import secrets
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from starlette.requests import Request

from app.core import session as sessions
from app.core.config import Settings
from app.core.errors import Forbidden, ServiceUnavailable, ValidationFailed

PUBLIC = "https://portal.example.test/kc"
ISSUER = f"{PUBLIC}/realms/shri-staff"
CLIENT_SECRET = secrets.token_hex(16)  # made at run time: no secret-like literal
SESSION_SECRET = secrets.token_hex(32)
ORIGIN = "https://portal.example.test"


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "environment": "test", "auth_mode": "keycloak", "keycloak_public_url": PUBLIC,
        "keycloak_internal_url": "http://keycloak.test:8080/kc",
        "keycloak_client_secret": SecretStr(CLIENT_SECRET),
        "keycloak_redirect_uri": f"{ORIGIN}/api/v1/auth/callback",
        "session_secret": SecretStr(SESSION_SECRET), "allowed_origins": [ORIGIN]}
    values.update(overrides)
    return Settings(**values)


def test_pkce_matches_rfc_7636_appendix_b() -> None:
    assert sessions.pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == (
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def test_a_login_state_is_used_once_and_expires_after_ten_minutes() -> None:
    clock = Clock()
    states = sessions.LoginStates(clock)
    key, state = states.new()
    assert states.take(key) == state
    assert states.take(key) is None  # used
    key, _ = states.new()
    clock.now += 601
    assert states.take(key) is None  # too old
    assert states.take(None) is None and states.take("unknown") is None


def test_the_login_redirect_uses_pkce_s256_and_always_asks_for_credentials() -> None:
    keycloak = sessions.Keycloak(_settings())
    _, state = sessions.LoginStates().new()
    url = urlparse(keycloak.login_redirect(state))
    query = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert f"{url.scheme}://{url.netloc}{url.path}" == f"{ISSUER}/protocol/openid-connect/auth"
    assert query["code_challenge_method"] == "S256"
    assert query["code_challenge"] == sessions.pkce_challenge(state.verifier)
    assert (query["state"], query["nonce"], query["prompt"]) == (state.state, state.nonce, "login")
    assert query["response_type"] == "code" and query["scope"] == "openid"
    assert CLIENT_SECRET not in url.query and state.verifier not in url.query


def _claims(**changes: Any) -> dict[str, Any]:
    now = int(time.time())
    claims: dict[str, Any] = {"iss": ISSUER, "aud": "shri-web", "azp": "shri-web",
                              "exp": now + 300, "iat": now, "nonce": "n-1", "sub": "kc-user-1",
                              "sid": "kc-session-1"}
    claims.update(changes)
    return claims


def test_a_matching_id_token_passes() -> None:
    sessions.Keycloak(_settings()).check_id_claims(_claims(), "n-1")
    sessions.Keycloak(_settings()).check_id_claims(_claims(aud=["shri-web", "account"]), "n-1")


@pytest.mark.parametrize("changes", [
    {"iss": "https://evil.example.test/kc/realms/shri-staff"},
    {"aud": "another-client"},
    {"aud": ["another-client", "shri-web"], "azp": "another-client"},
    {"exp": int(time.time()) - 3600},
    {"iat": int(time.time()) + 3600},
    {"nonce": "n-2"},
    {"nonce": None},
    {"sub": ""},
])
def test_an_id_token_for_another_login_is_refused(changes: dict[str, Any]) -> None:
    with pytest.raises(ValidationFailed):
        sessions.Keycloak(_settings()).check_id_claims(_claims(**changes), "n-1")


@pytest.mark.parametrize(("method", "path", "activity"), [
    ("GET", "/api/v1/auth/session", False),
    ("GET", "/api/v1/events/stream", False),
    ("GET", "/api/v1/operations/0b1c", False),
    ("POST", "/api/v1/operations/0b1c/cancel", True),
    ("POST", "/api/v1/auth/refresh", True),
    ("GET", "/api/v1/patients/0b1c", True),
])
def test_only_user_initiated_requests_move_the_idle_timer(method: str, path: str,
                                                         activity: bool) -> None:
    assert sessions.is_user_activity(method, path) is activity


def _request(method: str, headers: dict[str, str]) -> Request:
    return Request({"type": "http", "method": method, "path": "/x", "query_string": b"",
                    "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]})


def test_csrf_needs_an_allowed_origin_and_the_sessions_token_on_unsafe_methods() -> None:
    settings = _settings()
    token = "session-token-a"
    good = sessions.csrf_token(settings, token)
    sessions.check_csrf(_request("GET", {}), settings, token)  # safe methods: no check
    sessions.check_csrf(_request("POST", {"Origin": ORIGIN, "X-CSRF-Token": good}), settings,
                        token)
    for headers in ({}, {"X-CSRF-Token": good}, {"Origin": ORIGIN},
                    {"Origin": "https://evil.example.test", "X-CSRF-Token": good},
                    {"Origin": ORIGIN, "X-CSRF-Token": "0" * 64},
                    {"Origin": ORIGIN,
                     "X-CSRF-Token": sessions.csrf_token(settings, "session-token-b")}):
        with pytest.raises(Forbidden) as refused:
            sessions.check_csrf(_request("PATCH", headers), settings, token)
        assert refused.value.code == "csrf-check-failed"


def test_the_csrf_token_is_bound_to_the_session_and_keyed() -> None:
    settings = _settings()
    assert sessions.csrf_token(settings, "a") != sessions.csrf_token(settings, "b")
    other = _settings(session_secret=SecretStr(secrets.token_hex(32)))
    assert sessions.csrf_token(settings, "a") != sessions.csrf_token(other, "a")
    no_secret = _settings()
    no_secret.session_secret = None
    with pytest.raises(ServiceUnavailable):
        sessions.csrf_token(no_secret, "a")


# -------------------------------------------------------------------------- Keycloak calls
def _id_token(claims: dict[str, Any]) -> str:
    import base64

    def part(data: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")

    return f"{part({'alg': 'RS256'})}.{part(claims)}.c2lnbmF0dXJl"


def _keycloak(handler: Any) -> sessions.Keycloak:
    return sessions.Keycloak(_settings(), transport=httpx.MockTransport(handler))


async def test_the_code_is_exchanged_server_to_server_with_the_secret_in_the_body() -> None:
    seen: list[httpx.Request] = []

    def token_endpoint(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"access_token": "a", "refresh_token": "r",
                                         "id_token": _id_token(_claims())})

    tokens = await _keycloak(token_endpoint).exchange("code-1", "verifier-1")
    assert tokens.id_claims["sub"] == "kc-user-1"
    (request,) = seen
    form = parse_qs(request.content.decode())
    assert str(request.url) == ("http://keycloak.test:8080/kc/realms/shri-staff/"
                                "protocol/openid-connect/token")
    assert form["grant_type"] == ["authorization_code"] and form["code_verifier"] == ["verifier-1"]
    assert form["client_secret"] == [CLIENT_SECRET] and CLIENT_SECRET not in str(request.url)


@pytest.mark.parametrize(("status", "expected"), [(400, sessions.KeycloakRefused),
                                                  (401, sessions.KeycloakRefused),
                                                  (500, ServiceUnavailable)])
async def test_keycloak_saying_no_and_keycloak_failing_differ(status: int,
                                                              expected: type) -> None:
    keycloak = _keycloak(lambda _: httpx.Response(status, json={"error": "invalid_grant"}))
    with pytest.raises(expected):
        await keycloak.refresh("r")


async def test_keycloak_unreachable_is_503() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ServiceUnavailable):
        await _keycloak(down).exchange("c", "v")


async def test_an_unreadable_id_token_is_503() -> None:
    keycloak = _keycloak(lambda _: httpx.Response(200, json={
        "access_token": "a", "refresh_token": "r", "id_token": "not-a-jwt"}))
    with pytest.raises(ServiceUnavailable):
        await keycloak.exchange("c", "v")


# ------------------------------------------------------------------------------ the routes
def test_login_sends_the_browser_to_keycloak_with_a_login_state_cookie() -> None:
    from app.main import create_app

    client = TestClient(create_app(_settings()), base_url="https://testserver")
    response = client.get("/api/v1/auth/login", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"].startswith(f"{ISSUER}/protocol/openid-connect/auth?")
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{sessions.LOGIN_COOKIE}=")
    for attribute in ("HttpOnly", "Secure", "SameSite=lax", "Path=/", "Max-Age=600"):
        assert attribute.lower() in cookie.lower(), attribute


@pytest.mark.parametrize("secret", [None, "too-short"])
def test_sign_in_without_a_proper_csrf_key_stops_startup(secret: str | None) -> None:
    from app.main import create_app

    with pytest.raises(ValueError, match="SESSION_SECRET"):
        create_app(_settings(session_secret=SecretStr(secret) if secret else None))


def test_sign_in_unconfigured_is_503() -> None:
    from app.main import create_app

    client = TestClient(create_app(Settings(environment="test", auth_mode="keycloak")),
                        base_url="https://testserver")
    assert client.get("/api/v1/auth/login", follow_redirects=False).status_code == 503


@pytest.mark.parametrize("query", ["", "?code=c", "?state=s"])
def test_a_callback_without_code_and_state_is_422(query: str) -> None:
    from app.main import create_app

    client = TestClient(create_app(_settings()), base_url="https://testserver")
    assert client.get(f"/api/v1/auth/callback{query}", follow_redirects=False).status_code == 422


def test_a_callback_without_its_login_cookie_or_with_another_state_is_422() -> None:
    from app.main import create_app

    client = TestClient(create_app(_settings()), base_url="https://testserver")
    assert client.get("/api/v1/auth/callback?code=c&state=s",
                      follow_redirects=False).status_code == 422
    client.get("/api/v1/auth/login", follow_redirects=False)  # sets the login cookie
    wrong = client.get("/api/v1/auth/callback?code=c&state=not-the-state",
                       follow_redirects=False)
    assert wrong.status_code == 422 and wrong.json()["code"] == "validation-failed"


def test_without_a_session_cookie_staff_routes_are_401() -> None:
    from app.main import create_app

    client = TestClient(create_app(_settings()), base_url="https://testserver")
    response = client.get("/api/v1/auth/session")
    assert response.status_code == 401 and response.json()["code"] == "unauthenticated"
