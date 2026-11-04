"""GET /me against the real schema, as shri_app: every role's permissions straight from
ROLE_PERMISSIONS, the clinic's own name, the D39 practice setting, and a clinician's own
practitioner (never another clinic's).

Needs TEST_DATABASE_URL, migrated to head (app/db/tests/conftest.py). Skipped otherwise.
Synthetic users and clinics only.
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
import yaml  # type: ignore[import-untyped]
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from app.core import permissions
from app.core.config import Settings
from app.core.deps import CurrentUser, current_user
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    make_tenant,
    switch_to_role,
    tenant,
)
from app.main import create_app

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

FACILITY = UUID("fa000000-0000-4000-8000-0000000000f1")
PLATFORM = Path(__file__).resolve().parents[4] / "contracts/openapi/modules/platform.yaml"


def _schema(name: str) -> dict[str, Any]:
    schemas: dict[str, Any] = yaml.safe_load(PLATFORM.read_text())["components"]["schemas"]
    schema: dict[str, Any] = schemas[name]
    return schema


def _user(tenant_id: UUID, roles: set[str]) -> CurrentUser:
    return CurrentUser(id=uuid4(), organization_id=tenant_id, roles=frozenset(roles),
                       facility_ids=frozenset({FACILITY}), display_name="Dev User")


@pytest.fixture
def signed_in() -> dict[str, CurrentUser]:
    return {}


@pytest.fixture
def client(signed_in: dict[str, CurrentUser]) -> Iterator[TestClient]:
    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    app.dependency_overrides[current_user] = lambda: signed_in["user"]
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
        assert c.portal is not None
        c.portal.call(app.state.db.dispose)


@pytest.mark.parametrize("role", sorted(permissions.ROLES))
def test_each_role_gets_exactly_its_permissions(client: TestClient, signed_in: dict[str, Any],
                                                tenant: UUID, role: str) -> None:  # noqa: F811
    user = _user(tenant, {role})
    signed_in["user"] = user

    response = client.get("/api/v1/me")

    assert response.status_code == 200
    body = response.json()
    assert body["permissions"] == sorted(permissions.ROLE_PERMISSIONS[role])
    assert len(body["permissions"]) <= _schema("Me")["properties"]["permissions"]["maxItems"]
    assert body["user"] == {"id": str(user.id), "displayName": "Dev User", "roles": [role],
                            "facilityIds": [str(FACILITY)]}
    assert body["organization"] == {"id": str(tenant), "name": "Test practice"}
    assert set(_schema("Me")["required"]) <= set(body)
    assert set(body) <= set(_schema("Me")["properties"])


def test_two_roles_get_the_union(client: TestClient, signed_in: dict[str, Any],
                                 tenant: UUID) -> None:  # noqa: F811
    signed_in["user"] = _user(tenant, {"FD", "BIL"})

    body = client.get("/api/v1/me").json()

    assert body["permissions"] == sorted(permissions.ROLE_PERMISSIONS["FD"]
                                         | permissions.ROLE_PERMISSIONS["BIL"])
    assert body["user"]["roles"] == ["BIL", "FD"]


def test_no_roles_is_signed_in_with_no_permissions(client: TestClient, signed_in: dict[str, Any],
                                                   tenant: UUID) -> None:  # noqa: F811
    signed_in["user"] = _user(tenant, set())

    response = client.get("/api/v1/me")

    assert response.status_code == 200
    assert response.json()["permissions"] == []


def test_practice_setting_defaults_off_then_follows_the_practice(
        client: TestClient, signed_in: dict[str, Any], tenant: UUID,  # noqa: F811
        admin_engine: Engine) -> None:  # noqa: F811
    signed_in["user"] = _user(tenant, {"FD"})
    other = make_tenant(admin_engine)

    def shown() -> bool:
        flag: bool = client.get("/api/v1/me").json()["practiceSettings"]["registration"][
            "showSexualOrientationAndGenderIdentity"]
        return flag

    assert shown() is False  # D39: off until the practice turns it on
    with admin_engine.begin() as c:  # another clinic turning it on changes nothing here
        c.execute(text("INSERT INTO admin.tenant_setting (id, tenant_id, setting_key, value) "
                       "VALUES (:i, :t, 'registration.show_sogi_fields', 'true')"),
                  {"i": uuid4(), "t": other})
    assert shown() is False
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.tenant_setting (id, tenant_id, setting_key, value) "
                       "VALUES (:i, :t, 'registration.show_sogi_fields', 'true')"),
                  {"i": uuid4(), "t": tenant})
    assert shown() is True


def test_shows_only_the_users_own_clinic(client: TestClient, signed_in: dict[str, Any],
                                         admin_engine: Engine) -> None:  # noqa: F811
    mine = make_tenant(admin_engine)
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.tenant SET name = 'Clinic Mine' WHERE id = :t"), {"t": mine})
    make_tenant(admin_engine)
    signed_in["user"] = _user(mine, {"MD"})

    assert client.get("/api/v1/me").json()["organization"] == {"id": str(mine),
                                                               "name": "Clinic Mine"}


def _clinician(engine: Engine, tenant_id: UUID) -> tuple[UUID, UUID]:
    """A synthetic user linked to their own practitioner in that clinic: (user, practitioner)."""
    user, practitioner = uuid4(), uuid4()
    with engine.begin() as c:
        c.execute(text("INSERT INTO clinical.practitioner (id, tenant_id, active) "
                       "VALUES (:p, :t, true)"), {"p": practitioner, "t": tenant_id})
        c.execute(text("INSERT INTO admin.app_user (id, tenant_id, display_name, "
                       "keycloak_subject, username, practitioner_id) "
                       "VALUES (:i, :t, 'Dev User', :k, :u, :p)"),
                  {"i": user, "t": tenant_id, "k": str(uuid4()), "u": f"u-{user.hex[:12]}",
                   "p": practitioner})
    return user, practitioner


def test_a_clinician_gets_their_own_practitioner(client: TestClient, signed_in: dict[str, Any],
                                                 tenant: UUID,  # noqa: F811
                                                 admin_engine: Engine) -> None:  # noqa: F811
    """"My Day" filters the schedule by the user's own practitioner (providerId)."""
    user, practitioner = _clinician(admin_engine, tenant)
    signed_in["user"] = CurrentUser(id=user, organization_id=tenant, roles=frozenset({"MD"}),
                                    facility_ids=frozenset({FACILITY}), display_name="Dev User")

    body = client.get("/api/v1/me").json()

    assert body["user"]["practitionerId"] == str(practitioner)
    assert set(body["user"]) <= set(_schema("SessionUser")["properties"])


def test_another_clinics_practitioner_link_is_never_shown(
        client: TestClient, signed_in: dict[str, Any], tenant: UUID,  # noqa: F811
        admin_engine: Engine) -> None:  # noqa: F811
    """Row-level security: the same user ID signed in to this clinic can't read a link that
    lives in another clinic's app_user row."""
    other = make_tenant(admin_engine)
    user, _ = _clinician(admin_engine, other)
    signed_in["user"] = CurrentUser(id=user, organization_id=tenant, roles=frozenset({"MD"}),
                                    facility_ids=frozenset({FACILITY}), display_name="Dev User")

    body = client.get("/api/v1/me").json()

    assert "practitionerId" not in body["user"]
