"""Patient sign-in against a real Keycloak with the shri-patients realm (ADR-0013 §2-§3):
enrolment through our API creates the realm user; the realm's own pages then make the patient set
up the one-time code; a later sign-in refuses a wrong code and accepts the right one; only then
does our callback open a portal session.

Runs only with a test Keycloak and the database (skipped otherwise):
    PORTAL_KEYCLOAK_TEST_URL         e.g. http://kc-check:8080/kc (reachable from the tests)
    PORTAL_KEYCLOAK_CLIENT_SECRET    the realm's SHRI_PORTAL_CLIENT_SECRET
    PORTAL_KEYCLOAK_ADMIN_SECRET     the realm's SHRI_PORTAL_ADMIN_CLIENT_SECRET
The realm's redirect URI (SHRI_PORTAL_REDIRECT_URI) must be
https://testserver/api/v1/portal/auth/callback. The one-time codes are computed here with the
standard library (RFC 6238); synthetic data only.
"""

import base64
import hashlib
import hmac
import html
import os
import re
import secrets
import struct
import time
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy.orm import Session

from app.core import portal_sign_in as portal
from app.core.config import Settings
from app.core.db import Database
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

KC = os.environ.get("PORTAL_KEYCLOAK_TEST_URL")
WEB_SECRET = os.environ.get("PORTAL_KEYCLOAK_CLIENT_SECRET")
ADMIN_SECRET = os.environ.get("PORTAL_KEYCLOAK_ADMIN_SECRET")
ORIGIN = "https://testserver"

pytestmark = [
    pytest.mark.db, SKIP_WITHOUT_DATABASE,
    pytest.mark.skipif(not (KC and WEB_SECRET and ADMIN_SECRET),
                       reason="PORTAL_KEYCLOAK_TEST_URL and its secrets not set"),
]


