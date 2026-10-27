"""The FHIR write helpers (app.db.fhir_store) against a live database, as shri_app.

The helpers take the core's AsyncSession (``Database.tenant_session``, as ``tenant_db`` gives an
endpoint) and never commit: each test commits, as the endpoint's transaction would. Setup rows
are written through the sync shri_app session (practice, MRN counter) or as the superuser
(the payer directory, a file in another clinic).
"""
from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import AsyncIterator, Iterator
from decimal import Decimal
from typing import Any

import pytest
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.db import Database
from app.db import fhir_store as fs
from app.db.models import MAPPERS, systems
from app.db.tests import builders as b
from app.db.tests.conftest import (
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    make_tenant,
    open_session,
    switch_to_role,
)

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS
STORE = fs.SqlFhirStore()
MRN_SYSTEM = "urn:oid:2.16.840.1.113883.3.0000.7"
DL_SYSTEM = "urn:oid:2.16.840.1.113883.4.3.39"
OFFICIAL = fs.Name(use="official", family="Nguyen", given=("Mai",))


@pytest.fixture
def clinic(app_engine: Engine, admin_engine: Engine) -> Iterator[dict[str, Any]]:
    """A practice with a user, an MRN counter and a payer in the directory."""
    tenant = make_tenant(admin_engine)
    s = open_session(app_engine, tenant)
    ctx = b.practice(s)
    s.add(M["mrn_counter"](prefix="TEST", system=MRN_SYSTEM))
    s.commit()
    payer = uuid.uuid4()
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.payer (id, name, payer_type, supports_eligibility, "
                       "supports_claim_status, supports_era, is_active) "
                       "VALUES (:i, 'Test Health Plan', 'commercial', true, true, true, true)"),
                  {"i": payer})
    yield {"tenant": tenant, "user": ctx["user"].id, "practitioner": ctx["practitioner"].id,
           "payer": payer}
    conn = s.bind
    s.close()
    conn.close()  # type: ignore[union-attr]


@pytest.fixture
async def database() -> AsyncIterator[Database]:
    db = Database(Settings(database_url=SecretStr(TEST_DATABASE_URL or "")))
    switch_to_role(db.engine.sync_engine, "shri_app")
    yield db
    await db.dispose()


def session(database: Database, clinic: dict[str, Any]) -> AsyncSession:
    return database.tenant_session(clinic["tenant"], clinic["user"])


def _patient(**kw: Any) -> fs.PatientIn:
    return fs.PatientIn(**{"names": (OFFICIAL,), "birth_date": dt.date(1984, 3, 9),
                           "gender": "female", **kw})


async def _create(database: Database, clinic: dict[str, Any], **kw: Any) -> fs.Written:
    async with session(database, clinic) as s:
        written = await STORE.create_patient(s, _patient(**kw))
        await s.commit()
    return written


async def test_create_patient_takes_the_next_mrn_unless_an_import_supplies_one(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    def mrns(pid: uuid.UUID) -> list[tuple[str, str]]:
        return [tuple(r) for r in _rows(admin_engine, "SELECT system, value FROM clinical."
                                        "identifier WHERE patient_id = :p AND type_code = 'MR'",
                                        p=pid)]

    first, second = await _create(database, clinic), await _create(database, clinic)
    assert mrns(first.id) == [(MRN_SYSTEM, "TEST-000001")]
    assert mrns(second.id) == [(MRN_SYSTEM, "TEST-000002")]
    old = fs.IdentifierIn(system="urn:oid:2.16.840.1.113883.3.0000.99", value="OE-77",
                          type_code="MR", use="old")
    imported = await _create(database, clinic, identifiers=(old,), entry_source="imported")
    assert mrns(imported.id) == [(old.system, "OE-77")]          # no number taken
    assert mrns((await _create(database, clinic)).id) == [(MRN_SYSTEM, "TEST-000003")]
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput, match="unless an import"):
            await STORE.create_patient(s, _patient(identifiers=(old,)))
        with pytest.raises(fs.InvalidInput, match="exactly one MRN"):
            await STORE.create_patient(s, _patient(identifiers=(old, old),
                                                   entry_source="imported"))
        with pytest.raises(fs.InvalidInput, match="MRN system"):
            await STORE.create_patient(s, _patient(
                identifiers=(fs.IdentifierIn(system=MRN_SYSTEM, value="TEST-000042",
                                             type_code="MR"),), entry_source="imported"))


