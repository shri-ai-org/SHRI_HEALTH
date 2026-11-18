"""listConsentRequirements (D59) against a live database, as shri_app, with nothing replaced but the
sign-in: core's require() and tenant_db (row-level security, audit) and the real read. Uses the
practice-setup live fixtures (two fresh clinics per test). Synthetic data only: invented titles
and versions, no legal wording, no patient data."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine, text

from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.practice_setup.tests.test_practice_setup_live import (  # noqa: F401
    _get,
    _walk,
    client,
    engines,
    users,
    world,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
PATH = "/api/v1/consent-requirements"


def _requirement(admin: Engine, tenant: UUID, kind: str, version: str, *, required: bool,
                 active: bool = True) -> str:
    rid = uuid.uuid4()
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.consent_requirement (id, tenant_id, kind, title, policy_version, "
            "is_required, effective_date, is_active) VALUES (:i, :t, :k, :n, :v, :r, :d, :a)"),
            {"i": rid, "t": tenant, "k": kind, "n": f"Demo {kind} (synthetic)", "v": version,
             "r": required, "d": dt.date(2026, 10, 1), "a": active})
    return str(rid)


@pytest.fixture
def requirements(world: dict[str, Any],  # noqa: F811
                 engines: tuple[Engine, Engine]) -> dict[str, Any]:  # noqa: F811
    admin, _ = engines
    a, b = world["a"]["tenant"], world["b"]["tenant"]
    return {
        "treatment": _requirement(admin, a, "treatment", "2026-10", required=True),
        "privacy-old": _requirement(admin, a, "privacy-notice", "2026-01", required=True,
                                    active=False),
        "privacy": _requirement(admin, a, "privacy-notice", "2026-10", required=True),
        "telehealth": _requirement(admin, a, "telehealth", "2026-10", required=False),
        "financial": _requirement(admin, a, "financial", "2026-10", required=True),
        "b": _requirement(admin, b, "treatment", "2026-11", required=True),
    }


def test_the_clinics_current_requirements_by_kind_then_version(
        client: Any, requirements: dict[str, Any]) -> None:  # noqa: F811
    items = _get(client, "fd", PATH)["items"]
    assert [i["id"] for i in items] == [requirements[k] for k in (
        "financial", "privacy", "telehealth", "treatment")]
    privacy = items[1]
    assert privacy == {
        "id": requirements["privacy"], "kind": "privacy-notice",
        "title": "Demo privacy-notice (synthetic)", "policyVersion": "2026-10",
        "required": True, "effectiveDate": "2026-10-01", "active": True,
        "createdAt": privacy["createdAt"], "updatedAt": privacy["updatedAt"]}
    assert [i["required"] for i in items] == [True, True, False, True]
    assert "nextCursor" not in _get(client, "fd", PATH)


def test_filters_and_retired_versions(client: Any,  # noqa: F811
                                      requirements: dict[str, Any]) -> None:
    def ids(**params: Any) -> list[str]:
        return [i["id"] for i in _get(client, "adm", PATH, **params)["items"]]

    assert ids(kind="privacy-notice") == [requirements["privacy"]]
    assert ids(active="false") == [requirements["privacy-old"]]
    assert ids(kind="privacy-notice", active="false") == [requirements["privacy-old"]]
    assert client("adm").get(PATH, params={"kind": "portal-terms"}).status_code == 422


def test_paging_walks_every_row_once(client: Any,  # noqa: F811
                                     requirements: dict[str, Any]) -> None:
    everything = [i["id"] for i in _get(client, "fd", PATH)["items"]]
    for limit in (1, 3):
        assert _walk(client, "fd", PATH, limit) == everything


def test_only_the_callers_clinic(client: Any, requirements: dict[str, Any]) -> None:  # noqa: F811
    mine = {i["id"] for i in _get(client, "co", PATH)["items"]}
    theirs = {i["id"] for i in _get(client, "adm-b", PATH)["items"]}
    assert theirs == {requirements["b"]}
    assert requirements["b"] not in mine and not mine & theirs


def test_front_desk_admin_and_compliance_read_others_are_403(
        client: Any, requirements: dict[str, Any]) -> None:  # noqa: F811
    for user in ("fd", "adm", "co"):
        assert client(user).get(PATH).status_code == 200, user
    for user in ("md", "bil"):
        response = client(user).get(PATH)
        assert response.status_code == 403, user
        assert response.json()["code"] == "permission-denied"


def test_the_read_is_audited_and_writes_nothing(
        client: Any, requirements: dict[str, Any], world: dict[str, Any],  # noqa: F811
        engines: tuple[Engine, Engine]) -> None:  # noqa: F811
    admin, _ = engines
    tenant = world["a"]["tenant"]

    def state() -> tuple[Any, ...]:
        with admin.connect() as c:
            return tuple(c.execute(text(
                "SELECT count(*), max(updated_at), max(version) FROM admin.consent_requirement "
                "WHERE tenant_id = :t"), {"t": tenant}).one())
    before = state()
    _get(client, "fd", PATH)
    assert state() == before
    with admin.connect() as c:
        rows = c.execute(text(
            "SELECT action, category, patient_id FROM audit.audit_event WHERE tenant_id = :t "
            "AND entity_type = 'consent-requirements'"), {"t": tenant}).all()
    assert [(r.action, r.category, r.patient_id) for r in rows] == [("read", "admin", None)]
