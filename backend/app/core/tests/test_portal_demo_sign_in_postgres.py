"""The demo server's portal sign-in end to end against the real schema (D121; 0027): the chart
the database finds, its demo-phone account and session, the portal reads as shri_portal for that
one chart, no token refresh, sign-out, and the refusals (an unknown number, a wrong date of birth,
a chart that already has a Keycloak account), audited without the number or the date of birth.
The API runs as shri_app and the portal's reads as shri_portal. Needs TEST_DATABASE_URL; skipped
otherwise. Synthetic data only: fictional numbers and dates; secrets made at run time."""

import secrets
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, text

from app.core import portal_sign_in as portal
from app.core.config import Settings
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    app_engine,
    switch_to_role,
)
from app.db.tests.test_demo_portal_sign_in import DOB, _demo_clinic, _number, _phoned
from app.main import create_app

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

ORIGIN = "https://portal.example.test"
ROUTE = "/api/v1/portal/auth/demo-sign-in"


def _settings() -> Settings:
    def secret() -> SecretStr:
        return SecretStr(secrets.token_hex(32))

    return Settings(environment="test", shri_demo=True, portal_demo_sign_in=True,
                    auth_mode="dev_header", database_url=TEST_DATABASE_URL,
                    portal_database_url=TEST_DATABASE_URL, portal_session_secret=secret(),
                    portal_origin=ORIGIN, public_form_secret=secret())


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = create_app(_settings())
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    switch_to_role(app.state.portal_db.engine.sync_engine, "shri_portal")
    with TestClient(app, base_url="https://testserver", raise_server_exceptions=False) as c:
        yield c


@pytest.fixture
def chart(admin_engine: Engine, app_engine: Engine) -> dict[str, Any]:  # noqa: F811
    clinic = _demo_clinic(admin_engine)
    stored, digits = _number()
    patient = _phoned(admin_engine, app_engine, clinic, stored)
    return {"tenant": clinic, "patient": patient, "typed": stored, "digits": digits}


def _sign_in(client: TestClient, typed: str, birth: str = DOB.isoformat()) -> Any:
    return client.post(ROUTE, headers={"Origin": ORIGIN},
                       json={"mobileNumber": typed, "birthDate": birth})


def _refused(response: Any) -> bool:
    return bool(response.status_code == 422
            and response.json()["code"] == "business-rule-violation"
            and response.json()["errors"] == [{"in": "body", "pointer": "/mobileNumber",
                                               "code": "not-allowed-value"}])


def _accounts(admin: Engine, patient: uuid.UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT id, sign_in_method, status, keycloak_user_id, enrolled_at "
            "FROM admin.portal_account WHERE patient_id = :p"), {"p": patient}))


def _sessions(admin: Engine, patient: uuid.UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT id, sign_in_method, keycloak_access_token_enc, keycloak_refresh_token_enc, "
            "keycloak_sid, revoked_at FROM admin.portal_session WHERE patient_id = :p "
            "ORDER BY created_at"), {"p": patient}))


def _audit_text(admin: Engine, since_id: int) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT tenant_id, patient_id, actor_type, action, outcome, reason, entity_type, "
            "row_to_json(e)::text AS everything FROM audit.audit_event e WHERE id > :i "
            "ORDER BY id"), {"i": since_id}))


def _last_audit_id(admin: Engine) -> int:
    with admin.connect() as c:
        return int(c.execute(text("SELECT coalesce(max(id), 0) FROM audit.audit_event")
                             ).scalar_one())


def test_a_match_opens_a_demo_phone_session_for_that_one_chart(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    before = _last_audit_id(admin_engine)
    response = _sign_in(client, chart["typed"])
    assert response.status_code == 200, response.text
    assert f"{portal.PORTAL_COOKIE}=" in response.headers["set-cookie"]
    (account,) = _accounts(admin_engine, chart["patient"])
    assert (account.sign_in_method, account.status, account.keycloak_user_id) == (
        "demo-phone", "active", None) and account.enrolled_at is not None
    (session,) = _sessions(admin_engine, chart["patient"])
    assert session.sign_in_method == "demo-phone" and session.keycloak_access_token_enc is None
    assert session.keycloak_refresh_token_enc is None and session.keycloak_sid is None
    # The portal's own reads, as shri_portal: exactly the chart the lookup returned.
    session_body = client.get("/api/v1/portal/auth/session")
    assert session_body.status_code == 200 and session_body.json()["patient"] == {
        "displayName": "Mai"}
    allergies = client.get("/api/v1/portal/me/allergies")
    assert allergies.status_code == 200, allergies.text
    rows = _audit_text(admin_engine, before)
    assert {(r.action, r.reason, r.patient_id) for r in rows} >= {
        ("create", "demo-sign-in", chart["patient"]), ("login", "demo-sign-in", chart["patient"])}
    for r in rows:  # never the number or the date of birth, in any column
        assert chart["digits"][1:] not in r.everything and DOB.isoformat() not in r.everything


def test_a_second_sign_in_keeps_the_one_account(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    assert _sign_in(client, chart["typed"]).status_code == 200
    assert _sign_in(client, "+" + chart["digits"]).status_code == 200  # typed another way
    assert len(_accounts(admin_engine, chart["patient"])) == 1
    assert len(_sessions(admin_engine, chart["patient"])) == 2


def test_a_demo_session_never_refreshes_and_sign_out_ends_it(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    csrf = _sign_in(client, chart["typed"]).json()["csrfToken"]
    with admin_engine.begin() as c:  # older than the refresh backstop: a Keycloak one would refresh
        c.execute(text("UPDATE admin.portal_session SET tokens_refreshed_at = now() - "
                       "interval '1 hour' WHERE patient_id = :p"), {"p": chart["patient"]})
    ok = {"Origin": ORIGIN, "X-CSRF-Token": csrf}
    # No patient realm is configured here: any refresh attempt would be a 503.
    assert client.post("/api/v1/portal/auth/refresh", headers=ok).status_code == 200
    assert client.post("/api/v1/portal/auth/logout", headers=ok).status_code == 204
    assert client.get("/api/v1/portal/auth/session").status_code == 401
    (session,) = _sessions(admin_engine, chart["patient"])
    assert session.revoked_at is not None


def test_an_unknown_number_or_a_wrong_birth_date_is_the_one_refusal_and_audited_anonymously(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    before = _last_audit_id(admin_engine)
    assert _refused(_sign_in(client, "(209) 555-0199"))
    assert _refused(_sign_in(client, chart["typed"], "1937-05-22"))
    assert _accounts(admin_engine, chart["patient"]) == []
    rows = [r for r in _audit_text(admin_engine, before) if r.reason == "demo-sign-in-refused"]
    assert len(rows) == 2
    for r in rows:
        assert (r.tenant_id, r.patient_id, r.actor_type, r.action, r.outcome) == (
            None, None, "anonymous", "access-denied", "denied")
        assert chart["digits"][1:] not in r.everything and "1937-05" not in r.everything


def test_a_chart_with_a_keycloak_account_keeps_its_normal_sign_in(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.portal_account (id, tenant_id, keycloak_user_id, "
                       "patient_id, status, enrolled_at) VALUES (gen_random_uuid(), :t, :k, :p, "
                       "'active', now())"),
                  {"t": chart["tenant"], "k": str(uuid.uuid4()), "p": chart["patient"]})
    assert _refused(_sign_in(client, chart["typed"]))
    assert _sessions(admin_engine, chart["patient"]) == []
    (account,) = _accounts(admin_engine, chart["patient"])
    assert account.sign_in_method == "keycloak"
