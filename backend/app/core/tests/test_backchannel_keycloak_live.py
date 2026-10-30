"""D101 against a real Keycloak: a staff member signs in through our API (password and one-time
code); an admin then disables them and signs out their sessions in Keycloak; Keycloak calls our
back-channel logout endpoint, and our session ends at once, not at the next token refresh.

Runs only with a test Keycloak and the database (skipped otherwise):
    STAFF_KEYCLOAK_TEST_URL       e.g. http://kc-bcl:8080/kc, reachable from the tests
    STAFF_KEYCLOAK_CLIENT_SECRET  the realm's SHRI_WEB_CLIENT_SECRET
    STAFF_KEYCLOAK_ADMIN_PASSWORD the master realm's admin password (user "admin")
    BACKCHANNEL_LISTEN_PORT       the port this test serves the hook on; the realm's
                                  SHRI_WEB_BACKCHANNEL_URL points at it
The realm's SHRI_WEB_REDIRECT_URI must be https://testserver/api/v1/auth/callback.
admin.lookup_staff_user() (#139) isn't on main yet, so the one staff lookup is stood in for, as in
test_session_postgres.py. Synthetic data only; secrets made at run time.
"""

import base64
import hashlib
import hmac
import html
import os
import re
import secrets
import struct
import threading
import time
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse
from uuid import UUID, uuid4

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core import session as sessions
from app.core.config import Settings
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

KC = os.environ.get("STAFF_KEYCLOAK_TEST_URL")
SECRET = os.environ.get("STAFF_KEYCLOAK_CLIENT_SECRET")
ADMIN_PASSWORD = os.environ.get("STAFF_KEYCLOAK_ADMIN_PASSWORD")
PORT = int(os.environ.get("BACKCHANNEL_LISTEN_PORT", "0"))
ORIGIN = "https://testserver"

pytestmark = [
    pytest.mark.db, SKIP_WITHOUT_DATABASE,
    pytest.mark.skipif(not (KC and SECRET and ADMIN_PASSWORD and PORT),
                       reason="STAFF_KEYCLOAK_TEST_URL and its settings not set"),
]