def totp(secret_b32: str, at: float | None = None, step: int = 30) -> str:
    """RFC 6238 with HMAC-SHA1 and 6 digits, the realm's otpPolicy."""
    key = base64.b32decode(secret_b32.replace(" ", "").upper() + "=" * (-len(secret_b32) % 8))
    counter = int((time.time() if at is None else at) // step)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def test_totp_matches_rfc_6238_appendix_b() -> None:
    secret = base64.b32encode(b"12345678901234567890").decode()
    assert totp(secret, at=59, step=30) == "287082"  # the RFC's SHA-1 vector, last 6 digits


def _form(page: httpx.Response) -> tuple[str, dict[str, str]]:
    """The realm page's form: its action URL and hidden fields."""
    action = re.search(r'<form[^>]*action="([^"]+)"', page.text)
    assert action, page.text[:500]
    fields = dict(re.findall(r'<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"',
                             page.text))
    return urljoin(str(page.url), html.unescape(action.group(1))), fields


def _settings() -> Settings:
    def secret() -> SecretStr:
        return SecretStr(secrets.token_hex(32))

    return Settings(
        environment="test", auth_mode="dev_header", database_url=TEST_DATABASE_URL,
        portal_database_url=TEST_DATABASE_URL, keycloak_public_url=KC, keycloak_internal_url=KC,
        keycloak_client_secret=secret(), session_secret=secret(),
        keycloak_redirect_uri=f"{ORIGIN}/api/v1/auth/callback",
        portal_client_secret=SecretStr(WEB_SECRET or ""),
        portal_admin_client_secret=SecretStr(ADMIN_SECRET or ""),
        portal_redirect_uri=f"{ORIGIN}/api/v1/portal/auth/callback",
        portal_session_secret=secret(), portal_invitation_secret=secret(),
        portal_origin=ORIGIN, public_form_secret=secret(),
        openbao_transit_addr=os.environ.get("OPENBAO_TRANSIT_ADDR"),
        openbao_transit_token=SecretStr(os.environ.get("OPENBAO_TRANSIT_TOKEN", "")))


class Browser:
    """The patient's browser on the realm's pages: follows redirects inside the realm, stops at
    the redirect back to our callback."""

    def __init__(self) -> None:
        self.http = httpx.Client(follow_redirects=False, timeout=10)

    def go(self, url: str, data: dict[str, str] | None = None) -> httpx.Response:
        response = self.http.post(url, data=data) if data is not None else self.http.get(url)
        while response.is_redirect:
            target = urljoin(str(response.url), response.headers["location"])
            if target.startswith(ORIGIN):
                return response
            response = self.http.get(target)
        return response


def _callback_query(response: httpx.Response) -> dict[str, str]:
    assert response.is_redirect, response.text[:800]
    location = response.headers["location"]
    assert location.startswith(f"{ORIGIN}/api/v1/portal/auth/callback")
    return {k: v[0] for k, v in parse_qs(urlparse(location).query).items()}


def _sign_in_with_our_api(client: TestClient, browser: Browser, email: str, password: str,
                          code_for: Any) -> httpx.Response:
    """From our /portal/auth/login through the realm's pages back to our callback."""
    login = client.get("/api/v1/portal/auth/login", follow_redirects=False)
    page = browser.go(login.headers["location"])
    action, hidden = _form(page)
    page = browser.go(action, {**hidden, "username": email, "password": password})
    return code_for(page)


@pytest.fixture
def chart(db: Session, tenant: Any) -> dict[str, Any]:  # noqa: F811
    b.practice(db)
    me = b.patient(db, "Nguyen", "Mai")
    staff = b.practitioner(db, "Rivera", "Elena")["user"]
    db.commit()
    return {"tenant": tenant, "patient": me.id, "birth": me.birth_date, "staff": staff.id}


async def test_a_patient_sets_up_the_code_then_a_wrong_code_is_refused(
        chart: dict[str, Any]) -> None:
    settings = _settings()
    staff_db = Database(settings)
    switch_to_role(staff_db.engine.sync_engine, "shri_app")
    async with staff_db.tenant_session(chart["tenant"], chart["staff"]) as s:
        code = (await portal.issue_invitation(s, settings, chart["patient"], chart["staff"])).code
        await s.commit()
    await staff_db.dispose()

    app = create_app(settings)
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    switch_to_role(app.state.portal_db.engine.sync_engine, "shri_portal")
    email = f"synthetic-{uuid4().hex[:10]}@example.com"
    password = secrets.token_urlsafe(18)  # made at run time, never logged
    with TestClient(app, base_url=ORIGIN, raise_server_exceptions=False) as client:
        # Enrolment through our API: the realm user exists, with its required actions.
        assert client.post("/api/v1/portal/enrollments", headers={"Origin": ORIGIN}, json={
            "invitationCode": code, "birthDate": chart["birth"].isoformat(),
            "email": email}).status_code == 204

        # The set-up email would do this; the test has no mailbox, so the service account sets
        # the password and the verified email, and leaves the one-time code to the patient.
        accounts: portal.PatientAccounts = app.state.patient_accounts
        token = await accounts._access_token()  # noqa: SLF001
        admin = httpx.Client(base_url=f"{KC}/admin/realms/shri-patients",
                             headers={"Authorization": f"Bearer {token}"}, timeout=10)
        (user,) = admin.get("/users", params={"email": email, "exact": "true"}).json()
        assert set(user["requiredActions"]) == {"VERIFY_EMAIL", "UPDATE_PASSWORD",
                                                "CONFIGURE_TOTP"}
        assert admin.put(f"/users/{user['id']}/reset-password", json={
            "type": "password", "value": password, "temporary": False}).status_code == 204
        assert admin.put(f"/users/{user['id']}", json={
            "emailVerified": True, "requiredActions": ["CONFIGURE_TOTP"]}).status_code == 204

        browser = Browser()
        secret_key: dict[str, str] = {}

        def set_up_code(page: httpx.Response) -> httpx.Response:
            assert "totp" in page.text.lower(), "the realm must ask for the one-time code set-up"
            manual = browser.go(str(page.url) + ("&" if "?" in str(page.url) else "?") +
                                "mode=manual")
            found = re.search(r'id="kc-totp-secret-key"[^>]*>\s*([A-Z2-7 ]+)\s*<', manual.text)
            assert found, manual.text[:800]
            secret_key["value"] = found.group(1).replace(" ", "")
            action, hidden = _form(manual)
            return browser.go(action, {**hidden, "totp": totp(secret_key["value"]),
                                       "userLabel": "synthetic phone"})

        first = _callback_query(_sign_in_with_our_api(client, browser, email, password,
                                                      set_up_code))
        done = client.get(f"/api/v1/portal/auth/callback?code={first['code']}"
                          f"&state={first['state']}", follow_redirects=False)
        assert done.status_code == 302 and portal.PORTAL_COOKIE in client.cookies
        csrf = client.get("/api/v1/portal/auth/session").json()["csrfToken"]
        assert client.post("/api/v1/portal/auth/logout", headers={
            "Origin": ORIGIN, "X-CSRF-Token": csrf}).status_code == 204

        # A new sign-in: the password alone is not enough, and a wrong code is refused. The
        # realm never accepts the same code twice, so wait for the next 30-second period.
        time.sleep(30 - time.time() % 30 + 1)
        browser = Browser()

        def wrong_then_right(page: httpx.Response) -> httpx.Response:
            assert 'name="otp"' in page.text, "every sign-in must ask for the one-time code"
            action, hidden = _form(page)
            right = totp(secret_key["value"])
            wrong = f"{(int(right) + 1) % 1_000_000:06d}"
            refused = browser.go(action, {**hidden, "otp": wrong})
            assert not refused.is_redirect and 'name="otp"' in refused.text
            action, hidden = _form(refused)
            return browser.go(action, {**hidden, "otp": totp(secret_key["value"])})

        second = _callback_query(_sign_in_with_our_api(client, browser, email, password,
                                                       wrong_then_right))
        again = client.get(f"/api/v1/portal/auth/callback?code={second['code']}"
                           f"&state={second['state']}", follow_redirects=False)
        assert again.status_code == 302
        assert client.get("/api/v1/portal/auth/session").json()["patient"] == {
            "displayName": "Mai"}
        assert admin.delete(f"/users/{user['id']}").status_code == 204
