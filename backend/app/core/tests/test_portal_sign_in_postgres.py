"""Patient sign-in end to end against the real schema (ADR-0013): the front desk's invitation,
enrolment, sign-in, the portal session and its CSRF, sign-out, and the negative cases. The API
runs as shri_app and the portal's reads as shri_portal; the patient realm (its token endpoint and
its admin API) and Transit are fakes (httpx.MockTransport). A real Keycloak, with the one-time
code, is test_portal_keycloak_live.py. Needs TEST_DATABASE_URL; skipped otherwise. Synthetic
data only; secrets made at run time."""

import base64
import json
import secrets
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import date
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core import portal_sign_in as portal
from app.core import session as sessions
from app.core.config import Settings
from app.core.crypto import FieldCrypto
from app.core.db import Database
from app.core.deps import PortalPatient, require_own_record
from app.core.errors import Conflict, NotFound
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
ORIGIN = "https://portal.example.test"
ENROL = "/api/v1/portal/enrollments"


class FakeRealm:
    """The patient realm: its token endpoint (code, refresh, client credentials), logout, and the
    admin API calls the service account makes."""

    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}
        self.taken: set[str] = set()
        self.emails: list[str] = []
        self.deleted: list[str] = []
        self.fail_create = False
        self.subject = ""
        self.nonce = ""
        self.admin_calls: list[tuple[str, str, str]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/protocol/openid-connect/token"):
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            if form.get("grant_type") == "client_credentials":
                assert form["client_id"] == "shri-portal-admin"
                return httpx.Response(200, json={"access_token": "svc-" + secrets.token_hex(4),
                                                 "expires_in": 300})
            now = int(time.time())
            claims = {"iss": f"{PUBLIC}/realms/shri-patients", "aud": "shri-portal-web",
                      "exp": now + 300, "iat": now, "nonce": self.nonce, "sub": self.subject,
                      "sid": "kc-portal-session-1"}
            body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
            return httpx.Response(200, json={"access_token": f"a-{secrets.token_hex(4)}",
                                             "refresh_token": f"r-{secrets.token_hex(4)}",
                                             "id_token": f"e30.{body}.c2ln"})
        if path.endswith("/logout"):
            return httpx.Response(204)
        self.admin_calls.append((request.method, path, request.headers.get("authorization", "")))
        if request.method == "POST" and path.endswith("/admin/realms/shri-patients/users"):
            if self.fail_create:
                return httpx.Response(500)
            body = json.loads(request.content)
            if body["email"] in self.taken:
                return httpx.Response(409)
            user_id = str(uuid4())
            self.users[user_id] = body
            return httpx.Response(201, headers={
                "Location": f"http://keycloak.test:8080/kc/admin/realms/shri-patients/users/{user_id}"})
        if path.endswith("/execute-actions-email"):
            self.emails.append(path.split("/")[-2])
            return httpx.Response(204)
        if request.method == "DELETE":
            self.deleted.append(path.rsplit("/", 1)[-1])
            return httpx.Response(204)
        return httpx.Response(404)


def _fake_transit(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    if "/encrypt/" in request.url.path:
        return httpx.Response(200, json={"data": {"ciphertext": f"vault:v1:{body['plaintext']}"}})
    return httpx.Response(200, json={"data": {
        "plaintext": body["ciphertext"].removeprefix("vault:v1:")}})


@pytest.fixture
def chart(db: Session, tenant: UUID) -> dict[str, Any]:  # noqa: F811
    b.practice(db)
    me = b.patient(db, "Nguyen", "Mai")
    other = b.patient(db, "Okafor", "Ada")
    staff = b.practitioner(db, "Rivera", "Elena")["user"]
    db.commit()
    return {"tenant": tenant, "patient": me.id, "birth": me.birth_date, "other": other.id,
            "staff": staff.id}


@pytest.fixture
def realm() -> FakeRealm:
    return FakeRealm()


def _settings(**overrides: Any) -> Settings:
    def secret() -> SecretStr:
        return SecretStr(secrets.token_hex(32))

    values: dict[str, Any] = {
        "environment": "test", "auth_mode": "dev_header", "database_url": TEST_DATABASE_URL,
        "portal_database_url": TEST_DATABASE_URL, "keycloak_public_url": PUBLIC,
        "keycloak_internal_url": "http://keycloak.test:8080/kc",
        "portal_client_secret": secret(), "portal_admin_client_secret": secret(),
        "portal_redirect_uri": f"{ORIGIN}/api/v1/portal/auth/callback",
        "portal_session_secret": secret(), "portal_invitation_secret": secret(),
        "portal_origin": ORIGIN, "public_form_secret": secret(),
        "openbao_transit_addr": "http://bao.test:8200", "openbao_transit_token": secret(),
        # The same Keycloak serves staff sign-in, which needs its own client and keys.
        "keycloak_client_secret": secret(), "session_secret": secret(),
        "keycloak_redirect_uri": f"{ORIGIN}/api/v1/auth/callback"}
    values.update(overrides)
    return Settings(**values)


def _app(realm: FakeRealm, **overrides: Any) -> Any:
    settings = _settings(**overrides)
    app = create_app(settings)
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    switch_to_role(app.state.portal_db.engine.sync_engine, "shri_portal")
    app.state.portal_keycloak = portal.PortalKeycloak(settings,
                                                      transport=httpx.MockTransport(realm))
    app.state.patient_accounts = portal.PatientAccounts(settings,
                                                        transport=httpx.MockTransport(realm))
    app.state.crypto = FieldCrypto(settings, transport=httpx.MockTransport(_fake_transit))
    return app


@pytest.fixture
def app(realm: FakeRealm) -> Any:
    return _app(realm)


@pytest.fixture
def client(app: Any) -> Iterator[TestClient]:
    with TestClient(app, base_url="https://testserver", raise_server_exceptions=False) as c:
        yield c


@asynccontextmanager
async def _staff_db(app: Any) -> AsyncIterator[Database]:
    """The front desk's side, on the test's own event loop: its own engine, never the app's
    pool, which the TestClient's loop uses."""
    staff_db = Database(app.state.settings)
    switch_to_role(staff_db.engine.sync_engine, "shri_app")
    try:
        yield staff_db
    finally:
        await staff_db.dispose()


async def _invite(app: Any, chart: dict[str, Any], patient: UUID | None = None) -> str:
    async with _staff_db(app) as staff_db, staff_db.tenant_session(chart["tenant"],
                                                                     chart["staff"]) as s:
        issued = await portal.issue_invitation(s, app.state.settings, patient or chart["patient"],
                                               chart["staff"])
        await s.commit()
    return issued.code


def _enrol(client: TestClient, code: str, birth: date, email: str | None = None,
           **headers: str) -> httpx.Response:
    response: httpx.Response = client.post(ENROL, headers={"Origin": ORIGIN, **headers}, json={
        "invitationCode": code, "birthDate": birth.isoformat(),
        "email": email or f"synthetic-{uuid4().hex[:8]}@example.com"})
    return response


def _refused(response: httpx.Response) -> bool:
    body = response.json()
    return (response.status_code == 422 and body["code"] == "business-rule-violation"
            and body["errors"] == [{"in": "body", "pointer": "/invitationCode",
                                    "code": "not-allowed-value"}])


def _account(admin: Engine, patient: UUID) -> Any:
    with admin.connect() as c:
        return c.execute(text("SELECT id, keycloak_user_id, status, enrolled_at FROM "
                              "admin.portal_account WHERE patient_id = :p"), {"p": patient}).all()


def _invitation(admin: Engine, patient: UUID) -> Any:
    with admin.connect() as c:
        return c.execute(text("SELECT used_at, revoked_at, failed_tries FROM "
                              "admin.portal_invitation WHERE patient_id = :p "
                              "ORDER BY created_at DESC LIMIT 1"), {"p": patient}).one()


# ----------------------------------------------------------------------------- enrolment
async def test_enrolment_creates_a_pending_account_and_the_realm_sends_its_set_up_email(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    code = await _invite(app, chart)
    assert _enrol(client, code, chart["birth"], "mai.synthetic@example.com").status_code == 204
    (account,) = _account(admin_engine, chart["patient"])
    assert account.status == "pending-setup" and account.enrolled_at is None
    user = realm.users[account.keycloak_user_id]
    assert user["email"] == "mai.synthetic@example.com" and user["enabled"] is True
    assert set(user["requiredActions"]) == {"VERIFY_EMAIL", "UPDATE_PASSWORD", "CONFIGURE_TOTP"}
    assert realm.emails == [account.keycloak_user_id]
    assert all(auth.startswith("Bearer svc-") for _, _, auth in realm.admin_calls)
    assert _invitation(admin_engine, chart["patient"]).used_at is not None
    with admin_engine.connect() as c:
        row = c.execute(text("SELECT actor_type, action, category, patient_id, reason FROM "
                             "audit.audit_event WHERE entity_id = :a"),
                        {"a": str(account.id)}).one()
    assert tuple(row) == ("patient", "create", "security", chart["patient"], "enrolled")
    for value in (code, "mai.synthetic", "1984"):  # never the code, the email or the birth date
        with admin_engine.connect() as c:
            assert not c.execute(text("SELECT 1 FROM audit.audit_event WHERE "
                                      "coalesce(reason, '') || coalesce(entity_id, '') || "
                                      "coalesce(user_agent, '') LIKE :v"),
                                 {"v": f"%{value}%"}).first()


async def test_a_code_works_in_any_case_without_dashes_and_with_look_alikes(
        app: Any, client: TestClient, chart: dict[str, Any]) -> None:
    code = await _invite(app, chart)
    typed = code.replace("-", "").lower().replace("0", "o").replace("1", "l")
    assert _enrol(client, typed, chart["birth"]).status_code == 204


async def test_a_reused_code_is_refused_like_any_other(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any]) -> None:
    code = await _invite(app, chart)
    assert _enrol(client, code, chart["birth"]).status_code == 204
    again = _enrol(client, code, chart["birth"])
    assert _refused(again) and len(realm.users) == 1


async def test_an_expired_code_is_refused(app: Any, client: TestClient, chart: dict[str, Any],
                                          admin_engine: Engine) -> None:  # noqa: F811
    # expires_at is fixed once created (a guard), so the expired invitation is made that way.
    code = portal.new_code()
    key = app.state.settings.portal_invitation_secret.get_secret_value().encode()
    with admin_engine.begin() as c:
        c.execute(text(
            "INSERT INTO admin.portal_invitation (id, tenant_id, patient_id, code_hmac, "
            "issued_by_user_id, created_at, expires_at) VALUES (:i, :t, :p, :h, :u, "
            "now() - interval '4 days', now() - interval '1 hour')"),
            {"i": uuid4(), "t": chart["tenant"], "p": chart["patient"], "u": chart["staff"],
             "h": portal.code_hmac(key, portal.normalize_code(code) or "")})
    assert _refused(_enrol(client, code, chart["birth"]))


async def test_an_unknown_or_malformed_code_is_refused_the_same_way(
        client: TestClient, chart: dict[str, Any]) -> None:
    assert _refused(_enrol(client, portal.new_code(), chart["birth"]))


async def test_five_wrong_birth_dates_revoke_the_code(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    code = await _invite(app, chart)
    for _ in range(5):
        assert _refused(_enrol(client, code, date(1990, 1, 1)))
    invitation = _invitation(admin_engine, chart["patient"])
    assert invitation.failed_tries == 5 and invitation.revoked_at is not None
    assert _refused(_enrol(client, code, chart["birth"]))  # even with the right one now
    assert realm.users == {}
    with admin_engine.connect() as c:
        denied = c.execute(text(
            "SELECT count(*) FROM audit.audit_event WHERE tenant_id IS NULL AND "
            "action = 'access-denied' AND reason = 'enrolment-refused' AND actor_type = "
            "'anonymous' AND recorded_at > now() - interval '1 minute'")).scalar_one()
    assert denied >= 6  # clinic-less, no patient (A47)


async def test_another_patients_code_with_my_birth_date_is_refused(
        app: Any, client: TestClient, chart: dict[str, Any]) -> None:
    theirs = await _invite(app, chart, chart["other"])
    assert _refused(_enrol(client, theirs, date(1990, 1, 1)))


async def test_an_email_already_in_the_realm_is_refused_and_the_code_stays_usable(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    realm.taken.add("taken@example.com")
    code = await _invite(app, chart)
    assert _refused(_enrol(client, code, chart["birth"], "taken@example.com"))
    assert _invitation(admin_engine, chart["patient"]).used_at is None
    assert _enrol(client, code, chart["birth"]).status_code == 204


async def test_a_realm_failure_leaves_the_code_usable(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    code = await _invite(app, chart)
    realm.fail_create = True
    assert _enrol(client, code, chart["birth"]).status_code == 503
    assert _invitation(admin_engine, chart["patient"]).used_at is None
    assert _account(admin_engine, chart["patient"]) == []
    realm.fail_create = False
    assert _enrol(client, code, chart["birth"]).status_code == 204


async def test_a_realm_user_whose_enrolment_did_not_commit_is_deleted(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any],
        admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: F811
    code = await _invite(app, chart)
    monkeypatch.setattr(portal, "_NEW_ACCOUNT", text("INSERT INTO admin.no_such_table VALUES (1)"))
    assert _enrol(client, code, chart["birth"]).status_code == 500
    assert realm.deleted == list(realm.users)  # the one realm user made, removed again
    assert _invitation(admin_engine, chart["patient"]).used_at is None


@pytest.mark.parametrize("origin", [None, "https://elsewhere.example.test", "null"])
async def test_enrolment_only_from_the_portal_host(client: TestClient, chart: dict[str, Any],
                                                   origin: str | None) -> None:
    headers = {"Origin": origin} if origin else {}
    response = client.post(ENROL, headers=headers, json={
        "invitationCode": portal.new_code(), "birthDate": "1984-03-09",
        "email": "synthetic@example.com"})
    assert response.status_code == 403 and response.json()["code"] == "csrf-check-failed"


async def test_enrolment_is_rate_limited_per_ip(realm: FakeRealm, chart: dict[str, Any]) -> None:
    with TestClient(_app(realm, portal_enrollment_ip_limit=2), base_url="https://testserver",
                    raise_server_exceptions=False) as client:
        for _ in range(2):
            assert _enrol(client, portal.new_code(), chart["birth"]).status_code == 422
        limited = _enrol(client, portal.new_code(), chart["birth"])
    assert limited.status_code == 429 and int(limited.headers["Retry-After"]) > 0


async def test_a_retry_with_the_same_key_replays_and_another_body_is_refused(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any]) -> None:
    code, key = await _invite(app, chart), str(uuid4())
    email = "retry.synthetic@example.com"
    retry = {"Idempotency-Key": key}
    assert _enrol(client, code, chart["birth"], email, **retry).status_code == 204
    assert _enrol(client, code, chart["birth"], email, **retry).status_code == 204
    assert len(realm.users) == 1
    other = _enrol(client, code, chart["birth"], "other@example.com", **{"Idempotency-Key": key})
    assert other.status_code == 422 and other.json()["code"] == "idempotency-key-reused"


async def test_one_account_per_chart(app: Any, client: TestClient,
                                     chart: dict[str, Any]) -> None:
    assert _enrol(client, await _invite(app, chart), chart["birth"]).status_code == 204
    with pytest.raises(Conflict) as live:
        await _invite(app, chart)
    assert live.value.extensions["currentState"] == "pending-setup"


async def test_a_revoked_invitation_cannot_be_used_and_revoking_follows_the_contract(
        app: Any, client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    code = await _invite(app, chart)
    with admin_engine.connect() as c:
        invitation_id = c.execute(text("SELECT id FROM admin.portal_invitation WHERE patient_id "
                                       "= :p AND revoked_at IS NULL"),
                                  {"p": chart["patient"]}).scalar_one()
    async with _staff_db(app) as staff_db, staff_db.tenant_session(chart["tenant"],
                                                                     chart["staff"]) as s:
        await portal.revoke_invitation(s, chart["patient"], invitation_id, chart["staff"])
        await portal.revoke_invitation(s, chart["patient"], invitation_id, chart["staff"])  # again
        with pytest.raises(NotFound):  # not this patient's
            await portal.revoke_invitation(s, chart["other"], invitation_id, chart["staff"])
        await s.commit()
    assert _refused(_enrol(client, code, chart["birth"]))
    used = await _invite(app, chart)
    assert _enrol(client, used, chart["birth"]).status_code == 204
    with admin_engine.connect() as c:
        used_id = c.execute(text("SELECT id FROM admin.portal_invitation WHERE patient_id = :p "
                                 "AND used_at IS NOT NULL"), {"p": chart["patient"]}).scalar_one()
    async with _staff_db(app) as staff_db, staff_db.tenant_session(chart["tenant"],
                                                                     chart["staff"]) as s:
        with pytest.raises(Conflict) as already:
            await portal.revoke_invitation(s, chart["patient"], used_id, chart["staff"])
    assert already.value.extensions["currentState"] == "used"


async def test_issuing_a_new_code_revokes_the_open_one(
        app: Any, client: TestClient, chart: dict[str, Any]) -> None:
    first = await _invite(app, chart)
    second = await _invite(app, chart)
    assert _refused(_enrol(client, first, chart["birth"]))
    assert _enrol(client, second, chart["birth"]).status_code == 204


# --------------------------------------------------------------------------- sign-in
async def _signed_in(app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any],
                     admin: Engine) -> httpx.Response:
    assert _enrol(client, await _invite(app, chart), chart["birth"]).status_code == 204
    realm.subject = _account(admin, chart["patient"])[0].keycloak_user_id
    login = client.get("/api/v1/portal/auth/login", follow_redirects=False)
    query = {k: v[0] for k, v in parse_qs(urlparse(login.headers["location"]).query).items()}
    realm.nonce = query["nonce"]
    callback: httpx.Response = client.get(
        f"/api/v1/portal/auth/callback?code=c-1&state={query['state']}", follow_redirects=False)
    return callback


async def test_sign_in_activates_the_account_and_opens_a_portal_session(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    callback = await _signed_in(app, client, realm, chart, admin_engine)
    assert callback.status_code == 302 and callback.headers["location"] == "/portal/"
    cookie = callback.headers["set-cookie"]
    for attribute in ("__Host-shri_portal=", "HttpOnly", "Secure", "SameSite=strict", "Path=/"):
        assert attribute.lower() in cookie.lower(), attribute
    assert "domain=" not in cookie.lower()
    (account,) = _account(admin_engine, chart["patient"])
    assert account.status == "active" and account.enrolled_at is not None
    session = client.get("/api/v1/portal/auth/session")
    assert session.status_code == 200, session.text
    body = session.json()
    assert body["patient"] == {"displayName": "Mai"} and len(body["csrfToken"]) == 64
    assert set(body) == {"patient", "csrfToken", "idleExpiresAt", "expiresAt"}
    with admin_engine.connect() as c:
        stored = c.execute(text("SELECT token_hash, keycloak_access_token_enc FROM "
                                "admin.portal_session WHERE patient_id = :p"),
                           {"p": chart["patient"]}).one()
    token = client.cookies[portal.PORTAL_COOKIE]
    assert stored.token_hash == sessions.token_hash(token) and token not in stored.token_hash
    assert stored.keycloak_access_token_enc.startswith("vault:v1:")


async def test_writes_need_the_portal_csrf_token_and_sign_out_ends_the_session(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    await _signed_in(app, client, realm, chart, admin_engine)
    csrf = client.get("/api/v1/portal/auth/session").json()["csrfToken"]
    for headers in ({}, {"Origin": ORIGIN}, {"X-CSRF-Token": csrf},
                    {"Origin": "https://staff.example.test", "X-CSRF-Token": csrf}):
        refused = client.post("/api/v1/portal/auth/refresh", headers=headers)
        assert refused.status_code == 403 and refused.json()["code"] == "csrf-check-failed"
    ok = {"Origin": ORIGIN, "X-CSRF-Token": csrf}
    assert client.post("/api/v1/portal/auth/refresh", headers=ok).status_code == 200
    assert client.post("/api/v1/portal/auth/logout", headers=ok).status_code == 204
    gone = client.get("/api/v1/portal/auth/session")
    assert gone.status_code == 401


async def test_an_unknown_or_disabled_account_cannot_sign_in(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    assert _enrol(client, await _invite(app, chart), chart["birth"]).status_code == 204
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.portal_account SET status = 'disabled', enrolled_at = now(), "
                       "disabled_at = now(), disabled_reason = 'Synthetic test' "
                       "WHERE patient_id = :p"),
                  {"p": chart["patient"]})
    for subject in (_account(admin_engine, chart["patient"])[0].keycloak_user_id, str(uuid4())):
        realm.subject = subject
        login = client.get("/api/v1/portal/auth/login", follow_redirects=False)
        query = {k: v[0] for k, v in parse_qs(urlparse(login.headers["location"]).query).items()}
        realm.nonce = query["nonce"]
        callback = client.get(f"/api/v1/portal/auth/callback?code=c&state={query['state']}",
                              follow_redirects=False)
        assert callback.status_code == 422 and portal.PORTAL_COOKIE not in client.cookies


# ------------------------------------------------------------ the guards, both ways
async def test_a_portal_session_never_reaches_a_staff_route_and_the_reverse(
        app: Any, client: TestClient, realm: FakeRealm, chart: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    staff_app = _app(realm, auth_mode="keycloak")
    await _signed_in(app, client, realm, chart, admin_engine)
    token = client.cookies[portal.PORTAL_COOKIE]
    with TestClient(staff_app, base_url="https://testserver",
                    raise_server_exceptions=False) as other:
        other.cookies.set(portal.PORTAL_COOKIE, token)
        assert other.get("/api/v1/auth/session").status_code == 401  # staff route
        other.cookies.clear()
        other.cookies.set(sessions.SESSION_COOKIE, token)  # the portal token as a staff cookie
        assert other.get("/api/v1/auth/session").status_code == 401
        assert other.get("/api/v1/portal/auth/session").status_code == 401  # staff cookie only


# ------------------------------------------------------------------ own record only
def test_a_record_of_another_patient_is_404() -> None:
    me = PortalPatient(patient_id=uuid4(), organization_id=uuid4())
    require_own_record(me, me.patient_id)
    for theirs in (uuid4(), None):
        with pytest.raises(NotFound):
            require_own_record(me, theirs)


async def test_the_portal_database_role_shows_only_the_sessions_chart(
        app: Any, chart: dict[str, Any]) -> None:
    portal_db = Database(app.state.settings, app.state.settings.portal_database_url)
    switch_to_role(portal_db.engine.sync_engine, "shri_portal")
    async with portal_db.patient_session(chart["tenant"], chart["patient"]) as s:
        role = (await s.execute(text("SELECT current_user"))).scalar_one()
        seen = set((await s.execute(text("SELECT id FROM clinical.patient"))).scalars())
        names = (await s.execute(text("SELECT count(*) FROM clinical.human_name WHERE "
                                      "patient_id = :o"), {"o": chart["other"]})).scalar_one()
        await s.rollback()
    await portal_db.dispose()
    assert role == "shri_portal" and seen == {chart["patient"]} and names == 0