def totp(secret_b32: str) -> str:
    key = base64.b32decode(secret_b32.replace(" ", "").upper() + "=" * (-len(secret_b32) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(time.time() // 30)), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return f"{(struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def _form(page: httpx.Response) -> tuple[str, dict[str, str]]:
    action = re.search(r'<form[^>]*action="([^"]+)"', page.text)
    assert action, page.text[:500]
    fields = dict(re.findall(r'<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"',
                             page.text))
    return urljoin(str(page.url), html.unescape(action.group(1))), fields


def _settings() -> Settings:
    return Settings(
        environment="test", auth_mode="keycloak", database_url=TEST_DATABASE_URL,
        keycloak_public_url=KC, keycloak_internal_url=KC,
        keycloak_client_secret=SecretStr(SECRET or ""),
        keycloak_redirect_uri=f"{ORIGIN}/api/v1/auth/callback",
        session_secret=SecretStr(secrets.token_hex(32)), allowed_origins=[ORIGIN],
        openbao_transit_addr=os.environ.get("OPENBAO_TRANSIT_ADDR"),
        openbao_transit_token=SecretStr(os.environ.get("OPENBAO_TRANSIT_TOKEN", "")))


@pytest.fixture
def staff(db: Session, tenant: UUID) -> dict[str, Any]:  # noqa: F811
    user = b.practitioner(db, "Rivera", "Elena")["user"]
    db.commit()
    return {"tenant": tenant, "user": user.id}


def test_disabling_a_staff_user_in_keycloak_ends_our_session_at_once(
        staff: dict[str, Any], admin_engine: Engine,  # noqa: F811
        monkeypatch: pytest.MonkeyPatch) -> None:
    admin_token = httpx.post(f"{KC}/realms/master/protocol/openid-connect/token", data={
        "grant_type": "password", "client_id": "admin-cli", "username": "admin",
        "password": ADMIN_PASSWORD}, timeout=10).json()["access_token"]
    admin = httpx.Client(base_url=f"{KC}/admin/realms/shri-staff", timeout=10,
                         headers={"Authorization": f"Bearer {admin_token}"})
    username, password = f"synthetic.{uuid4().hex[:8]}", secrets.token_urlsafe(18)
    assert admin.post("/users", json={
        "username": username, "email": f"{username}@example.com", "emailVerified": True,
        "enabled": True, "firstName": "Elena", "lastName": "Rivera",
        "requiredActions": ["CONFIGURE_TOTP"],
        "credentials": [{"type": "password", "value": password,
                         "temporary": False}]}).status_code == 201
    (kc_user,) = admin.get("/users", params={"username": username, "exact": "true"}).json()
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.app_user SET keycloak_subject = :s WHERE id = :u"),
                  {"s": kc_user["id"], "u": staff["user"]})

    async def stand_in(_db: Any, subject: str) -> tuple[UUID, UUID]:
        assert subject == kc_user["id"]
        return staff["user"], staff["tenant"]

    monkeypatch.setattr(sessions, "find_staff_user", stand_in)

    # The receiver: a second app under a real uvicorn, which Keycloak calls over the network.
    receiver = create_app(_settings())
    switch_to_role(receiver.state.db.engine.sync_engine, "shri_app")
    server = uvicorn.Server(uvicorn.Config(receiver, host="0.0.0.0", port=PORT,  # noqa: S104
                                           log_config=None, lifespan="off"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)

    app = create_app(_settings())
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    try:
        with TestClient(app, base_url=ORIGIN, raise_server_exceptions=False) as client:
            browser = httpx.Client(follow_redirects=False, timeout=10)

            def go(url: str, data: dict[str, str] | None = None) -> httpx.Response:
                r = browser.post(url, data=data) if data is not None else browser.get(url)
                while r.is_redirect:
                    target = urljoin(str(r.url), r.headers["location"])
                    if target.startswith(ORIGIN):
                        return r
                    r = browser.get(target)
                return r

            login = client.get("/api/v1/auth/login", follow_redirects=False)
            page = go(login.headers["location"])
            action, hidden = _form(page)
            page = go(action, {**hidden, "username": username, "password": password})
            manual = go(str(page.url) + ("&" if "?" in str(page.url) else "?") + "mode=manual")
            key = re.search(r'id="kc-totp-secret-key"[^>]*>\s*([A-Z2-7 ]+)\s*<', manual.text)
            assert key, manual.text[:800]
            action, hidden = _form(manual)
            back = go(action, {**hidden, "totp": totp(key.group(1)),
                               "userLabel": "synthetic phone"})
            query = {k: v[0] for k, v in parse_qs(urlparse(back.headers["location"]).query).items()}
            done = client.get(f"/api/v1/auth/callback?code={query['code']}"
                              f"&state={query['state']}", follow_redirects=False)
            assert done.status_code == 302, done.text
            assert client.get("/api/v1/auth/session").status_code == 200

            # D101: the admin disables the user and signs out their sessions in Keycloak.
            assert admin.put(f"/users/{kc_user['id']}", json={"enabled": False}).status_code == 204
            assert admin.post(f"/users/{kc_user['id']}/logout").status_code == 204

            for _ in range(50):  # at once: well before any 5-minute refresh
                ended = client.get("/api/v1/auth/session")
                if ended.status_code == 401:
                    break
                time.sleep(0.1)
            assert ended.status_code == 401 and ended.json()["code"] == "session-expired"
            with admin_engine.connect() as c:
                row = c.execute(text(
                    "SELECT a.actor_type, a.reason FROM audit.audit_event a JOIN "
                    "admin.app_session s ON a.entity_id = s.id::text WHERE s.user_id = :u "
                    "AND a.actor_type = 'partner'"), {"u": staff["user"]}).one()
            assert tuple(row) == ("partner", "keycloak-backchannel-logout")
    finally:
        server.should_exit = True
        thread.join(5)
        admin.delete(f"/users/{kc_user['id']}")
