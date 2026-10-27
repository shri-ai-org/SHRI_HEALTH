"""PR-1 endpoints against a live database, as shri_app, with the real FHIR write helpers
(app.db.fhir_store, #88) and the real reads (repository.py).

Runs only where ``TEST_DATABASE_URL`` is set **and** the helpers and 0007's columns exist, which
means main plus #52 → #69 → #74 → #88; elsewhere it is skipped. The chart check is core's (#83),
not in that chain, so here it allows every read; restricted charts are covered by the in-memory
tests until #83 lands. Synthetic data only.
"""

from __future__ import annotations

import importlib.util
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any
from uuid import UUID

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.db import Database
from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS, CurrentUser, current_user, tenant_db
from app.db.tests.conftest import (
    TEST_DATABASE_URL,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)
from app.main import create_app

from .. import access

HELPERS = importlib.util.find_spec("app.db.fhir_store") is not None

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not (HELPERS and TEST_DATABASE_URL),
                       reason="needs a test database and app.db.fhir_store (#88) with 0007 (#74)"),
]

MRN_SYSTEM = "urn:oid:2.16.840.1.113883.3.0000.7"


@pytest.fixture
def clinics() -> Iterator[dict[UUID, UUID]]:
    """A fresh tenant for each dev clinic (A and B), each with its MRN counter."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    mapping = {CLINIC_A: make_tenant(admin), CLINIC_B: make_tenant(admin)}
    with admin.begin() as c:
        for n, tenant in enumerate(mapping.values()):
            c.execute(text("INSERT INTO admin.mrn_counter (id, tenant_id, prefix, system) "
                           "VALUES (:i, :t, :p, :s)"),
                      {"i": uuid.uuid4(), "t": tenant, "p": f"TST{n}", "s": MRN_SYSTEM})
    yield mapping
    admin.dispose()


@pytest.fixture
def client(clinics: dict[UUID, UUID]) -> Iterator[Any]:
    """One app and one TestClient per test. The app gets its own Database (as shri_app), so its
    asyncpg connections live in the TestClient's event loop and close at its shutdown."""
    app: FastAPI = create_app(Settings(environment="test", auth_mode="dev_header"))
    database = Database(Settings(database_url=SecretStr(TEST_DATABASE_URL or "")))
    switch_to_role(database.engine.sync_engine, "shri_app")
    app.state.db = database

    async def live_db(user: CurrentUser = Depends(current_user)) -> AsyncIterator[AsyncSession]:
        async with database.tenant_session(clinics[user.organization_id], user.id) as session:
            yield session

    async def allow(db: AsyncSession, user: CurrentUser, patient_id: UUID) -> None:
        return None

    app.dependency_overrides[tenant_db] = live_db
    app.dependency_overrides[access.chart_check] = lambda: allow
    with TestClient(app, raise_server_exceptions=False) as test_client:
        def as_user(name: str) -> TestClient:
            test_client.headers["X-Dev-User"] = name
            return test_client
        yield as_user


def _body(family: str, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": {"family": family, "given": ["Mai", "Thi"], "suffix": "Jr."},
        "preferredName": "May",
        "previousNames": [{"family": f"{family}old", "given": ["Mai"]}],
        "birthDate": "1984-03-09",
        "gender": "female",
        "birthSex": "F",
        "genderIdentity": {"text": "Woman"},
        "race": {"ombCategories": ["2028-9"], "text": "Asian"},
        "ethnicity": {"ombCategories": ["2186-5"]},
        "preferredLanguage": "vi",
        "maritalStatus": "M",
        "occupation": {"text": "Teacher"},
        "phones": [{"number": "+12175550101", "use": "mobile", "textMessages": True},
                   {"number": "+12175550102", "use": "home"}],
        "emails": [{"address": "mai.test@example.com"}],
        "address": {"lines": ["12 Test Street"], "city": "Springfield", "state": "IL",
                    "postalCode": "62704", "country": "US"},
        "employer": {"name": "Test School District", "phone": "+12175550199"},
        "identifiers": [{"type": "DL", "system": "urn:oid:2.16.840.1.113883.4.3.17",
                         "value": f"TEST-DL-{uuid.uuid4().hex[:8]}"}],
    }
    body.update(extra)
    return body


def test_register_then_read_round_trips_every_field(client: Any) -> None:
    family = f"Nguyen{uuid.uuid4().hex[:6]}"
    created = client("fd").post("/api/v1/patients", json=_body(family))
    assert created.status_code == 201, created.text
    patient = created.json()
    assert patient["mrn"] == "TST0-000001"
    read = client("ma").get(f"/api/v1/patients/{patient['id']}")
    assert read.status_code == 200, read.text
    got = read.json()
    assert read.headers["ETag"] == created.headers["ETag"]
    assert got["name"] == {"family": family, "given": ["Mai", "Thi"], "suffix": "Jr."}
    assert got["preferredName"] == "May"
    assert got["previousNames"] == [{"family": f"{family}old", "given": ["Mai"]}]
    assert got["birthDate"] == "1984-03-09" and got["birthSex"] == "F"
    assert got["genderIdentity"] == {"text": "Woman"}
    assert got["race"] == {"ombCategories": ["2028-9"], "detailed": [], "text": "Asian"}
    assert got["ethnicity"]["ombCategories"] == ["2186-5"]
    assert got["preferredLanguage"] == "vi" and got["maritalStatus"] == "M"
    assert got["occupation"] == {"text": "Teacher"}
    assert got["phones"] == [
        {"number": "+12175550101", "use": "mobile", "textMessages": True},
        {"number": "+12175550102", "use": "home", "textMessages": False}]
    assert got["emails"] == [{"address": "mai.test@example.com"}]
    assert got["address"]["lines"] == ["12 Test Street"]
    assert got["employer"]["name"] == "Test School District"
    assert {i["type"] for i in got["identifiers"]} == {"MR", "DL"}
    assert got["restricted"] is False and got["active"] is True


