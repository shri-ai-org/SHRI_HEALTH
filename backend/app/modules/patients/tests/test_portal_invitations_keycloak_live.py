"""The front desk's invitation, end to end against a real Keycloak (shri-patients realm) and the
database (ADR-0013 §3): a code issued by createPortalInvitation and then revoked is refused at
enrolment; the next code enrols the patient through core's /portal/enrollments, which creates the
realm user; the portal account is then pending-setup, a new invitation is refused, and the used
invitation can't be revoked.

Runs only with a test Keycloak and the database (skipped otherwise), with the same settings as
core's test_portal_keycloak_live.py:
    PORTAL_KEYCLOAK_TEST_URL         e.g. http://keycloak:8080/kc (reachable from the tests)
    PORTAL_KEYCLOAK_CLIENT_SECRET    the realm's SHRI_PORTAL_CLIENT_SECRET
    PORTAL_KEYCLOAK_ADMIN_SECRET     the realm's SHRI_PORTAL_ADMIN_CLIENT_SECRET
Core's T45 permission rows are stood in for as in test_portal_invitations_api.py. Synthetic data
only; the realm user is deleted at the end.
"""

from __future__ import annotations

import os
import secrets
import uuid
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.core.deps import DEV_USER_HEADER, CurrentUser, current_user
from app.db.tests.conftest import TEST_DATABASE_URL, switch_to_role
from app.main import create_app

from .test_patients_live import clinics, users  # noqa: F401  (fixtures)
from .test_portal_invitations_api import CODE, grant_portal_permissions, mount_portal_router

KC = os.environ.get("PORTAL_KEYCLOAK_TEST_URL")
WEB_SECRET = os.environ.get("PORTAL_KEYCLOAK_CLIENT_SECRET")
ADMIN_SECRET = os.environ.get("PORTAL_KEYCLOAK_ADMIN_SECRET")
ORIGIN = "https://testserver"
API = "/api/v1/patients"

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
    pytest.mark.skipif(not (KC and WEB_SECRET and ADMIN_SECRET),
                       reason="PORTAL_KEYCLOAK_TEST_URL and its secrets not set"),
]


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


def _realm_admin() -> httpx.Client:
    """The realm's admin API with the service account's token (client credentials), only to
    check and then delete the synthetic realm user."""
    token = httpx.post(f"{KC}/realms/shri-patients/protocol/openid-connect/token", data={
        "grant_type": "client_credentials", "client_id": "shri-portal-admin",
        "client_secret": ADMIN_SECRET}, timeout=10)
    assert token.status_code == 200
    return httpx.Client(base_url=f"{KC}/admin/realms/shri-patients", timeout=10,
                        headers={"Authorization": f"Bearer {token.json()['access_token']}"})


@pytest.fixture
def client(users: dict[str, CurrentUser],  # noqa: F811
           monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    grant_portal_permissions(monkeypatch)
    app: FastAPI = create_app(_settings())
    mount_portal_router(app)
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    switch_to_role(app.state.portal_db.engine.sync_engine, "shri_portal")

    def signed_in(request: Request) -> CurrentUser:
        return users[request.headers[DEV_USER_HEADER]]

    app.dependency_overrides[current_user] = signed_in
    with TestClient(app, base_url=ORIGIN, raise_server_exceptions=False) as test_client:
        def as_user(name: str | None) -> TestClient:
            if name is None:
                test_client.headers.pop(DEV_USER_HEADER, None)
            else:
                test_client.headers[DEV_USER_HEADER] = name
            return test_client
        yield as_user
        assert test_client.portal is not None
        test_client.portal.call(app.state.db.dispose)
        test_client.portal.call(app.state.portal_db.dispose)


def test_issue_revoke_then_enrol_with_the_next_code(client: Any) -> None:
    birth_date = "1987-05-21"
    created = client("fd").post(API, json={
        "name": {"family": f"Realmtest{uuid.uuid4().hex[:6]}", "given": ["Ines"]},
        "birthDate": birth_date, "gender": "female",
        "phones": [{"number": f"+1217555{secrets.randbelow(10_000):04d}"}]})
    assert created.status_code == 201, created.text
    patient_id = UUID(created.json()["id"])
    invitations = f"{API}/{patient_id}/portal-invitations"
    email = f"synthetic-{uuid.uuid4().hex[:10]}@example.com"

    def enrol(code: str) -> int:
        response = client(None).post("/api/v1/portal/enrollments", headers={"Origin": ORIGIN},
                                     json={"invitationCode": code, "birthDate": birth_date,
                                           "email": email})
        return int(response.status_code)

    # A revoked code is refused at enrolment, with the same answer as any other failure.
    first = client("fd").post(invitations, json={"idChecked": True})
    assert first.status_code == 201, first.text
    assert client("fd").post(f"{invitations}/{first.json()['id']}/revoke").status_code == 200
    assert enrol(first.json()["code"]) == 422

    # The next code enrols the patient: core creates the realm user, the account is pending-setup.
    second = client("adm").post(invitations, json={"idChecked": True})
    assert second.status_code == 201 and CODE.match(second.json()["code"])
    admin = _realm_admin()
    try:
        assert enrol(second.json()["code"].lower().replace("-", "")) == 204
        (user,) = admin.get("/users", params={"email": email, "exact": "true"}).json()
        assert set(user["requiredActions"]) == {"VERIFY_EMAIL", "UPDATE_PASSWORD",
                                                "CONFIGURE_TOTP"}
        state = client("fd").get(f"{API}/{patient_id}/portal-account")
        assert state.status_code == 200, state.text
        assert state.json() == {"patientId": str(patient_id), "status": "pending-setup"}

        # One account per chart: no new invitation; and the used invitation can't be revoked.
        again = client("fd").post(invitations, json={"idChecked": True})
        assert again.status_code == 409 and again.json()["currentState"] == "pending-setup"
        used = client("fd").post(f"{invitations}/{second.json()['id']}/revoke")
        assert used.status_code == 409 and used.json()["currentState"] == "used"
    finally:
        for found in admin.get("/users", params={"email": email, "exact": "true"}).json():
            assert admin.delete(f"/users/{found['id']}").status_code == 204
        admin.close()
