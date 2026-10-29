"""Staff sign-in end to end against the real schema, as shri_app: login, callback, the session,
CSRF, refresh, the 5-minute backstop (D94) and logout. Keycloak and Transit are fakes
(httpx.MockTransport); the database is real. Needs TEST_DATABASE_URL; skipped otherwise.

admin.lookup_staff_user() (Anand) isn't in the schema yet: one test checks that sign-in fails
closed without it, and the others stand in for that one lookup only. Synthetic data only."""

import base64
import json
import secrets
import time
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core import session as sessions
from app.core.config import Settings
from app.core.crypto import FieldCrypto
from app.db.tests import builders as b
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    app_engine,
    db,
    switch_to_role,
    tenant,
)
from app.main import create_app

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

PUBLIC = "https://portal.example.test/kc"
ISSUER = f"{PUBLIC}/realms/shri-staff"
ORIGIN = "https://portal.example.test"


class FakeKeycloak:
    """The token and logout endpoints. `refuse_refresh`: the user was disabled in Keycloak."""

    def __init__(self, subject: str) -> None:
        self.subject = subject
        self.nonce = ""
        self.refuse_refresh = False
        self.calls: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        self.calls.append(form.get("grant_type", request.url.path.rsplit("/", 1)[-1]))
        if request.url.path.endswith("/logout"):
            return httpx.Response(204)
        if form.get("grant_type") == "refresh_token" and self.refuse_refresh:
            return httpx.Response(400, json={"error": "invalid_grant"})
        now = int(time.time())
        claims = {"iss": ISSUER, "aud": "shri-web", "exp": now + 300, "iat": now,
                  "nonce": self.nonce, "sub": self.subject, "sid": "kc-session-1"}
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        return httpx.Response(200, json={"access_token": f"access-{secrets.token_hex(4)}",
                                         "refresh_token": f"refresh-{secrets.token_hex(4)}",
                                         "id_token": f"e30.{payload}.c2ln"})


def _fake_transit(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    if request.url.path.endswith("/encrypt/shri-fields"):
        return httpx.Response(200, json={"data": {"ciphertext": f"vault:v1:{body['plaintext']}"}})
    return httpx.Response(200, json={"data": {
        "plaintext": body["ciphertext"].removeprefix("vault:v1:")}})


@pytest.fixture
def staff(db: Session, tenant: UUID, admin_engine: Engine) -> dict[str, Any]:  # noqa: F811
    user = b.practitioner(db, "Rivera", "Elena")["user"]
    db.commit()
    role_id, subject = uuid4(), f"kc-{uuid4()}"  # Keycloak subjects are unique across users
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.app_user SET keycloak_subject = :s WHERE id = :u"),
                  {"s": subject, "u": user.id})
        c.execute(text("INSERT INTO admin.role (id, tenant_id, code, name) "
                       "VALUES (:i, :t, 'FD', 'Front desk')"), {"i": role_id, "t": tenant})
        c.execute(text("INSERT INTO admin.user_role (id, tenant_id, user_id, role_id) "
                       "VALUES (:i, :t, :u, :r)"),
                  {"i": uuid4(), "t": tenant, "u": user.id, "r": role_id})
    return {"tenant": tenant, "user": user.id, "subject": subject}


@pytest.fixture
def keycloak(staff: dict[str, Any]) -> FakeKeycloak:
    return FakeKeycloak(staff["subject"])


