"""The portal invitations and the portal account (B8a) against a live database, as shri_app, with
nothing replaced but the sign-in: core's tenant_db, chart check, audit and invitation functions
(portal_sign_in, #148), migration 0011's tables, and the real reads (portal_repository.py).

Core's T45 permission rows are stood in for as in test_portal_invitations_api.py. Runs where
``TEST_DATABASE_URL`` is set. Synthetic data only.
"""

from __future__ import annotations

import secrets
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import CLINIC_A, DEV_USER_HEADER, CurrentUser, current_user
from app.core.portal_sign_in import code_hmac, normalize_code
from app.db.tests.conftest import (
    TEST_DATABASE_URL,
    _role_search_path_sql,
    open_session,
    switch_to_role,
    sync_url,
)
from app.main import create_app

from .test_patients_live import clinics, users  # noqa: F401  (fixtures)
from .test_portal_invitations_api import CODE, grant_portal_permissions, mount_portal_router

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1/patients"


@pytest.fixture
def key() -> SecretStr:
    return SecretStr(secrets.token_hex(32))  # the invitation HMAC key, made per test


@pytest.fixture
def client(users: dict[str, CurrentUser], key: SecretStr,  # noqa: F811
           monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """One app per test on the test database as shri_app, with the portal routes mounted; only
    the sign-in is replaced (``X-Dev-User`` names one of ``users``)."""
    grant_portal_permissions(monkeypatch)
    app: FastAPI = create_app(Settings(environment="test", auth_mode="dev_header",
                                       database_url=TEST_DATABASE_URL,
                                       portal_invitation_secret=key))
    mount_portal_router(app)
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")

    def signed_in(request: Request) -> CurrentUser:
        return users[request.headers[DEV_USER_HEADER]]

    app.dependency_overrides[current_user] = signed_in
    with TestClient(app, raise_server_exceptions=False) as test_client:
        def as_user(name: str) -> TestClient:
            test_client.headers[DEV_USER_HEADER] = name
            return test_client
        yield as_user
        assert test_client.portal is not None
        test_client.portal.call(app.state.db.dispose)


def _register(client: Any) -> str:
    n = uuid.uuid4().hex[:6]
    created = client("fd").post(API, json={
        "name": {"family": f"Portal{n}", "given": [f"Given{n}"]},
        "birthDate": f"19{int(n[:2], 16) % 80 + 10}-0{int(n[2], 16) % 9 + 1}-1{int(n[3], 16) % 9}",
        "gender": "female", "phones": [{"number": f"+1217555{int(n[:4], 16) % 10000:04d}"}]})
    assert created.status_code == 201, created.text
    patient_id: str = created.json()["id"]
    return patient_id


def _superuser(clinic: UUID) -> tuple[Any, Session]:
    """A superuser session in one clinic with the app's search_path: for what the API can't do
    yet (an enrolled account, a merge) and for checking stored rows."""
    engine = create_engine(sync_url(), poolclass=NullPool)
    session = open_session(engine, clinic)
    session.execute(text(_role_search_path_sql("shri_app")))
    return engine, session


def _sql(clinic: UUID, sql: str, **params: Any) -> list[Any]:
    engine, session = _superuser(clinic)
    try:
        result = session.execute(text(sql), params)
        rows = list(result.mappings()) if sql.lstrip().upper().startswith("SELECT") else []
        session.commit()
        return rows
    finally:
        session.close()
        engine.dispose()


def _account(clinic: UUID, patient_id: str, status: str) -> None:
    extra = {"pending-setup": ("NULL", "NULL", "NULL"),
             "active": ("now()", "NULL", "NULL"),
             "disabled": ("now()", "now()", "'Synthetic: patient asked to close it.'")}[status]
    _sql(clinic, "INSERT INTO admin.portal_account (id, tenant_id, keycloak_user_id, patient_id, "
         f"status, enrolled_at, disabled_at, disabled_reason) VALUES (:i, :t, :k, :p, :s, "
         f"{extra[0]}, {extra[1]}, {extra[2]})",
         i=uuid.uuid4(), t=clinic, k=str(uuid.uuid4()), p=patient_id, s=status)


def test_issue_stores_only_the_hmac_and_audits_without_the_code(
        client: Any, clinics: dict[UUID, UUID], users: dict[str, CurrentUser],  # noqa: F811
        key: SecretStr) -> None:
    clinic = clinics[CLINIC_A]
    patient_id = _register(client)
    issued = client("fd").post(f"{API}/{patient_id}/portal-invitations",
                               json={"idChecked": True})
    assert issued.status_code == 201, issued.text
    body = issued.json()
    assert CODE.match(body["code"])
    assert issued.headers["Location"] == f"{API}/{patient_id}/portal-account"
    (row,) = _sql(clinic, "SELECT * FROM admin.portal_invitation WHERE patient_id = :p",
                  p=patient_id)
    assert str(row["id"]) == body["id"] and row["issued_by_user_id"] == users["fd"].id
    expected = code_hmac(key.get_secret_value().encode(), normalize_code(body["code"]) or "")
    assert row["code_hmac"] == expected
    stored = " ".join(str(v) for v in row.values())
    assert body["code"] not in stored and body["code"].replace("-", "") not in stored
    assert datetime.fromisoformat(body["issuedAt"]) == row["created_at"]
    assert datetime.fromisoformat(body["expiresAt"]) == row["expires_at"]
    assert row["expires_at"] - row["created_at"] == timedelta(hours=72)

    audits = _sql(clinic, "SELECT action, category, actor_user_id, reason, entity_type, "
                  "entity_id, row_to_json(a)::text AS whole FROM audit.audit_event a "
                  "WHERE patient_id = :p AND category = 'security'", p=patient_id)
    assert [(a["action"], a["actor_user_id"]) for a in audits] == [("create", users["fd"].id)]
    assert body["id"] in audits[0]["reason"]
    assert body["code"] not in audits[0]["whole"]
    assert body["code"].replace("-", "") not in audits[0]["whole"]

    state = client("adm").get(f"{API}/{patient_id}/portal-account")
    assert state.status_code == 200, state.text
    assert state.json()["status"] == "invited" and state.json()["invitation"]["id"] == body["id"]
    assert body["code"] not in state.text


def test_a_new_invitation_revokes_the_open_one(client: Any,
                                               clinics: dict[UUID, UUID]) -> None:  # noqa: F811
    clinic = clinics[CLINIC_A]
    patient_id = _register(client)
    path = f"{API}/{patient_id}/portal-invitations"
    first = client("fd").post(path, json={"idChecked": True}).json()
    second = client("adm").post(path, json={"idChecked": True})
    assert second.status_code == 201, second.text
    rows = {str(r["id"]): r for r in _sql(
        clinic, "SELECT id, revoked_at, used_at FROM admin.portal_invitation "
        "WHERE patient_id = :p", p=patient_id)}
    assert rows[first["id"]]["revoked_at"] is not None
    assert rows[second.json()["id"]]["revoked_at"] is None


def test_revoke_repeat_used_and_another_patients(client: Any,
                                                 clinics: dict[UUID, UUID]) -> None:  # noqa: F811
    clinic = clinics[CLINIC_A]
    patient_id, other_id = _register(client), _register(client)
    base = f"{API}/{patient_id}/portal-invitations"
    issued = client("fd").post(base, json={"idChecked": True}).json()
    revoked = client("fd").post(f"{base}/{issued['id']}/revoke")
    assert revoked.status_code == 200, revoked.text
    assert revoked.json() == {"patientId": patient_id, "status": "none"}
    (first,) = _sql(clinic, "SELECT revoked_at FROM admin.portal_invitation WHERE id = :i",
                    i=issued["id"])
    again = client("adm").post(f"{base}/{issued['id']}/revoke")
    assert again.status_code == 200 and again.json()["status"] == "none"
    (second,) = _sql(clinic, "SELECT revoked_at FROM admin.portal_invitation WHERE id = :i",
                     i=issued["id"])
    assert first["revoked_at"] == second["revoked_at"]  # repeating changed nothing
    actions = [a["action"] for a in _sql(
        clinic, "SELECT action FROM audit.audit_event WHERE patient_id = :p "
        "AND category = 'security' ORDER BY recorded_at", p=patient_id)]
    assert actions == ["create", "update", "update"]

    # Another patient's invitation is not found through this chart.
    theirs = client("fd").post(f"{API}/{other_id}/portal-invitations",
                               json={"idChecked": True}).json()
    assert client("fd").post(f"{base}/{theirs['id']}/revoke").status_code == 404

    # A used one can't be revoked.
    used = client("fd").post(base, json={"idChecked": True}).json()
    _sql(clinic, "UPDATE admin.portal_invitation SET used_at = now() WHERE id = :i",
         i=used["id"])
    refused = client("fd").post(f"{base}/{used['id']}/revoke")
    assert refused.status_code == 409, refused.text
    assert refused.json()["code"] == "invalid-state-transition"
    assert refused.json()["currentState"] == "used"


@pytest.mark.parametrize("status", ["pending-setup", "active", "disabled"])
def test_an_account_refuses_a_new_invitation_and_shows_its_state(
        client: Any, clinics: dict[UUID, UUID], status: str) -> None:  # noqa: F811
    clinic = clinics[CLINIC_A]
    patient_id = _register(client)
    open_one = client("fd").post(f"{API}/{patient_id}/portal-invitations",
                                 json={"idChecked": True}).json()
    _account(clinic, patient_id, status)
    refused = client("fd").post(f"{API}/{patient_id}/portal-invitations",
                                json={"idChecked": True})
    assert refused.status_code == 409, refused.text
    assert refused.json()["code"] == "invalid-state-transition"
    assert refused.json()["currentState"] == status
    (still,) = _sql(clinic, "SELECT revoked_at FROM admin.portal_invitation WHERE id = :i",
                    i=open_one["id"])
    assert still["revoked_at"] is None  # the refusal changed nothing
    state = client("fd").get(f"{API}/{patient_id}/portal-account").json()
    assert state["status"] == status
    assert ("enrolledAt" in state) == (status != "pending-setup")
    assert ("disabledAt" in state) == (status == "disabled")
    assert "email" not in state  # core doesn't read the realm's email yet (see the report)


def test_a_merged_chart_is_patient_merged(client: Any,
                                          clinics: dict[UUID, UUID]) -> None:  # noqa: F811
    clinic = clinics[CLINIC_A]
    merged, surviving = _register(client), _register(client)
    _sql(clinic, "INSERT INTO clinical.patient_link (id, tenant_id, patient_id, "
         "other_patient_id, type) VALUES (:i, :t, :p, :o, 'replaced-by')",
         i=uuid.uuid4(), t=clinic, p=merged, o=surviving)
    refused = client("fd").post(f"{API}/{merged}/portal-invitations", json={"idChecked": True})
    assert refused.status_code == 409 and refused.json()["code"] == "patient-merged"
    assert _sql(clinic, "SELECT id FROM admin.portal_invitation WHERE patient_id = :p",
                p=merged) == []
    assert client("fd").get(f"{API}/{merged}/portal-account").json()["status"] == "none"
    ok = client("fd").post(f"{API}/{surviving}/portal-invitations", json={"idChecked": True})
    assert ok.status_code == 201, ok.text


def test_a_restricted_chart_needs_break_glass(client: Any, clinics: dict[UUID, UUID],  # noqa: F811
                                              users: dict[str, CurrentUser]) -> None:  # noqa: F811
    clinic = clinics[CLINIC_A]
    patient_id = _register(client)
    issued = client("fd").post(f"{API}/{patient_id}/portal-invitations",
                               json={"idChecked": True}).json()
    _sql(clinic, "UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :i",
         i=patient_id)
    for response in (
            client("fd").post(f"{API}/{patient_id}/portal-invitations", json={"idChecked": True}),
            client("fd").post(f"{API}/{patient_id}/portal-invitations/{issued['id']}/revoke"),
            client("fd").get(f"{API}/{patient_id}/portal-account")):
        assert response.status_code == 403, response.text
        assert response.json()["code"] == "break-glass-required"
    blocked = _sql(clinic, "SELECT count(*) AS n FROM audit.audit_event WHERE patient_id = :p "
                   "AND action = 'access-denied'", p=patient_id)
    assert blocked[0]["n"] == 3


def test_permissions_validation_and_another_clinic(client: Any,
                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    patient_id = _register(client)
    base = f"{API}/{patient_id}"
    issued = client("fd").post(f"{base}/portal-invitations", json={"idChecked": True}).json()
    for user in ("ma", "md", "bil"):
        assert client(user).post(f"{base}/portal-invitations",
                                 json={"idChecked": True}).status_code == 403
        assert client(user).post(
            f"{base}/portal-invitations/{issued['id']}/revoke").status_code == 403
        assert client(user).get(f"{base}/portal-account").status_code == 403
    assert client("fd").post(f"{base}/portal-invitations",
                             json={"idChecked": False}).status_code == 422
    assert client("fd").post(f"{base}/portal-invitations/x/revoke").status_code == 422
    assert client("fd").get(f"{API}/x/portal-account").status_code == 422
    # Clinic B can't see clinic A's patient, even with the permission.
    from app.core import permissions
    monkeypatch.setitem(permissions.ROLE_PERMISSIONS, "MD", permissions.ROLE_PERMISSIONS["MD"]
                        | {"portal-accounts:read", "portal-invitations:create"})
    assert client("md-b").get(f"{base}/portal-account").status_code == 404
    assert client("md-b").post(f"{base}/portal-invitations",
                               json={"idChecked": True}).status_code == 404
