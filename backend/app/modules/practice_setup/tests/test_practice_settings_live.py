"""The practice settings (getPracticeSettings, updatePracticeSettings; A49, D39) against a live
database, as shri_app, with nothing replaced but the sign-in: core's tenant_db (row-level
security, audit) and the real repository. Each test gets two fresh clinics. Runs where
``TEST_DATABASE_URL`` is set. Synthetic data only.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import DEV_USER_HEADER, CurrentUser, current_user
from app.db.tests import builders as b
from app.db.tests.conftest import (
    TEST_DATABASE_URL,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)
from app.main import create_app

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
M = b.M
URL = "/api/v1/practice-settings"
PATCH = {"Content-Type": "application/merge-patch+json"}
SHOW = {"registration": {"showSexualOrientationAndGenderIdentity": True}}


@pytest.fixture
def engines() -> Iterator[tuple[Engine, Engine]]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    app_engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(app_engine, "shri_app")
    yield admin, app_engine
    admin.dispose()
    app_engine.dispose()


def _clinic(admin: Engine, app_engine: Engine, prefix: str | None) -> dict[str, Any]:
    """A practice with its user and facility, and its MRN counter (as onboarding makes it)
    unless ``prefix`` is None."""
    tenant = make_tenant(admin)
    db = open_session(app_engine, tenant)
    ctx = b.practice(db)
    if prefix is not None:
        db.add(M["mrn_counter"](prefix=prefix, system=f"urn:oid:2.16.840.1.113883.3.0000.{prefix}"))
    db.commit()
    out = {"tenant": tenant, "user": ctx["user"].id, "facility": ctx["facility"].id}
    conn = db.bind
    db.close()
    conn.close()  # type: ignore[union-attr]
    return out


@pytest.fixture
def clinics(engines: tuple[Engine, Engine]) -> dict[str, dict[str, Any]]:
    admin, app_engine = engines
    tag = uuid.uuid4().hex[:4].upper()
    return {"a": _clinic(admin, app_engine, f"A{tag}"), "b": _clinic(admin, app_engine, f"B{tag}"),
            "none": _clinic(admin, app_engine, None)}


def _user(clinic: dict[str, Any], roles: set[str]) -> CurrentUser:
    return CurrentUser(id=clinic["user"], organization_id=clinic["tenant"],
                       roles=frozenset(roles), facility_ids=frozenset({clinic["facility"]}),
                       display_name="Live test user")


@pytest.fixture
def client(clinics: dict[str, dict[str, Any]]) -> Iterator[Any]:
    users = {"adm": _user(clinics["a"], {"ADM"}), "co": _user(clinics["a"], {"CO"}),
             "fd": _user(clinics["a"], {"FD"}), "adm-b": _user(clinics["b"], {"ADM"}),
             "adm-none": _user(clinics["none"], {"ADM"})}
    app: FastAPI = create_app(Settings(environment="test", auth_mode="dev_header",
                                       database_url=TEST_DATABASE_URL))
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


def _audit(admin: Engine, tenant: UUID) -> list[tuple[str, str]]:
    with admin.connect() as c:
        return [(r.action, r.category) for r in c.execute(text(
            "SELECT action, category FROM audit.audit_event WHERE tenant_id = :t "
            "AND entity_type = 'practice-settings' ORDER BY chain_seq"), {"t": tenant})]


def test_the_default_then_a_change_with_its_etag(client: Any, clinics: dict[str, Any],
                                                 engines: tuple[Engine, Engine]) -> None:
    first = client("adm").get(URL)
    assert first.status_code == 200, first.text
    assert first.headers["ETag"] == '"0"'                       # never set: the default
    body = first.json()
    assert body["registration"] == {"showSexualOrientationAndGenderIdentity": False}
    assert body["mrnPrefix"].startswith("A") and body["mrnSystem"].startswith("urn:oid:")
    assert body["updatedAt"].endswith("Z")

    changed = client("adm").patch(URL, json=SHOW, headers={**PATCH, "If-Match": '"0"'})
    assert changed.status_code == 200, changed.text
    assert changed.headers["ETag"] == '"1"'
    assert changed.json()["registration"]["showSexualOrientationAndGenderIdentity"] is True
    back = client("adm").patch(URL, json={"registration": {
        "showSexualOrientationAndGenderIdentity": False}}, headers={**PATCH, "If-Match": '"1"'})
    assert back.status_code == 200 and back.headers["ETag"] == '"2"'
    same = client("adm").patch(URL, json={"registration": {
        "showSexualOrientationAndGenderIdentity": False}}, headers={**PATCH, "If-Match": '"2"'})
    assert same.status_code == 200 and same.headers["ETag"] == '"2"'    # nothing changed

    me = client("adm").get("/api/v1/me").json()                 # every screen reads it here
    assert me["practiceSettings"]["registration"] == {
        "showSexualOrientationAndGenderIdentity": False}
    # x-audit: each read is R/admin, each change U/admin (config-change), in order
    assert _audit(engines[0], clinics["a"]["tenant"]) == [
        ("read", "admin"), ("config-change", "admin"), ("config-change", "admin"),
        ("config-change", "admin")]


def test_if_match_is_required_and_a_stale_one_is_refused(client: Any) -> None:
    missing = client("adm").patch(URL, json=SHOW, headers=PATCH)
    assert missing.status_code == 428 and missing.json()["code"] == "precondition-required"
    weak = client("adm").patch(URL, json=SHOW, headers={**PATCH, "If-Match": 'W/"0"'})
    assert weak.status_code == 412
    assert client("adm").patch(URL, json=SHOW, headers={**PATCH, "If-Match": '"0"'}
                               ).status_code == 200
    stale = client("adm").patch(URL, json=SHOW, headers={**PATCH, "If-Match": '"0"'})
    assert stale.status_code == 412 and stale.json()["code"] == "precondition-failed"
    assert stale.headers["ETag"] == '"1"'                        # so the client can re-read


@pytest.mark.parametrize(("body", "pointer"), [
    ({}, ""),
    ({"registration": {}}, "/registration"),
    ({"registration": None}, "/registration"),
    ({"registration": {"showSexualOrientationAndGenderIdentity": None}},
     "/registration/showSexualOrientationAndGenderIdentity"),
])
def test_an_empty_or_null_patch_is_refused(client: Any, body: dict[str, Any],
                                           pointer: str) -> None:
    refused = client("adm").patch(URL, json=body, headers={**PATCH, "If-Match": '"0"'})
    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "validation-failed"
    assert [e["pointer"] for e in refused.json()["errors"]] == [pointer]


@pytest.mark.parametrize("body", [
    {"registration": {"showSexualOrientationAndGenderIdentity": "yes"}},
    {"registration": {"showSexualOrientationAndGenderIdentity": True, "other": 1}},
    {"mrnPrefix": "ZZ"},                                         # read-only: set at onboarding
])
def test_a_wrong_type_unknown_or_read_only_field_is_refused(client: Any,
                                                            body: dict[str, Any]) -> None:
    refused = client("adm").patch(URL, json=body, headers={**PATCH, "If-Match": '"0"'})
    assert refused.status_code == 422, refused.text


def test_who_may_read_and_who_may_change(client: Any) -> None:
    assert client("co").get(URL).status_code == 200              # CO reads practice setup
    assert client("fd").get(URL).status_code == 403
    denied = client("co").patch(URL, json=SHOW, headers={**PATCH, "If-Match": '"0"'})
    assert denied.status_code == 403 and denied.json()["code"] == "permission-denied"


def test_each_clinic_has_its_own_settings(client: Any) -> None:
    assert client("adm").patch(URL, json=SHOW, headers={**PATCH, "If-Match": '"0"'}
                               ).status_code == 200
    other = client("adm-b").get(URL)
    assert other.headers["ETag"] == '"0"'
    assert other.json()["registration"]["showSexualOrientationAndGenderIdentity"] is False
    assert other.json()["mrnPrefix"].startswith("B")


def test_a_practice_without_an_mrn_counter_is_a_server_error(client: Any) -> None:
    """Onboarding creates the counter with the practice (D41); without one, nothing is shown."""
    assert client("adm-none").get(URL).status_code == 500
