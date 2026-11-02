"""Patient sign-in rules that need no database (core/portal_sign_in.py, ADR-0013): invitation
codes, the enrolment guard, the patient realm and its claims, the portal's CSRF key and
require_patient. The whole flow against PostgreSQL is in test_portal_sign_in_postgres.py.
Secrets are made at run time; synthetic values only."""

import re
import secrets
import time
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core import portal_sign_in as portal
from app.core import session as sessions
from app.core.config import Settings
from app.core.deps import PATIENT_ROLE, PortalPatient, require_patient
from app.core.errors import AppError, Forbidden, ValidationFailed
from app.core.permissions import PATIENT_PERMISSIONS

PUBLIC = "https://portal.example.test/kc"
ORIGIN = "https://portal.example.test"
CONTRACT_CODE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$")


def _secret() -> SecretStr:
    return SecretStr(secrets.token_hex(32))


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "environment": "test", "keycloak_public_url": PUBLIC,
        "keycloak_internal_url": "http://keycloak.test:8080/kc",
        "portal_client_secret": _secret(), "portal_admin_client_secret": _secret(),
        "portal_redirect_uri": f"{ORIGIN}/api/v1/portal/auth/callback",
        "portal_session_secret": _secret(), "portal_invitation_secret": _secret(),
        "portal_origin": ORIGIN, "public_form_secret": _secret()}  # the portal host's forms
    values.update(overrides)
    return Settings(**values)


# ----------------------------------------------------------------------------- codes
def test_a_new_code_is_60_bits_of_crockford_base32_in_the_contracts_shape() -> None:
    codes = {portal.new_code() for _ in range(200)}
    assert len(codes) == 200 and all(CONTRACT_CODE.fullmatch(c) for c in codes)


@pytest.mark.parametrize(("typed", "stored"), [
    ("K7Q2-9MZD-4TXH", "K7Q29MZD4TXH"),
    ("k7q2 9mzd 4txh".replace(" ", ""), "K7Q29MZD4TXH"),
    ("K7Q2-9MZD-4TXI", "K7Q29MZD4TX1"),  # I and L read as 1, O as 0 (Crockford)
    ("K7Q2-9MZD-4TXL", "K7Q29MZD4TX1"),
    ("K7Q2-9MZD-4TXO", "K7Q29MZD4TX0"),
])
def test_codes_are_normalized_as_the_contract_says(typed: str, stored: str) -> None:
    assert portal.normalize_code(typed) == stored


@pytest.mark.parametrize("typed", ["", "K7Q2-9MZD", "K7Q2-9MZD-4TXH-1", "K7Q2-9MZD-4TXU",
                                   "K7Q2-9MZD-4TX!", "K7Q2-9MZD-4TXHH"])
def test_anything_else_is_no_code(typed: str) -> None:
    assert portal.normalize_code(typed) is None


def test_the_codes_hmac_is_keyed() -> None:
    key_a, key_b = secrets.token_bytes(32), secrets.token_bytes(32)
    code = portal.normalize_code(portal.new_code()) or ""
    assert portal.code_hmac(key_a, code) != portal.code_hmac(key_b, code)
    assert re.fullmatch(r"[0-9a-f]{64}", portal.code_hmac(key_a, code))


def test_every_refusal_is_the_same_answer() -> None:
    refused = portal.code_refused()
    assert refused.status == 422 and refused.code == "business-rule-violation"
    assert refused.extensions["errors"] == [{"in": "body", "pointer": "/invitationCode",
                                             "code": "not-allowed-value"}]


# ------------------------------------------------------------------------ the guard
class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_enrolment_attempts_are_limited_per_ip_for_ten_minutes() -> None:
    clock = Clock()
    guard = portal.EnrollmentGuard(2, clock)
    guard.attempt("198.51.100.7")
    guard.attempt("198.51.100.7")
    guard.attempt("203.0.113.9")  # another IP has its own budget
    with pytest.raises(AppError) as limited:
        guard.attempt("198.51.100.7")
    assert limited.value.status == 429 and int((limited.value.headers or {})["Retry-After"]) > 0
    clock.now += portal.ENROLLMENT_WINDOW_SECONDS
    guard.attempt("198.51.100.7")


def test_a_finished_enrolment_replays_for_its_key_and_body_only() -> None:
    guard = portal.EnrollmentGuard(10, Clock())
    assert guard.replayed("key-1", "a" * 64) is False
    guard.finished("key-1", "a" * 64)
    assert guard.replayed("key-1", "a" * 64) is True
    assert guard.replayed(None, "a" * 64) is False
    with pytest.raises(ValidationFailed) as reused:
        guard.replayed("key-1", "b" * 64)
    assert reused.value.code == "idempotency-key-reused"


# ------------------------------------------------------------------------- the realm
def test_the_login_goes_to_the_patient_realm_with_pkce_and_always_asks_for_credentials() -> None:
    keycloak = portal.PortalKeycloak(_settings())
    _, state = sessions.LoginStates().new()
    url = urlparse(keycloak.login_redirect(state))
    query = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert url.path == "/kc/realms/shri-patients/protocol/openid-connect/auth"
    assert query["client_id"] == "shri-portal-web" and query["prompt"] == "login"
    assert query["code_challenge_method"] == "S256"
    assert query["redirect_uri"] == f"{ORIGIN}/api/v1/portal/auth/callback"
    assert "login_hint" not in query  # never an email in a URL (ADR-0013 §1, D13)