def _rows(admin_engine: Engine, sql: str, **params: Any) -> list[Any]:
    with admin_engine.connect() as c:
        return list(c.execute(text(sql), params))


# ====================================================================== Patient
async def test_create_patient_writes_the_resource_and_every_child_row(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    address = fs.PostalAddress(lines=("12 Elm St",), city="Columbus", state="OH",
                               postal_code="43004", use="home")
    w = await _create(
        database, clinic,
        names=(OFFICIAL, fs.Name(use="nickname", text="May"),
               fs.Name(use="old", family="Tran", given=("Mai",))),
        birth_sex="F", marital_status="M", preferred_language="es",
        gender_identity=fs.Coded(system=systems.SNOMED, code="446141000124107"),
        occupation=fs.Coded(text="Teacher"),
        race=fs.RaceOrEthnicity(omb_categories=("2106-3",), text="White"),
        ethnicity=fs.RaceOrEthnicity(omb_categories=("2186-5",)),
        telecoms=(fs.Telecom(system="phone", value="+16145550100", use="mobile"),
                  fs.Telecom(system="sms", value="+16145550101"),
                  fs.Telecom(system="email", value="mai@example.invalid")),
        addresses=(address,),
        employer=fs.EmployerIn(name="Acme Tools", phone="+16145550199", address=address))
    assert w.version == 1
    pid = {"p": w.id}
    pt = _rows(admin_engine, "SELECT ext_birthsex, marital_status_system, marital_status_code, "
               "ext_gender_identity_code, ext_occupation_text, ext_race_text, meta_version_id "
               "FROM clinical.patient WHERE id = :p", **pid)[0]
    assert tuple(pt) == ("F", systems.MARITAL_STATUS, "M", "446141000124107", "Teacher",
                         "White", 1)
    assert sorted(r.use for r in _rows(admin_engine, "SELECT use FROM clinical.human_name "
                                                     "WHERE patient_id = :p", **pid)) == [
        "nickname", "official", "old"]
    assert sorted(r.system for r in _rows(admin_engine, "SELECT system FROM clinical."
                                          "contact_point WHERE patient_id = :p", **pid)) == [
        "email", "phone", "sms"]
    assert [tuple(r) for r in _rows(admin_engine, "SELECT kind, level, code FROM clinical."
                                    "patient_race_ethnicity WHERE patient_id = :p "
                                    "ORDER BY kind", **pid)] == [
        ("ethnicity", "ombCategory", "2186-5"), ("race", "ombCategory", "2106-3")]
    assert [tuple(r) for r in _rows(admin_engine, "SELECT language_code, preferred FROM "
                                    "clinical.patient_communication WHERE patient_id = :p",
                                    **pid)] == [("es", True)]
    assert [tuple(r) for r in _rows(admin_engine, "SELECT type_code, system, value FROM "
                                    "clinical.identifier WHERE patient_id = :p", **pid)] == [
        ("MR", MRN_SYSTEM, "TEST-000001")]
    assert _rows(admin_engine, "SELECT name FROM admin.employer WHERE patient_id = :p",
                 **pid)[0].name == "Acme Tools"
    assert _rows(admin_engine, "SELECT version_id FROM clinical.fhir_resource_history "
                 "WHERE resource_id = :p", **pid)[0].version_id == 1


async def test_update_patient_replaces_lists_and_leaves_the_rest(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    w = await _create(database, clinic, birth_sex="F", occupation=fs.Coded(text="Teacher"),
                      telecoms=(fs.Telecom(system="phone", value="+16145550100"),),
                      employer=fs.EmployerIn(name="Acme Tools"))
    async with session(database, clinic) as s:
        w2 = await STORE.update_patient(
            s, w.id, fs.PatientChanges(names=(fs.Name(use="official", family="Tran"),),
                                       occupation=None, employer=None),
            if_version=w.version)
        await s.commit()
    assert w2.version == w.version + 1
    pid = {"p": w.id}
    assert [r.family for r in _rows(admin_engine, "SELECT family FROM clinical.human_name "
                                                  "WHERE patient_id = :p", **pid)] == ["Tran"]
    row = _rows(admin_engine, "SELECT ext_birthsex, ext_occupation_text, meta_version_id FROM "
                "clinical.patient WHERE id = :p", **pid)[0]
    assert tuple(row) == ("F", None, w2.version)                 # UNSET kept, None cleared
    assert len(_rows(admin_engine, "SELECT 1 FROM clinical.contact_point WHERE patient_id = :p",
                     **pid)) == 1
    assert not _rows(admin_engine, "SELECT 1 FROM admin.employer WHERE patient_id = :p", **pid)
    async with session(database, clinic) as s:
        with pytest.raises(fs.StaleVersion) as stale:
            await STORE.update_patient(s, w.id, fs.PatientChanges(gender="male"),
                                       if_version=w.version)
        assert stale.value.current_version == w2.version


async def test_clearing_a_list_moves_the_version_and_race_leaves_ethnicity(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    w = await _create(database, clinic,
                      telecoms=(fs.Telecom(system="phone", value="+16145550100"),),
                      race=fs.RaceOrEthnicity(omb_categories=("2106-3",)),
                      ethnicity=fs.RaceOrEthnicity(omb_categories=("2186-5",)))
    async with session(database, clinic) as s:
        w2 = await STORE.update_patient(s, w.id, fs.PatientChanges(telecoms=()),
                                        if_version=w.version)          # a DELETE only
        await s.commit()
    async with session(database, clinic) as s:
        w3 = await STORE.update_patient(s, w.id, fs.PatientChanges(
            race=fs.RaceOrEthnicity(omb_categories=("2054-5",))), if_version=w2.version)
        await s.commit()
    assert (w2.version, w3.version) == (w.version + 1, w.version + 2)
    pid = {"p": w.id}
    assert not _rows(admin_engine, "SELECT 1 FROM clinical.contact_point WHERE patient_id = :p",
                     **pid)
    assert sorted(tuple(r) for r in _rows(
        admin_engine, "SELECT kind, code FROM clinical.patient_race_ethnicity WHERE "
        "patient_id = :p", **pid)) == [("ethnicity", "2186-5"), ("race", "2054-5")]


async def test_a_patient_of_another_clinic_is_not_found(
        database: Database, clinic: dict[str, Any], app_engine: Engine,
        admin_engine: Engine) -> None:
    w = await _create(database, clinic)
    other = {**clinic, "tenant": make_tenant(admin_engine)}
    async with session(database, other) as s:
        with pytest.raises(fs.ResourceNotFound):
            await STORE.update_patient(s, w.id, fs.PatientChanges(gender="male"), if_version=1)


async def test_the_helpers_never_commit(database: Database, clinic: dict[str, Any],
                                        admin_engine: Engine) -> None:
    async with session(database, clinic) as s:
        w = await STORE.create_patient(s, _patient())
        await s.rollback()
    assert not _rows(admin_engine, "SELECT 1 FROM clinical.patient WHERE id = :p", p=w.id)


async def test_an_identifier_moves_its_patients_version(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    w = await _create(database, clinic)
    async with session(database, clinic) as s:
        added = await STORE.add_patient_identifier(
            s, w.id, fs.IdentifierIn(system=DL_SYSTEM, value="D1234567", type_code="DL"),
            if_version=w.version)
        await s.commit()
    assert added.parent.version == w.version + 1
    assert added.child_id is not None
    row = _rows(admin_engine, "SELECT patient_id, type_code, value FROM clinical.identifier "
                "WHERE id = :i", i=added.child_id)
    assert [tuple(r) for r in row] == [(w.id, "DL", "D1234567")]
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput, match="only from admin.next_mrn"):
            await STORE.add_patient_identifier(
                s, w.id, fs.IdentifierIn(system=MRN_SYSTEM, value="TEST-9", type_code="MR"))


async def test_no_other_identifier_uses_the_practices_mrn_system(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    """Vimal's review of #88: a PI in the MRN system with a value the counter reaches later
    would make that registration fail, and every one after it."""
    w = await _create(database, clinic)
    poison = fs.IdentifierIn(system=MRN_SYSTEM, value="TEST-000042", type_code="PI")
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput, match="MRN system"):
            await STORE.add_patient_identifier(s, w.id, poison)
        with pytest.raises(fs.InvalidInput, match="MRN system"):
            await STORE.create_patient(s, _patient(identifiers=(poison,)))
    assert len(_rows(admin_engine, "SELECT 1 FROM clinical.identifier WHERE patient_id = :p",
                     p=w.id)) == 1


async def test_restricting_a_chart_replaces_only_its_confidentiality(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    w = await _create(database, clinic)
    with admin_engine.begin() as c:                      # a sensitivity label, set elsewhere
        c.execute(text("UPDATE clinical.patient SET meta_security = ARRAY['PSY'] "
                       "WHERE id = :p"), {"p": w.id})
    async with session(database, clinic) as s:
        await STORE.set_patient_security(s, w.id, frozenset({"R"}))
        await s.commit()
    labels = _rows(admin_engine, "SELECT meta_security FROM clinical.patient WHERE id = :p",
                   p=w.id)[0].meta_security
    assert labels == ["PSY", "R"]
    async with session(database, clinic) as s:
        await STORE.set_patient_security(s, w.id, frozenset())
        await s.commit()
        with pytest.raises(ValueError):
            await STORE.set_patient_security(s, w.id, frozenset({"N"}))
    assert _rows(admin_engine, "SELECT meta_security FROM clinical.patient WHERE id = :p",
                 p=w.id)[0].meta_security == ["PSY"]


# ====================================================================== RelatedPerson
async def test_a_related_person_with_relationships_and_employer(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient = await _create(database, clinic)
    async with session(database, clinic) as s:
        w = await STORE.create_related_person(s, fs.RelatedPersonIn(
            patient_id=patient.id, names=(fs.Name(use="official", family="Nguyen",
                                                  given=("Binh",)),),
            relationships=(fs.Coded(system=systems.V2_0131, code="C"),),
            telecoms=(fs.Telecom(system="phone", value="+16145550111"),),
            employer=fs.EmployerIn(name="City Hospital")))
        await s.commit()
    async with session(database, clinic) as s:
        w2 = await STORE.update_related_person(s, w.id, fs.RelatedPersonChanges(
            relationships=(fs.Coded(system=systems.V2_0131, code="N"),)), if_version=w.version)
        await s.commit()
    assert w2.version == w.version + 1
    rid = {"r": w.id}
    assert [r.code_code for r in _rows(admin_engine, "SELECT code_code FROM clinical."
                                       "related_person_relationship WHERE related_person_id "
                                       "= :r", **rid)] == ["N"]
    assert len(_rows(admin_engine, "SELECT 1 FROM clinical.human_name WHERE related_person_id "
                     "= :r", **rid)) == 1
    assert _rows(admin_engine, "SELECT name FROM admin.employer WHERE related_person_id = :r",
                 **rid)[0].name == "City Hospital"
    async with session(database, clinic) as s:
        w3 = await STORE.update_related_person(s, w.id, fs.RelatedPersonChanges(
            active=False, gender="male", birth_date=dt.date(1950, 5, 1)), if_version=w2.version)
        await s.commit()
    assert w3.version == w2.version + 1
    assert tuple(_rows(admin_engine, "SELECT active, gender, birth_date FROM clinical."
                       "related_person WHERE id = :r", **rid)[0]) == (
        False, "male", dt.date(1950, 5, 1))


# ====================================================================== Coverage
async def _coverage(database: Database, clinic: dict[str, Any]) -> tuple[fs.Written, fs.Written]:
    patient = await _create(database, clinic)
    async with session(database, clinic) as s:
        w = await STORE.create_coverage(s, fs.CoverageIn(
            beneficiary_patient_id=patient.id, payer_id=clinic["payer"], member_id="W123456789",
            subscriber_id="W123456789", subscriber_patient_id=patient.id,
            relationship_code="self", order=1, period_start=dt.date(2026, 1, 1),
            classes=(fs.CoverageClassIn(type="group", value="GRP-55", name="Acme Inc"),
                     fs.CoverageClassIn(type="plan", value="Gold PPO", name="Gold PPO")),
            costs=(fs.CostIn(type=fs.Coded(system=systems.COVERAGE_COPAY_TYPE, code="copay"),
                             money=Decimal("25.00")),)))
        await s.commit()
    return patient, w


async def test_a_coverage_with_its_payer_member_id_classes_and_copay(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    _, w = await _coverage(database, clinic)
    cid = {"c": w.id}
    assert _rows(admin_engine, "SELECT payer_id FROM clinical.coverage_payor WHERE coverage_id "
                 "= :c", **cid)[0].payer_id == clinic["payer"]
    assert [tuple(r) for r in _rows(admin_engine, "SELECT type_code, value FROM clinical."
                                    "identifier WHERE coverage_id = :c", **cid)] == [
        ("MB", "W123456789")]
    assert sorted(r.type for r in _rows(admin_engine, "SELECT type FROM clinical."
                                        "coverage_class WHERE coverage_id = :c", **cid)) == [
        "group", "plan"]
    assert _rows(admin_engine, "SELECT value_money_value FROM clinical."
                 "coverage_cost_to_beneficiary WHERE coverage_id = :c",
                 **cid)[0].value_money_value == Decimal("25.00")
    async with session(database, clinic) as s:
        w2 = await STORE.update_coverage(s, w.id, fs.CoverageChanges(
            member_id="W999", period_end=dt.date(2026, 12, 31), classes=()),
            if_version=w.version)
        await s.commit()
    assert w2.version == w.version + 1
    assert [r.value for r in _rows(admin_engine, "SELECT value FROM clinical.identifier "
                                   "WHERE coverage_id = :c", **cid)] == ["W999"]
    assert not _rows(admin_engine, "SELECT 1 FROM clinical.coverage_class WHERE coverage_id "
                     "= :c", **cid)


async def test_entered_in_error_writes_its_provenance(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    _, w = await _coverage(database, clinic)
    async with session(database, clinic) as s:
        w2 = await STORE.coverage_entered_in_error(s, w.id, fs.Reason(text="Wrong patient"),
                                                   if_version=w.version)
        await s.commit()
    prov = _rows(admin_engine, "SELECT p.target_version_id, p.activity_code, p.reason_text, "
                 "a.who_practitioner_id FROM clinical.provenance p JOIN clinical."
                 "provenance_agent a ON a.provenance_id = p.id WHERE p.target_id = :c",
                 c=w.id)
    assert [tuple(r) for r in prov] == [(w2.version, "NULLIFY", "Wrong patient",
                                         clinic["practitioner"])]
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidTransition) as again:
            await STORE.coverage_entered_in_error(s, w.id, fs.Reason(text="Again"))
        assert again.value.current_state == "entered-in-error"
        with pytest.raises(fs.InvalidInput):
            await STORE.coverage_entered_in_error(s, w.id, fs.Reason(text="  "))
        with pytest.raises(fs.InvalidTransition):                    # never used again (D45)
            await STORE.update_coverage(s, w.id, fs.CoverageChanges(member_id="W1"),
                                        if_version=w2.version)


# ====================================================================== Consent
async def test_a_consent_with_its_scope_form_performer_and_verification(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient = await _create(database, clinic)
    form = uuid.uuid4()
    async with session(database, clinic) as s:
        await s.execute(text(
            "INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, content_type, "
            "size_bytes, sha256) VALUES (:i, :t, 'docs', :k, 'application/pdf', 10, :h)"),
            {"i": form, "t": clinic["tenant"], "k": f"k/{form}.pdf", "h": "a" * 64})
        w = await STORE.create_consent(s, fs.ConsentIn(
            patient_id=patient.id, kind="privacy-notice", status="active",
            categories=(fs.Coded(system=systems.LOINC, code="59284-0"),),
            date_time=b.NOW, policy_version="2026-01", signature_method="electronic",
            provision_type="permit", source_attachment_binary_object_id=form,
            performer_patient_id=patient.id, verified=True,
            verified_with_patient_id=patient.id, verification_date=b.NOW))
        await s.commit()
    row = _rows(admin_engine, "SELECT scope_system, scope_code, ext_kind, ext_policy_version, "
                "source_attachment_binary_object_id, meta_version_id FROM clinical.consent "
                "WHERE id = :c", c=w.id)[0]
    assert tuple(row) == (systems.CONSENT_SCOPE, "patient-privacy", "privacy-notice", "2026-01",
                          form, w.version)
    for table in ("consent_category", "consent_performer", "consent_verification"):
        assert len(_rows(admin_engine, f"SELECT 1 FROM clinical.{table} "  # noqa: S608
                         "WHERE consent_id = :c", c=w.id)) == 1


async def test_a_new_consent_of_the_same_kind_retires_the_earlier_one(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient = await _create(database, clinic)

    def consent(kind: str, version: str) -> fs.ConsentIn:
        return fs.ConsentIn(patient_id=patient.id, kind=kind, status="active",
                            categories=(fs.Coded(system=systems.LOINC, code="59284-0"),),
                            date_time=b.NOW, policy_version=version, provision_type="permit",
                            signature_method="written")

    async with session(database, clinic) as s:
        old = await STORE.create_consent(s, consent("privacy-notice", "2025-01"))
        other = await STORE.create_consent(s, consent("treatment", "2025-01"))
        await s.commit()
    async with session(database, clinic) as s:
        new = await STORE.create_consent(s, consent("privacy-notice", "2026-01"))
        await s.commit()
    status = {r.id: r.status for r in _rows(admin_engine, "SELECT id, status FROM clinical."
                                            "consent WHERE patient_id = :p", p=patient.id)}
    assert status == {old.id: "inactive", other.id: "active", new.id: "active"}
