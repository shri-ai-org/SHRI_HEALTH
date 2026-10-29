"""PR-1 endpoints against a live database, as shri_app, with nothing replaced but the sign-in:
core's tenant_db, chart check (#83) and audit (#79), Anand's FHIR write helpers (#88) and the real
reads (repository.py). Each test gets fresh clinics, with a real user per dev user name. Runs
where ``TEST_DATABASE_URL`` is set. Synthetic data only.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import CLINIC_A, CLINIC_B, DEV_USER_HEADER, DEV_USERS, CurrentUser, current_user
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
SIGNS_IN_AS = ("fd", "ma", "md", "adm", "bil", "none", "md-b")

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
def users(clinics: dict[UUID, UUID]) -> dict[str, CurrentUser]:
    """A real user in its fresh clinic for each dev user name, with that dev user's roles."""
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_app")
    signed: dict[str, CurrentUser] = {}
    for name in SIGNS_IN_AS:
        dev = DEV_USERS[name]
        session = open_session(engine, clinics[dev.organization_id])
        made = b.practitioner(session, "Lindqvist58", name.replace("-", ""))
        session.commit()
        signed[name] = CurrentUser(id=made["user"].id, organization_id=clinics[dev.organization_id],
                                   roles=dev.roles, facility_ids=dev.facility_ids,
                                   display_name=dev.display_name)
        session.close()
    engine.dispose()
    return signed


@pytest.fixture
def client(users: dict[str, CurrentUser]) -> Iterator[Any]:
    """One app and one TestClient per test, on the test database as shri_app. Only the sign-in is
    replaced: ``X-Dev-User`` names one of ``users``."""
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


def test_a_restricted_chart_needs_break_glass_but_search_still_finds_it(
        client: Any, clinics: dict[UUID, UUID], users: dict[str, CurrentUser]) -> None:
    patient = client("fd").post("/api/v1/patients",
                                json=_body(f"Do{uuid.uuid4().hex[:6]}")).json()
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_app")
    session = open_session(engine, clinics[CLINIC_A], users["fd"].id)
    session.execute(text("UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :i"),
                    {"i": patient["id"]})
    session.commit()
    session.close()
    engine.dispose()
    refused = client("md").get(f"/api/v1/patients/{patient['id']}")
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    found = client("fd").post("/api/v1/patients/search",
                              json={"criteria": {"mrn": patient["mrn"]}}).json()["items"]
    assert [f["restricted"] for f in found] == [True]  # search is a front-desk exception (§5.2)


def test_update_patient_against_the_real_helpers(client: Any) -> None:
    family = f"Bui{uuid.uuid4().hex[:6]}"
    created = client("fd").post("/api/v1/patients", json=_body(family))
    path = f"/api/v1/patients/{created.json()['id']}"
    patched = client("fd").patch(path, json={
        "preferredName": None, "previousNames": [], "maritalStatus": "S",
        "phones": [{"number": "+12175550123", "use": "home"}], "employer": None},
        headers={"If-Match": created.headers["ETag"],
                 "Content-Type": "application/merge-patch+json"})
    assert patched.status_code == 200, patched.text
    got = client("ma").get(path).json()
    assert got["name"]["family"] == family  # untouched
    assert "preferredName" not in got and got["previousNames"] == []
    assert got["maritalStatus"] == "S" and "employer" not in got
    assert got["phones"] == [{"number": "+12175550123", "use": "home", "textMessages": False}]
    assert got["emails"] == [{"address": "mai.test@example.com"}]  # kept: only phones were sent
    stale = client("fd").patch(path, json={"maritalStatus": "M"},
                               headers={"If-Match": created.headers["ETag"]})
    assert stale.status_code == 412 and stale.headers["ETag"] == patched.headers["ETag"]


def test_restrict_unrestrict_and_summaries(client: Any) -> None:
    first = client("fd").post("/api/v1/patients", json=_body(f"Ly{uuid.uuid4().hex[:6]}")).json()
    second = client("fd").post("/api/v1/patients", json=_body(
        f"Ngo{uuid.uuid4().hex[:6]}", birthDate="1990-01-01", phones=[], identifiers=[])).json()
    base = f"/api/v1/patients/{first['id']}"
    restricted = client("adm").post(f"{base}/restrict",
                                    json={"category": "sensitive", "reason": "Test reason."})
    assert restricted.status_code == 200, restricted.text
    assert restricted.json()["category"] == "sensitive"
    summaries = client("ma").post("/api/v1/patients/summaries", json={
        "patientIds": [second["id"], first["id"], str(uuid.uuid4())]}).json()["items"]
    assert [s["id"] for s in summaries] == [second["id"], first["id"]]
    assert summaries[1]["restricted"] is True
    lifted = client("adm").post(f"{base}/unrestrict", json={"reason": "Test reason."})
    assert lifted.status_code == 200 and lifted.json()["restricted"] is False
    assert client("ma").get(base).json()["restricted"] is False
    assert client("md-b").post("/api/v1/patients/summaries",
                               json={"patientIds": [first["id"]]}).json()["items"] == []


# Safe retries (ADR-0007, T21): core's tenant_db claims the key and stores the response as Transit
# ciphertext, so this needs OpenBao; it skips without it, as core's own tests do; CI requires it.
@pytest.mark.skipif(not os.environ.get("OPENBAO_TRANSIT_ADDR")
                    and os.environ.get("REQUIRE_OPENBAO") != "1",
                    reason="OPENBAO_TRANSIT_ADDR not set (the stored response is encrypted)")
def test_a_keyed_registration_is_replayed_not_repeated(client: Any) -> None:
    family = f"Kim{uuid.uuid4().hex[:6]}"
    key = {"Idempotency-Key": str(uuid.uuid4())}
    body = _body(family)  # one body, sent twice (_body draws a new license number each call)
    first = client("fd").post("/api/v1/patients", json=body, headers=key)
    assert first.status_code == 201, first.text
    replay = client("fd").post("/api/v1/patients", json=body, headers=key)
    assert replay.status_code == 201 and replay.headers["Idempotent-Replayed"] == "true"
    assert replay.json() == first.json()  # the same patient and MRN: registered once
    reused = client("fd").post("/api/v1/patients", json=_body(f"{family}x"), headers=key)
    assert reused.status_code == 422 and reused.json()["code"] == "idempotency-key-reused"
    found = client("fd").post("/api/v1/patients/search",
                              json={"criteria": {"family": family,
                                                 "birthDate": body["birthDate"]}}).json()["items"]
    assert [f["id"] for f in found] == [first.json()["id"]]


def test_search_treats_percent_and_underscore_as_letters(client: Any) -> None:
    """A name is a literal prefix, never a pattern: "%" and "_" can't list every patient (D65)."""
    tag = uuid.uuid4().hex[:6]
    brien = client("fd").post("/api/v1/patients", json=_body(f"OXBrien{tag}", identifiers=[]))
    assert brien.status_code == 201, brien.text
    for criteria in ({"family": "%%", "given": "%"}, {"family": "%%", "birthDate": "1984-03-09"},
                     {"family": f"O_Brien{tag}", "birthDate": "1984-03-09"}):
        found = client("fd").post("/api/v1/patients/search", json={"criteria": criteria})
        assert found.status_code == 200, (criteria, found.text)
        assert found.json()["items"] == [], criteria
    prefix = client("fd").post("/api/v1/patients/search", json={"criteria": {
        "family": f"oxbrien{tag}"[:9], "birthDate": "1984-03-09"}}).json()["items"]
    assert brien.json()["id"] in [i["id"] for i in prefix]  # a real prefix still matches
