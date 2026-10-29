"""Staff back-channel logout (core/backchannel.py, D94): the logout token's checks, and the
sessions it ends against the real schema. Keycloak's keys are made at run time and its JWKS
endpoint is a fake; the database is real (TEST_DATABASE_URL; the database tests skip without
it). Synthetic data only."""

import base64
import json
import secrets
import time
from typing import Any
from uuid import UUID, uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core import backchannel
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

PUBLIC = "https://portal.example.test/kc"
ISSUER = f"{PUBLIC}/realms/shri-staff"
KID = "kc-test-key"


def _rsa() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


SIGNING = _rsa()
OTHER = _rsa()


def _jwks(key: rsa.RSAPrivateKey = SIGNING, kid: str = KID) -> dict[str, Any]:
    entry = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    entry.update({"kid": kid, "use": "sig", "alg": "RS256"})
    return {"keys": [entry]}


class FakeKeycloak:
    def __init__(self) -> None:
        self.jwks = _jwks()
        self.fetches = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/kc/realms/shri-staff/protocol/openid-connect/certs"
        self.fetches += 1
        return httpx.Response(200, json=self.jwks)


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "environment": "test", "keycloak_public_url": PUBLIC,
        "keycloak_internal_url": "http://keycloak.test:8080/kc",
        "keycloak_client_secret": SecretStr(secrets.token_hex(16)),
        "keycloak_redirect_uri": "https://portal.example.test/api/v1/auth/callback",
        "session_secret": SecretStr(secrets.token_hex(32))}
    values.update(overrides)
    return Settings(**values)


def _claims(**changes: Any) -> dict[str, Any]:
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": ISSUER, "aud": "shri-web", "iat": now, "exp": now + 120, "jti": str(uuid4()),
        "sid": f"kc-sid-{uuid4().hex[:8]}", "sub": f"kc-{uuid4()}",
        "events": {backchannel.LOGOUT_EVENT: {}}}
    claims.update(changes)
    return {k: v for k, v in claims.items() if v is not None}


def _token(claims: dict[str, Any], key: Any = SIGNING, alg: str = "RS256",
           kid: str | None = KID) -> str:
    headers = {"kid": kid} if kid else {}
    return jwt.encode(claims, key, algorithm=alg, headers=headers)


def _unsigned(claims: dict[str, Any]) -> str:
    def part(data: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")
    return f"{part({'alg': 'none', 'kid': KID})}.{part(claims)}."


def _keys(fake: FakeKeycloak) -> backchannel.StaffRealmKeys:
    return backchannel.StaffRealmKeys(_settings(), transport=httpx.MockTransport(fake))


async def test_a_good_token_passes() -> None:
    claims = await backchannel.verify(_keys(FakeKeycloak()), _settings(), _token(_claims()))
    assert claims["aud"] == "shri-web" and backchannel.LOGOUT_EVENT in claims["events"]


def _hs256_with_the_public_key() -> str:
    """The classic confusion attack: HS256 keyed with the RSA public key's PEM."""
    from cryptography.hazmat.primitives import serialization

    pem = SIGNING.public_key().public_bytes(serialization.Encoding.PEM,
                                            serialization.PublicFormat.SubjectPublicKeyInfo)
    header = {"alg": "HS256", "kid": KID, "typ": "JWT"}

    def part(data: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")
    import hashlib
    import hmac
    signing_input = f"{part(header)}.{part(_claims())}"
    signature = base64.urlsafe_b64encode(hmac.new(pem, signing_input.encode(),
                                                  hashlib.sha256).digest()).decode().rstrip("=")
    return f"{signing_input}.{signature}"


@pytest.mark.parametrize(("case", "make"), [
    ("alg none", lambda: _unsigned(_claims())),
    ("HS256 with the public key", _hs256_with_the_public_key),
    ("a wrong key", lambda: _token(_claims(), key=OTHER)),
    ("expired", lambda: _token(_claims(iat=int(time.time()) - 3600,
                                       exp=int(time.time()) - 3000))),
    ("issued too long ago", lambda: _token(_claims(iat=int(time.time()) - 900))),
    ("issued in the future", lambda: _token(_claims(iat=int(time.time()) + 600,
                                                    exp=int(time.time()) + 900))),
    ("a nonce", lambda: _token(_claims(nonce="n-1"))),
    ("a wrong aud", lambda: _token(_claims(aud="another-client"))),
    ("a wrong iss", lambda: _token(_claims(iss=f"{PUBLIC}/realms/shri-patients"))),
    ("no logout event", lambda: _token(_claims(events={"other": {}}))),
    ("neither sid nor sub", lambda: _token(_claims(sid=None, sub=None))),
    ("no jti", lambda: _token(_claims(jti=None))),
    ("an unknown kid", lambda: _token(_claims(), kid="not-a-key")),
    ("no kid", lambda: _token(_claims(), kid=None)),
    ("not a token", lambda: "not.a.token"),
])
async def test_every_bad_token_is_the_same_400(case: str, make: Any) -> None:
    with pytest.raises(backchannel.LogoutTokenRefused) as refused:
        await backchannel.verify(_keys(FakeKeycloak()), _settings(), make())
    assert refused.value.status == 400 and refused.value.code == "malformed-request", case


async def test_an_unknown_kid_fetches_the_keys_again_once_then_waits() -> None:
    fake = FakeKeycloak()
    keys = _keys(fake)
    await backchannel.verify(keys, _settings(), _token(_claims()))
    rotated = _rsa()
    fake.jwks = _jwks(rotated, kid="kc-rotated")
    with pytest.raises(backchannel.LogoutTokenRefused):  # within a minute: no second fetch
        await backchannel.verify(keys, _settings(), _token(_claims(), key=rotated,
                                                            kid="kc-rotated"))
    assert fake.fetches == 1
    fresh = _keys(fake)  # a new process, or after the minute: the rotated key is found
    await backchannel.verify(fresh, _settings(), _token(_claims(), key=rotated, kid="kc-rotated"))


# ------------------------------------------------------------------- against the schema
def _staff_session(admin: Engine, tenant_id: UUID, user_id: UUID, sid: str) -> UUID:
    session_id = uuid4()
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.app_session (id, tenant_id, user_id, token_hash, "
            "keycloak_access_token_enc, keycloak_refresh_token_enc, keycloak_sid, "
            "idle_expires_at, expires_at) VALUES (:i, :t, :u, :h, 'vault:v1:YQ==', "
            "'vault:v1:cg==', :sid, now() + interval '15 minutes', now() + interval '12 hours')"),
            {"i": session_id, "t": tenant_id, "u": user_id, "h": secrets.token_hex(32),
             "sid": sid})
    return session_id


def _revoked(admin: Engine, session_id: UUID) -> bool:
    with admin.connect() as c:
        return bool(c.execute(text("SELECT revoked_at IS NOT NULL FROM admin.app_session "
                                   "WHERE id = :i"), {"i": session_id}).scalar_one())


@pytest.fixture
def staff(db: Session, tenant: UUID, admin_engine: Engine) -> dict[str, Any]:  # noqa: F811
    user = b.practitioner(db, "Rivera", "Elena")["user"]
    db.commit()
    subject = f"kc-{uuid4()}"
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.app_user SET keycloak_subject = :s WHERE id = :u"),
                  {"s": subject, "u": user.id})
    return {"tenant": tenant, "user": user.id, "subject": subject}


