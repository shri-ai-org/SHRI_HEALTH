"""One facility's read and update (getFacility, updateFacility) against a live database, as
shri_app, with nothing replaced but the sign-in: core's tenant_db (row-level security, audit) and
the real repository. Each test gets two fresh clinics. Runs where ``TEST_DATABASE_URL`` is set.
Synthetic data only.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import DEV_USER_HEADER, CurrentUser, current_user
from app.db.tests import builders as b
from app.db.tests.audit_coverage import audit_problems
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
PATCH = {"Content-Type": "application/merge-patch+json"}
ADDRESS = {"lines": ["300 Sample Road", "Suite 2"], "city": "San Jose", "state": "CA",
           "postalCode": "95126", "country": "US"}


@pytest.fixture
def engines() -> Iterator[tuple[Engine, Engine]]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    app_engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(app_engine, "shri_app")
    yield admin, app_engine
    admin.dispose()
    app_engine.dispose()


def _clinic(admin: Engine, app_engine: Engine) -> dict[str, Any]:
    """A practice with its user and "Main office", whose site has an address and a phone."""
    tenant = make_tenant(admin)
    db = open_session(app_engine, tenant)
    ctx = b.practice(db)
    site = ctx["facility"].location_id
    db.add_all([
        M["address"](location_id=site, line=["200 Test Avenue"], city="San Jose", state="CA",
                     postal_code="95126", country="US", use="work"),
        M["contact_point"](location_id=site, system="phone", value="+12175550110", rank=1),
        M["contact_point"](location_id=site, system="email", value="desk@example.test", rank=2),
    ])
    db.commit()
    out = {"tenant": tenant, "user": ctx["user"].id, "facility": ctx["facility"].id,
           "site": site}
    conn = db.bind
    db.close()
    conn.close()  # type: ignore[union-attr]
    return out


@pytest.fixture
def clinics(engines: tuple[Engine, Engine]) -> dict[str, dict[str, Any]]:
    admin, app_engine = engines
    return {"a": _clinic(admin, app_engine), "b": _clinic(admin, app_engine)}


def _user(clinic: dict[str, Any], roles: set[str], facilities: set[Any] | None = None
          ) -> CurrentUser:
    return CurrentUser(id=clinic["user"], organization_id=clinic["tenant"],
                       roles=frozenset(roles),
                       facility_ids=frozenset(facilities if facilities is not None
                                              else {clinic["facility"]}),
                       display_name="Live test user")


@pytest.fixture
def client(clinics: dict[str, dict[str, Any]]) -> Iterator[Any]:
    a, other = clinics["a"], clinics["b"]
    users = {"adm": _user(a, {"ADM"}), "co": _user(a, {"CO"}),
             "adm-elsewhere": _user(a, {"ADM"}, set()),                  # no facility of A
             "adm-b": _user(other, {"ADM"}, {other["facility"], a["facility"]})}
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


def _url(clinic: dict[str, Any]) -> str:
    return f"/api/v1/facilities/{clinic['facility']}"


def _patch(client: Any, user: str, url: str, body: dict[str, Any], etag: str) -> Any:
    return client(user).patch(url, json=body, headers={**PATCH, "If-Match": etag})


def test_read_then_change_the_facility_and_its_site(client: Any, clinics: dict[str, Any],
                                                    engines: tuple[Engine, Engine]) -> None:
    url = _url(clinics["a"])
    got = client("adm").get(url)
    assert got.status_code == 200, got.text
    assert got.json()["phone"] == "+12175550110" and got.json()["address"]["city"] == "San Jose"
    etag = got.headers["ETag"]

    changed = _patch(client, "adm", url, {"name": "Main office (renamed)", "npi": "1234567893",
                                          "placeOfServiceCode": "22", "billingLocation": False},
                     etag)
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert (body["name"], body["npi"], body["placeOfServiceCode"], body["billingLocation"]) == (
        "Main office (renamed)", "1234567893", "22", False)
    assert body["code"] == got.json()["code"] and body["phone"] == "+12175550110"  # unchanged
    assert changed.headers["ETag"] != etag

    site = _patch(client, "adm", url, {"address": ADDRESS, "phone": "+12175550199"},
                  changed.headers["ETag"])
    assert site.status_code == 200, site.text
    assert site.json()["address"] == ADDRESS and site.json()["phone"] == "+12175550199"
    assert site.headers["ETag"] != changed.headers["ETag"]        # the site's change moves it
    assert client("adm").get(url).json() == site.json()
    with engines[0].connect() as c:          # one address and one phone; the email is kept
        kinds = sorted(r.system for r in c.execute(text(
            "SELECT system FROM clinical.contact_point WHERE location_id = :l"),
            {"l": clinics["a"]["site"]}))
        assert kinds == ["email", "phone"]
        assert c.execute(text("SELECT count(*) FROM clinical.address WHERE location_id = :l"),
                         {"l": clinics["a"]["site"]}).scalar_one() == 1
        audit = [tuple(r) for r in c.execute(text(
            "SELECT action, category FROM audit.audit_event WHERE tenant_id = :t "
            "AND entity_type = 'facilities' ORDER BY chain_seq"), {"t": clinics["a"]["tenant"]})]
    assert audit[:2] == [("read", "admin"), ("config-change", "admin")]


def test_if_match_is_required_and_a_stale_one_is_refused(client: Any,
                                                         clinics: dict[str, Any]) -> None:
    url = _url(clinics["a"])
    etag = client("adm").get(url).headers["ETag"]
    missing = client("adm").patch(url, json={"name": "X"}, headers=PATCH)
    assert missing.status_code == 428
    assert _patch(client, "adm", url, {"name": "First"}, etag).status_code == 200
    stale = _patch(client, "adm", url, {"name": "Second"}, etag)
    assert stale.status_code == 412 and stale.headers["ETag"] != etag
    assert client("adm").get(url).json()["name"] == "First"


@pytest.mark.parametrize(("body", "pointer"), [
    ({}, ""),
    ({"npi": None}, "/npi"),
    ({"timeZone": "Mars/Olympus_Mons"}, "/timeZone"),
    ({"npi": "1234567890"}, "/npi"),                              # fails the NPI check digit
])
def test_an_invalid_patch_is_refused(client: Any, clinics: dict[str, Any],
                                     body: dict[str, Any], pointer: str) -> None:
    url = _url(clinics["a"])
    etag = client("adm").get(url).headers["ETag"]
    refused = _patch(client, "adm", url, body, etag)
    assert refused.status_code == 422, refused.text
    assert [e["pointer"] for e in refused.json()["errors"]] == [pointer]
    assert client("adm").get(url).headers["ETag"] == etag         # nothing written


@pytest.mark.parametrize("body", [
    {"code": "NEW"},                                              # fixed once created
    {"phone": "217-555-0100"},                                    # not E.164
    {"address": {**ADDRESS, "country": "CA"}},
    {"cliaNumber": "12X1234567"},
])
def test_a_read_only_unknown_or_malformed_field_is_refused(client: Any, clinics: dict[str, Any],
                                                           body: dict[str, Any]) -> None:
    url = _url(clinics["a"])
    etag = client("adm").get(url).headers["ETag"]
    assert _patch(client, "adm", url, body, etag).status_code == 422


def test_who_may_read_and_change_which_facility(client: Any, clinics: dict[str, Any]) -> None:
    url = _url(clinics["a"])
    etag = client("co").get(url).headers["ETag"]                  # CO reads practice setup
    denied = _patch(client, "co", url, {"name": "X"}, etag)
    assert denied.status_code == 403 and denied.json()["code"] == "permission-denied"
    assert client("adm-elsewhere").get(url).status_code == 404    # not one of the user's
    assert client("adm-b").get(url).status_code == 404            # another clinic's (RLS)
    assert _patch(client, "adm-b", url, {"name": "X"}, etag).status_code == 404


def test_a_facility_change_is_audited_as_a_config_change(client: Any, clinics: dict[str, Any],
                                                         engines: tuple[Engine, Engine]) -> None:
    a = clinics["a"]
    etag = client("adm").get(_url(a)).headers["ETag"]
    changed = _patch(client, "adm", _url(a), {"name": "Main office (audited)"}, etag)

    assert changed.status_code == 200, changed.text
    assert audit_problems(engines[0], changed, "updateFacility", tenant=a["tenant"],
                          entity=a["facility"]) == []
