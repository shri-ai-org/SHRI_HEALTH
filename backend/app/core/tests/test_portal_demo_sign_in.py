"""The demo server's portal sign-in rules that need no database (core/portal_demo_sign_in.py,
D121): the startup refusals, the number's normalisation, the guard per IP and per number, the
one refusal, and the route (off is a 404; the Origin; the session and cookie on a match; nothing
of the number or the date of birth in the logs). The flow against PostgreSQL is in
test_portal_demo_sign_in_postgres.py. Synthetic values only; secrets made at run time."""

import logging
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app.core import portal_demo_sign_in as demo
from app.core import portal_sign_in as portal
from app.core.config import Settings
from app.core.errors import AppError

ORIGIN = "https://portal.example.test"
ROUTE = "/api/v1/portal/auth/demo-sign-in"
NUMBER, BIRTH = "(408) 555-0142", "1984-07-19"  # fictional


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "environment": "staging", "shri_demo": True, "portal_demo_sign_in": True,
        "portal_session_secret": SecretStr(secrets.token_hex(32)), "portal_origin": ORIGIN,
        "public_form_secret": SecretStr(secrets.token_hex(32))}  # the portal host's forms
    values.update(overrides)
    return Settings(**values)


# ------------------------------------------------------------------- startup refusals
def test_off_by_default() -> None:
    settings = Settings(environment="test")
    assert settings.portal_demo_sign_in is False and settings.shri_demo is False


def test_on_with_shri_demo_outside_production_starts() -> None:
    assert _settings().portal_demo_sign_in is True


def test_on_in_production_refuses_to_start() -> None:
    with pytest.raises(ValidationError, match="never allowed in production"):
        _settings(environment="production")


def test_on_without_shri_demo_refuses_to_start() -> None:
    with pytest.raises(ValidationError, match="needs SHRI_DEMO=true"):
        _settings(shri_demo=False)


def test_the_environment_variables_turn_it_on_and_refuse_it_the_same_way(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "staging")
    monkeypatch.setenv("PORTAL_DEMO_SIGN_IN", "true")
    with pytest.raises(ValidationError, match="needs SHRI_DEMO=true"):
        Settings()
    monkeypatch.setenv("SHRI_DEMO", "true")
    assert Settings().portal_demo_sign_in is True


# ------------------------------------------------------------------------- the number
@pytest.mark.parametrize(("typed", "digits"), [
    ("(408) 555-0142", "14085550142"), ("408-555-0142", "14085550142"),
    ("408.555.0142", "14085550142"), ("+14085550142", "14085550142"),
    ("+1 408 555 0142", "14085550142"), ("1 (408) 555-0142", "14085550142"),
    ("+44 20 7946 0958", "442079460958"),
])
def test_a_number_becomes_e164_digits(typed: str, digits: str) -> None:
    assert demo.normalize_mobile(typed) == digits


@pytest.mark.parametrize("typed", ["", "555-0142", "0408 555 0142 99", "408-555-01x2",
                                   "+0 408 555 0142", "+1234567890123456", "4085550142;--"])
def test_anything_else_is_no_number(typed: str) -> None:
    assert demo.normalize_mobile(typed) is None


def test_every_refusal_is_the_same_answer() -> None:
    refused = demo.refused()
    assert refused.status == 422 and refused.code == "business-rule-violation"
    assert refused.extensions["errors"] == [{"in": "body", "pointer": "/mobileNumber",
                                             "code": "not-allowed-value"}]


# -------------------------------------------------------------------------- the guard
class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_attempts_are_limited_per_ip() -> None:
    clock = Clock()
    guard = demo.DemoSignInGuard(2, 100, clock)
    guard.attempt("198.51.100.7", "(408) 555-0101")
    guard.attempt("198.51.100.7", "(408) 555-0102")
    guard.attempt("203.0.113.9", "(408) 555-0103")  # another IP has its own budget
    with pytest.raises(AppError) as limited:
        guard.attempt("198.51.100.7", "(408) 555-0104")
    assert limited.value.status == 429 and int((limited.value.headers or {})["Retry-After"]) > 0
    clock.now += demo.WINDOW_SECONDS
    guard.attempt("198.51.100.7", "(408) 555-0105")


def test_attempts_are_limited_per_number_however_it_is_typed() -> None:
    guard = demo.DemoSignInGuard(100, 2, Clock())
    guard.attempt("198.51.100.7", "(408) 555-0142")
    guard.attempt("203.0.113.9", "+1 408 555 0142")  # another address, the same number
    with pytest.raises(AppError) as limited:
        guard.attempt("192.0.2.4", "408.555.0142")
    assert limited.value.status == 429
    guard.attempt("192.0.2.4", "(408) 555-0143")  # another number has its own budget