def test_search_by_name_and_birth_date_by_mrn_and_by_phone(client: Any) -> None:
    family = f"Tran{uuid.uuid4().hex[:6]}"
    patient = client("fd").post("/api/v1/patients", json=_body(family)).json()
    for criteria in ({"family": family[:6], "birthDate": "1984-03-09"},
                     {"family": family, "given": "Ma"},
                     {"mrn": patient["mrn"]},
                     {"phone": "+12175550101", "family": family}):
        found = client("fd").post("/api/v1/patients/search", json={"criteria": criteria})
        assert found.status_code == 200, (criteria, found.text)
        ids = [i["id"] for i in found.json()["items"]]
        assert patient["id"] in ids, criteria
        mine = next(i for i in found.json()["items"] if i["id"] == patient["id"])
        assert mine["phoneLast4"] == "0101" and mine["mrn"] == patient["mrn"]


def test_the_duplicate_check_reads_the_real_pool(client: Any) -> None:
    family = f"Pham{uuid.uuid4().hex[:6]}"
    first = client("fd").post("/api/v1/patients", json=_body(family, identifiers=[]))
    assert first.status_code == 201, first.text
    again = client("fd").post("/api/v1/patients", json=_body(family, identifiers=[]))
    assert again.status_code == 409, again.text
    assert first.json()["id"] in again.json()["candidateIds"]


def test_identifiers_and_the_practices_mrn_system(client: Any) -> None:
    patient = client("fd").post("/api/v1/patients",
                                json=_body(f"Le{uuid.uuid4().hex[:6]}")).json()
    path = f"/api/v1/patients/{patient['id']}/identifiers"
    added = client("fd").post(path, json={"type": "PI", "system": "urn:oid:2.16.840.1.113883.3.1",
                                          "value": "TEST-PI-1"})
    assert added.status_code == 201, added.text
    listed = client("fd").get(path).json()["items"]
    assert [i["type"] for i in listed][0] == "MR"
    assert {i["value"] for i in listed} >= {"TEST-PI-1", patient["mrn"]}
    refused = client("fd").post(path, json={"type": "PI", "system": MRN_SYSTEM,
                                            "value": "TST0-999999"})
    assert refused.status_code == 422, refused.text


def test_related_person_add_list_patch_and_if_match(client: Any) -> None:
    patient = client("fd").post("/api/v1/patients",
                                json=_body(f"Vo{uuid.uuid4().hex[:6]}")).json()
    base = f"/api/v1/patients/{patient['id']}/related-persons"
    added = client("fd").post(base, json={
        "name": {"family": "Vo", "given": ["Binh"]},
        "relationships": [{"system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
                           "code": "EMC", "display": "emergency contact"}],
        "phones": [{"number": "+12175550177"}],
        "employer": {"name": "Test Hospital"}})
    assert added.status_code == 201, added.text
    related = added.json()
    assert related["relationships"][0]["code"] == "EMC"
    assert client("fd").get(base).json()["items"][0]["id"] == related["id"]
    path = f"{base}/{related['id']}"
    etag = added.headers["ETag"]
    patched = client("fd").patch(path, json={"phones": [{"number": "+12175550178"}]},
                                 headers={"If-Match": etag})
    assert patched.status_code == 200, patched.text
    assert patched.json()["phones"][0]["number"] == "+12175550178"
    assert patched.headers["ETag"] != etag
    stale = client("fd").patch(path, json={"active": False}, headers={"If-Match": etag})
    assert stale.status_code == 412
    assert stale.headers["ETag"] == patched.headers["ETag"]


def test_another_clinics_patient_is_not_found(client: Any) -> None:
    patient = client("fd").post("/api/v1/patients",
                                json=_body(f"Ho{uuid.uuid4().hex[:6]}")).json()
    for path in ("", "/identifiers", "/related-persons"):
        assert client("md-b").get(f"/api/v1/patients/{patient['id']}{path}").status_code == 404
    search = client("md-b").post("/api/v1/patients/search",
                                 json={"criteria": {"mrn": patient["mrn"]}})
    assert search.status_code == 200 and search.json()["items"] == []


def test_a_restricted_label_reads_back(client: Any, clinics: dict[UUID, UUID]) -> None:
    patient = client("fd").post("/api/v1/patients",
                                json=_body(f"Do{uuid.uuid4().hex[:6]}")).json()
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_app")
    session = open_session(engine, clinics[CLINIC_A], DEV_USERS["fd"].id)
    session.execute(text("UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :i"),
                    {"i": patient["id"]})
    session.commit()
    session.close()
    engine.dispose()
    got = client("fd").get(f"/api/v1/patients/{patient['id']}").json()
    assert got["restricted"] is True