@pytest.fixture
def client(staff: dict[str, Any], keycloak: FakeKeycloak,
           monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    settings = Settings(
        environment="test", auth_mode="keycloak", database_url=TEST_DATABASE_URL,
        keycloak_public_url=PUBLIC, keycloak_internal_url="http://keycloak.test:8080/kc",
        keycloak_client_secret=SecretStr(secrets.token_hex(16)),
        keycloak_redirect_uri=f"{ORIGIN}/api/v1/auth/callback",
        session_secret=SecretStr(secrets.token_hex(32)), allowed_origins=[ORIGIN],
        openbao_transit_addr="http://bao.test:8200",
        openbao_transit_token=SecretStr(secrets.token_hex(8)))
    app = create_app(settings)
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    app.state.keycloak = sessions.Keycloak(settings, transport=httpx.MockTransport(keycloak))
    app.state.crypto = FieldCrypto(settings, transport=httpx.MockTransport(_fake_transit))

    async def stand_in(_db: Any, subject: str) -> tuple[UUID, UUID]:
        assert subject == staff["subject"]
        return staff["user"], staff["tenant"]

    monkeypatch.setattr(sessions, "find_staff_user", stand_in)
    with TestClient(app, base_url="https://testserver", raise_server_exceptions=False) as c:
        yield c


def _sign_in(client: TestClient, keycloak: FakeKeycloak) -> httpx.Response:
    login = client.get("/api/v1/auth/login", follow_redirects=False)
    query = {k: v[0] for k, v in parse_qs(urlparse(login.headers["location"]).query).items()}
    keycloak.nonce = query["nonce"]
    callback: httpx.Response = client.get(
        f"/api/v1/auth/callback?code=c-1&state={query['state']}", follow_redirects=False)
    return callback


def _session_row(admin: Engine, tenant_id: UUID) -> Any:
    with admin.connect() as c:
        return c.execute(text(
            "SELECT id, token_hash, keycloak_access_token_enc, keycloak_refresh_token_enc, "
            "keycloak_sid, revoked_at, idle_expires_at, expires_at FROM admin.app_session "
            "WHERE tenant_id = :t ORDER BY created_at DESC LIMIT 1"), {"t": tenant_id}).one()


def _actions(admin: Engine, tenant_id: UUID) -> list[str]:
    with admin.connect() as c:
        return list(c.execute(text("SELECT action FROM audit.audit_event WHERE tenant_id = :t "
                                   "AND category = 'security' ORDER BY id"),
                              {"t": tenant_id}).scalars())


def _csrf(client: TestClient) -> dict[str, str]:
    token = client.get("/api/v1/auth/session").json()["csrfToken"]
    return {"Origin": ORIGIN, "X-CSRF-Token": token}


def test_sign_in_creates_a_hashed_session_with_encrypted_tokens(
        client: TestClient, keycloak: FakeKeycloak, staff: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    callback = _sign_in(client, keycloak)
    assert callback.status_code == 302 and callback.headers["location"] == "/"
    cookies = callback.headers.get_list("set-cookie")
    session_cookie = next(c for c in cookies if c.startswith(f"{sessions.SESSION_COOKIE}="))
    for attribute in ("HttpOnly", "Secure", "SameSite=strict", "Path=/"):
        assert attribute.lower() in session_cookie.lower(), attribute
    assert any(c.startswith(f"{sessions.LOGIN_COOKIE}=") and "Max-Age=0" in c for c in cookies)
    token = client.cookies[sessions.SESSION_COOKIE]
    row = _session_row(admin_engine, staff["tenant"])
    assert row.token_hash == sessions.token_hash(token) and token not in row.token_hash
    assert row.keycloak_access_token_enc.startswith("vault:v1:")
    assert row.keycloak_refresh_token_enc.startswith("vault:v1:")
    assert row.keycloak_sid == "kc-session-1"
    assert (row.expires_at - row.idle_expires_at).total_seconds() > 11 * 3600
    assert _actions(admin_engine, staff["tenant"]) == ["login"]


def test_the_session_tells_the_screen_who_and_until_when_without_moving_the_timer(
        client: TestClient, keycloak: FakeKeycloak, staff: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    _sign_in(client, keycloak)
    before = _session_row(admin_engine, staff["tenant"]).idle_expires_at
    body = client.get("/api/v1/auth/session").json()
    assert body["user"]["id"] == str(staff["user"]) and body["user"]["roles"] == ["FD"]
    assert body["organization"]["id"] == str(staff["tenant"])
    assert len(body["csrfToken"]) == 64 and body["build"]["commit"]
    assert _session_row(admin_engine, staff["tenant"]).idle_expires_at == before


def test_a_new_login_never_reuses_a_session(client: TestClient,
                                            keycloak: FakeKeycloak) -> None:
    _sign_in(client, keycloak)
    first = client.cookies[sessions.SESSION_COOKIE]
    _sign_in(client, keycloak)
    assert client.cookies[sessions.SESSION_COOKIE] != first


@pytest.mark.parametrize("headers", [{}, {"Origin": ORIGIN},
                                     {"Origin": "https://evil.example.test"}])
def test_refresh_without_the_csrf_token_or_from_elsewhere_is_403(
        client: TestClient, keycloak: FakeKeycloak, headers: dict[str, str]) -> None:
    _sign_in(client, keycloak)
    refused = client.post("/api/v1/auth/refresh", headers=headers)
    assert refused.status_code == 403 and refused.json()["code"] == "csrf-check-failed"


def test_refresh_extends_the_idle_timer_but_never_the_absolute_limit(
        client: TestClient, keycloak: FakeKeycloak, staff: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    _sign_in(client, keycloak)
    headers = _csrf(client)
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.app_session SET idle_expires_at = now() + interval "
                       "'1 minute' WHERE tenant_id = :t"), {"t": staff["tenant"]})
    before = _session_row(admin_engine, staff["tenant"])
    response = client.post("/api/v1/auth/refresh", headers=headers)
    assert response.status_code == 200
    after = _session_row(admin_engine, staff["tenant"])
    assert after.idle_expires_at > before.idle_expires_at
    assert after.expires_at == before.expires_at
    assert _actions(admin_engine, staff["tenant"]) == ["login", "update"]


def test_a_user_disabled_in_keycloak_loses_the_session_at_the_next_refresh(
        client: TestClient, keycloak: FakeKeycloak, staff: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    _sign_in(client, keycloak)
    headers = _csrf(client)
    with admin_engine.begin() as c:  # the stored tokens are more than 5 minutes old
        c.execute(text("UPDATE admin.app_session SET tokens_refreshed_at = now() - interval "
                       "'6 minutes' WHERE tenant_id = :t"), {"t": staff["tenant"]})
    keycloak.refuse_refresh = True
    ended = client.post("/api/v1/auth/refresh", headers=headers)
    assert ended.status_code == 401 and ended.json()["code"] == "session-expired"
    assert _session_row(admin_engine, staff["tenant"]).revoked_at is not None
    assert client.get("/api/v1/auth/session").status_code == 401
    assert _actions(admin_engine, staff["tenant"])[-1] == "logout"


def test_a_stale_token_is_refreshed_when_keycloak_agrees(
        client: TestClient, keycloak: FakeKeycloak, staff: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    _sign_in(client, keycloak)
    headers = _csrf(client)
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.app_session SET tokens_refreshed_at = now() - interval "
                       "'6 minutes' WHERE tenant_id = :t"), {"t": staff["tenant"]})
    before = _session_row(admin_engine, staff["tenant"]).keycloak_refresh_token_enc
    assert client.post("/api/v1/auth/refresh", headers=headers).status_code == 200
    assert "refresh_token" in keycloak.calls
    assert _session_row(admin_engine, staff["tenant"]).keycloak_refresh_token_enc != before


def test_logout_ends_ours_and_keycloaks_and_clears_the_cookie(
        client: TestClient, keycloak: FakeKeycloak, staff: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    _sign_in(client, keycloak)
    token = client.cookies[sessions.SESSION_COOKIE]
    response = client.post("/api/v1/auth/logout", headers=_csrf(client))
    assert response.status_code == 204
    assert any(c.startswith(f"{sessions.SESSION_COOKIE}=") and "Max-Age=0" in c
               for c in response.headers.get_list("set-cookie"))
    assert "logout" in keycloak.calls
    assert _session_row(admin_engine, staff["tenant"]).revoked_at is not None
    client.cookies.clear()
    replay = client.get("/api/v1/auth/session",  # the old cookie, replayed
                        headers={"Cookie": f"{sessions.SESSION_COOKIE}={token}"})
    assert replay.status_code == 401 and replay.json()["code"] == "session-expired"
    assert _actions(admin_engine, staff["tenant"]) == ["login", "logout"]


def test_an_idle_session_is_over(client: TestClient, keycloak: FakeKeycloak,
                                 staff: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _sign_in(client, keycloak)
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.app_session SET idle_expires_at = now() - interval "
                       "'1 second' WHERE tenant_id = :t"), {"t": staff["tenant"]})
    assert client.get("/api/v1/auth/session").status_code == 401


def test_a_deactivated_account_is_refused(client: TestClient, keycloak: FakeKeycloak,
                                          staff: dict[str, Any],
                                          admin_engine: Engine) -> None:  # noqa: F811
    _sign_in(client, keycloak)
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.app_user SET is_active = false WHERE id = :u"),
                  {"u": staff["user"]})
    assert client.get("/api/v1/auth/session").status_code == 403


def test_without_anands_lookup_sign_in_fails_closed(
        client: TestClient, keycloak: FakeKeycloak, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.undo()  # the real find_staff_user: admin.lookup_staff_user() doesn't exist yet
    callback = _sign_in(client, keycloak)
    assert callback.status_code == 503
    assert sessions.SESSION_COOKIE not in client.cookies