@pytest.fixture
def client() -> Any:
    from app.main import create_app

    app = create_app(_settings(database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    app.state.staff_realm_keys = backchannel.StaffRealmKeys(
        _settings(), transport=httpx.MockTransport(FakeKeycloak()))
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _post(client: TestClient, token: str) -> httpx.Response:
    response: httpx.Response = client.post(
        backchannel.PATH, content=f"logout_token={token}",
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    return response


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_logout_by_sid_ends_that_session_at_once_with_its_audit_row(
        client: TestClient, staff: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    mine = _staff_session(admin_engine, staff["tenant"], staff["user"], "kc-sid-a")
    other = _staff_session(admin_engine, staff["tenant"], staff["user"], "kc-sid-b")
    response = _post(client, _token(_claims(sid="kc-sid-a", sub=staff["subject"])))
    assert response.status_code == 200 and response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert _revoked(admin_engine, mine) and not _revoked(admin_engine, other)
    with admin_engine.connect() as c:
        row = c.execute(text("SELECT actor_type, actor_display, action, category, reason FROM "
                             "audit.audit_event WHERE entity_id = :s"), {"s": str(mine)}).one()
    assert tuple(row) == ("partner", "keycloak", "logout", "security",
                          "keycloak-backchannel-logout")


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_logout_by_sub_ends_every_session_of_the_user(
        client: TestClient, staff: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    sessions = [_staff_session(admin_engine, staff["tenant"], staff["user"], f"kc-sid-{i}")
                for i in range(3)]
    assert _post(client, _token(_claims(sid=None, sub=staff["subject"]))).status_code == 200
    assert all(_revoked(admin_engine, s) for s in sessions)


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_reused_jti_is_refused_the_same_way(
        client: TestClient, staff: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    token = _token(_claims(sid="kc-sid-replay", sub=staff["subject"]))
    assert _post(client, token).status_code == 200
    again = _post(client, token)
    assert again.status_code == 400 and again.json()["code"] == "malformed-request"


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
@pytest.mark.parametrize("body", ["", "logout_token=", "logout_token=a&logout_token=b",
                                  "logout_token=x&extra=1", "%zz"])
def test_a_malformed_form_is_400(client: TestClient, body: str) -> None:
    response = client.post(backchannel.PATH, content=body,
                           headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert response.status_code == 400


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_token_is_never_logged(client: TestClient, staff: dict[str, Any],
                                   caplog: pytest.LogCaptureFixture) -> None:
    token = _token(_claims(sid="kc-sid-log", sub=staff["subject"]))
    _post(client, token)
    _post(client, token)  # the replay's refusal too
    assert token not in caplog.text and token.split(".")[2] not in caplog.text