def _claims(**changes: Any) -> dict[str, Any]:
    now = int(time.time())
    claims = {"iss": f"{PUBLIC}/realms/shri-patients", "aud": "shri-portal-web",
              "exp": now + 300, "iat": now, "nonce": "n-1", "sub": "kc-patient-1"}
    claims.update(changes)
    return claims


def test_a_patient_realm_token_passes() -> None:
    portal.PortalKeycloak(_settings()).check_id_claims(_claims(), "n-1")


@pytest.mark.parametrize("changes", [
    {"iss": f"{PUBLIC}/realms/shri-staff"},  # a staff sign-in never opens the portal
    {"aud": "shri-web"},
    {"nonce": "n-2"},
])
def test_a_staff_token_or_another_login_is_refused(changes: dict[str, Any]) -> None:
    with pytest.raises(ValidationFailed):
        portal.PortalKeycloak(_settings()).check_id_claims(_claims(**changes), "n-1")


def test_half_configured_patient_sign_in_stops_startup_naming_what_to_set() -> None:
    with pytest.raises(ValueError, match="not configured: set PORTAL_REDIRECT_URI$"):
        portal.PortalKeycloak(_settings(portal_redirect_uri=None))
    from fastapi import FastAPI

    with pytest.raises(ValueError, match="PORTAL_SESSION_SECRET"):
        portal.register(FastAPI(), _settings(portal_session_secret=SecretStr("short")))
    with pytest.raises(ValueError, match="PORTAL_INVITATION_SECRET"):
        portal.register(FastAPI(), _settings(portal_invitation_secret=None))


# ------------------------------------------------------------------------------ CSRF
def _request(method: str, headers: dict[str, str]) -> Any:
    from starlette.requests import Request

    return Request({"type": "http", "method": method, "path": "/x", "query_string": b"",
                    "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]})


def test_portal_csrf_needs_the_portal_origin_and_the_sessions_token() -> None:
    settings = _settings()
    good = portal.csrf_token(settings, "portal-token-a")
    portal.check_csrf(_request("GET", {}), settings, "portal-token-a")
    portal.check_csrf(_request("POST", {"Origin": ORIGIN, "X-CSRF-Token": good}), settings,
                      "portal-token-a")
    for headers in ({}, {"X-CSRF-Token": good}, {"Origin": ORIGIN},
                    {"Origin": "https://staff.example.test", "X-CSRF-Token": good},
                    {"Origin": ORIGIN, "X-CSRF-Token": portal.csrf_token(settings, "other")}):
        with pytest.raises(Forbidden) as refused:
            portal.check_csrf(_request("POST", headers), settings, "portal-token-a")
        assert refused.value.code == "csrf-check-failed"


def test_the_portal_csrf_key_is_not_the_staff_one() -> None:
    shared = secrets.token_hex(32)
    settings = _settings(portal_session_secret=SecretStr(shared),
                         session_secret=SecretStr(shared))
    assert portal.csrf_token(settings, "t") != sessions.csrf_token(settings, "t")


# --------------------------------------------------------------- require_patient (PAT)
def test_pat_holds_only_the_eight_portal_permissions() -> None:
    assert PATIENT_PERMISSIONS == {
        "portal-profile:read", "portal-profile:request-change", "portal-appointments:read",
        "portal-appointments:create", "portal-appointments:cancel",
        "portal-appointments:reschedule", "portal-booking:read", "portal-records:read"}


@pytest.mark.parametrize("permission", ["patients:read", "portal-accounts:read", "no:such"])
def test_a_staff_or_unknown_permission_on_a_portal_route_fails_at_import(permission: str) -> None:
    with pytest.raises(ValueError):
        require_patient(permission)


async def test_a_patient_session_without_the_pat_role_is_refused() -> None:
    check = require_patient("portal-records:read")
    me = PortalPatient(patient_id=uuid4(), organization_id=uuid4())
    assert await check(patient=me) == me
    with pytest.raises(Forbidden):
        await check(patient=PortalPatient(patient_id=uuid4(), organization_id=uuid4(),
                                          roles=frozenset({"FD"})))
    assert PATIENT_ROLE in me.roles


# ------------------------------------------------------------- unconfigured routes
def test_unconfigured_patient_sign_in_answers_503() -> None:
    from app.main import create_app

    client = TestClient(create_app(Settings(environment="test")), base_url="https://testserver")
    assert client.get("/api/v1/portal/auth/login", follow_redirects=False).status_code == 503
    enrol = client.post("/api/v1/portal/enrollments", headers={"Origin": ORIGIN}, json={
        "invitationCode": "K7Q2-9MZD-4TXH", "birthDate": "1984-03-09",
        "email": "synthetic@example.com"})
    assert enrol.status_code == 503  # no portal origin set: never an open form