def test_a_refused_attempt_spends_nothing_and_the_number_is_kept_only_as_a_keyed_hash() -> None:
    guard = demo.DemoSignInGuard(1, 100, Clock())
    guard.attempt("198.51.100.7", NUMBER)
    with pytest.raises(AppError):
        guard.attempt("198.51.100.7", "(408) 555-0199")
    # The IP refused it before the number counted: that number still has its whole budget.
    other_ip = demo.DemoSignInGuard(100, 1, Clock())
    other_ip.attempt("203.0.113.9", "(408) 555-0199")
    keys = " ".join(guard._attempts)
    assert "4085550142" not in keys and "555" not in keys.replace("ip:", "")


# -------------------------------------------------------------------------- the route
def _client(settings: Settings) -> TestClient:
    from app.main import create_app

    return TestClient(create_app(settings), base_url="https://testserver",
                      raise_server_exceptions=False)


def _post(client: TestClient, origin: str | None = ORIGIN, **body: Any) -> Any:
    headers = {"Origin": origin} if origin else {}
    return client.post(ROUTE, headers=headers,
                       json={"mobileNumber": NUMBER, "birthDate": BIRTH, **body})


def test_off_the_route_is_not_there() -> None:
    client = _client(Settings(environment="test"))
    assert _post(client).status_code == 404


def test_only_from_the_portal_host() -> None:
    client = _client(_settings(environment="test"))
    for origin in (None, "https://staff.example.test", "null"):
        refused = _post(client, origin=origin)
        assert refused.status_code == 403 and refused.json()["code"] == "csrf-check-failed"


def test_a_malformed_body_is_a_validation_failure() -> None:
    client = _client(_settings(environment="test"))
    for body in ({"mobileNumber": "555"}, {"birthDate": "19-07-1984"},
                 {"mobileNumber": "4085550142", "extra": "x"}):
        response = _post(client, **body)
        assert response.status_code == 422 and response.json()["code"] == "validation-failed"


def test_a_refusal_is_the_one_422_audited_without_the_number_or_birth_date(
        monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    audited: list[str] = []

    async def no_chart(request: Any, number: str, birth: Any) -> Any:
        raise demo.refused()

    async def audit(request: Any) -> None:
        audited.append("refused")

    monkeypatch.setattr(demo, "sign_in", no_chart)
    monkeypatch.setattr(demo, "audit_refused", audit)
    client = _client(_settings(environment="test"))
    with caplog.at_level(logging.DEBUG):
        response = _post(client)
    assert response.status_code == 422 and response.json()["errors"] == [
        {"in": "body", "pointer": "/mobileNumber", "code": "not-allowed-value"}]
    assert audited == ["refused"] and portal.PORTAL_COOKIE not in response.headers.get(
        "set-cookie", "")
    logged = caplog.text
    assert "555-0142" not in logged and "4085550142" not in logged and BIRTH not in logged


def test_a_match_opens_the_session_with_its_cookie(monkeypatch: pytest.MonkeyPatch) -> None:
    now = datetime.now(UTC)
    row = portal.PortalSessionRow(uuid4(), secrets.token_urlsafe(32), uuid4(), uuid4(), uuid4(),
                                  now + timedelta(minutes=15), now + timedelta(hours=4), now)

    async def found(request: Any, number: str, birth: Any) -> portal.PortalSessionRow:
        return row

    async def name(request: Any, session: Any) -> str:
        return "Maria712"

    monkeypatch.setattr(demo, "sign_in", found)
    monkeypatch.setattr(portal, "display_name", name)
    client = _client(_settings(environment="test"))
    response = _post(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["patient"] == {"displayName": "Maria712"} and len(body["csrfToken"]) == 64
    assert set(body) == {"patient", "csrfToken", "idleExpiresAt", "expiresAt"}
    cookie = response.headers["set-cookie"]
    for attribute in (f"{portal.PORTAL_COOKIE}=", "HttpOnly", "Secure", "SameSite=strict"):
        assert attribute.lower() in cookie.lower(), attribute
    assert response.headers["cache-control"] == "no-store"


def test_the_route_is_rate_limited(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_chart(request: Any, number: str, birth: Any) -> Any:
        raise demo.refused()

    async def audit(request: Any) -> None:
        return None

    monkeypatch.setattr(demo, "sign_in", no_chart)
    monkeypatch.setattr(demo, "audit_refused", audit)
    client = _client(_settings(environment="test", portal_demo_sign_in_number_limit=2))
    assert [_post(client).status_code for _ in range(3)] == [422, 422, 429]
