"""Migration 0007: what the patient endpoints need (A45; issue #13, follow-up d).

Every test runs as shri_app (SET ROLE from the superuser URL, see conftest.py), with forced
row-level security in force. Platform rows (payers) are written as the superuser.
"""
from __future__ import annotations

import threading
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from sqlalchemy import Engine, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.db.models import MAPPERS, systems
from app.db.tests import builders as b
from app.db.tests.conftest import (
    SERVICE_ROLES,
    SKIP_WITHOUT_DATABASE,
    make_tenant,
    open_session,
)
from app.db.tests.test_db_rules import fails
from app.fhir.serializer import SnapshotRow, to_fhir

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS
D39 = ("gender_identity", "sexual_orientation", "occupation", "industry", "tribal_affiliation")
MRN_SYSTEM = "urn:oid:2.16.840.1.113883.3.0000.7"


# ====================================================================== D39 demographics
def test_d39_coded_demographics_are_stored(db: Session) -> None:
    pt = b.patient(db, ext_gender_identity_system=systems.SNOMED,
                   ext_gender_identity_code="446151000124109",
                   ext_gender_identity_display="Identifies as male gender",
                   ext_sexual_orientation_system=systems.V3_NULL_FLAVOR,
                   ext_sexual_orientation_code="ASKU",
                   ext_tribal_affiliation_system=systems.TRIBAL_ENTITY_US,
                   ext_tribal_affiliation_code="40", ext_occupation_text="Teacher",
                   ext_industry_text="Elementary schools")
    db.commit()
    db.expire_all()
    got = db.get(M["patient"], pt.id)
    assert got is not None
    assert (got.ext_gender_identity_code, got.ext_sexual_orientation_code,
            got.ext_tribal_affiliation_code) == ("446151000124109", "ASKU", "40")
    assert (got.ext_occupation_system, got.ext_occupation_text) == (None, "Teacher")


@pytest.mark.parametrize("field", D39)
def test_a_d39_code_names_a_registered_system(db: Session, field: str) -> None:
    with fails(db, "23514", f"ck_patient_{field}_code_has_system"):
        b.patient(db, **{f"ext_{field}_code": "X1"})
    with fails(db, "23514", f"ck_patient_{field}_code_has_system"):
        b.patient(db, **{f"ext_{field}_system": systems.SNOMED})
    with fails(db, "23503", f"fk_patient_ext_{field}_system_code_system"):
        b.patient(db, **{f"ext_{field}_system": "http://example.invalid/cs",
                         f"ext_{field}_code": "X1"})


def test_d39_demographics_are_not_served_on_fhir(db: Session) -> None:
    pt = b.patient(db, ext_gender_identity_system=systems.SNOMED,
                   ext_gender_identity_code="446151000124109", ext_occupation_text="Teacher")
    db.commit()
    resource = repr(to_fhir(pt))
    assert "446151000124109" not in resource and "Teacher" not in resource


# ====================================================================== employer
def _employer(**kw: Any) -> Any:
    return M["employer"](**{"name": "Acme Tools", **kw})


def test_an_employer_change_is_a_change_to_its_patient(db: Session) -> None:
    pt = b.patient(db)
    db.commit()
    assert pt.meta_version_id == 1
    db.add(_employer(patient_id=pt.id, phone="+16145550100", address_lines=["1 Main St"],
                     address_city="Columbus", address_state="OH", address_postal_code="43004",
                     address_country="US"))
    db.commit()
    db.refresh(pt)
    assert pt.meta_version_id == 2
    emp = db.execute(select(M["employer"]).where(M["employer"].patient_id == pt.id)).scalar_one()
    db.delete(emp)                 # the API clears the employer by deleting its row
    db.commit()
    db.refresh(pt)
    assert pt.meta_version_id == 3


def test_a_related_person_has_an_employer_too(db: Session) -> None:
    pt = b.patient(db)
    rp = M["related_person"](patient_id=pt.id, gender="male")
    db.add(rp)
    db.commit()
    db.add(_employer(related_person_id=rp.id))
    db.commit()
    db.refresh(rp)
    assert rp.meta_version_id == 2


def test_employer_checks(db: Session) -> None:
    pt = b.patient(db)
    rp = M["related_person"](patient_id=pt.id, gender="male")
    db.add(rp)
    db.flush()
    with fails(db, "23514", "ck_employer_one_person"):
        db.add(_employer())
        db.flush()
    with fails(db, "23514", "ck_employer_one_person"):
        db.add(_employer(patient_id=pt.id, related_person_id=rp.id))
        db.flush()
    with fails(db, "23514", "ck_employer_name_given"):
        db.add(_employer(patient_id=pt.id, name="  "))
        db.flush()
    with fails(db, "23514", "ck_employer_phone_e164"):
        db.add(_employer(patient_id=pt.id, phone="614-555-0100"))
        db.flush()
    with fails(db, "23514", "ck_employer_address_whole"):
        db.add(_employer(patient_id=pt.id, address_city="Columbus"))
        db.flush()
    db.add(_employer(patient_id=pt.id))
    db.flush()
    with fails(db, "23505", "uq_employer_patient_id"):
        db.add(_employer(patient_id=pt.id, name="Second job"))
        db.flush()


# ====================================================================== MRN counter (D41)
def _counter(db: Session, prefix: str = "TEST", **kw: Any) -> Any:
    counter = M["mrn_counter"](prefix=prefix, system=MRN_SYSTEM, **kw)
    db.add(counter)
    db.flush()
    return counter


def _next_mrn(db: Session) -> tuple[str, str]:
    row = db.execute(text("SELECT system, value FROM admin.next_mrn()")).one()
    return row.system, row.value


def test_mrns_are_prefix_plus_number_and_never_repeat(db: Session) -> None:
    with fails(db, "P0001", message="no MRN counter"):
        _next_mrn(db)
    _counter(db)
    assert _next_mrn(db) == (MRN_SYSTEM, "TEST-000001")
    assert _next_mrn(db) == (MRN_SYSTEM, "TEST-000002")
    savepoint = db.begin_nested()
    assert _next_mrn(db)[1] == "TEST-000003"
    savepoint.rollback()           # a registration that rolls back gives its number back
    assert _next_mrn(db)[1] == "TEST-000003"
    db.execute(text("UPDATE admin.mrn_counter SET next_value = 1234567"))
    assert _next_mrn(db)[1] == "TEST-1234567"
    with fails(db, "23505", "uq_mrn_counter_tenant_id"):
        _counter(db, "OTHER")


def test_an_mrn_number_never_goes_back(db: Session) -> None:
    _counter(db)
    # Before the first MRN, the practice may still change its prefix and system.
    db.execute(text("UPDATE admin.mrn_counter SET prefix = 'NEW', system = 'urn:oid:1.2.3'"))
    assert _next_mrn(db) == ("urn:oid:1.2.3", "NEW-000001")
    with fails(db, "P0001", message="never goes back"):
        db.execute(text("UPDATE admin.mrn_counter SET next_value = 1"))


def test_prefix_and_system_are_fixed_once_an_mrn_is_issued(db: Session) -> None:
    _counter(db)
    _next_mrn(db)
    with fails(db, "P0001", message="fixed once an MRN has been issued"):
        db.execute(text("UPDATE admin.mrn_counter SET prefix = 'NEW'"))
    with fails(db, "P0001", message="fixed once an MRN has been issued"):
        db.execute(text("UPDATE admin.mrn_counter SET system = 'urn:oid:1.2.3'"))
    with fails(db, "42501"):                   # no role deletes it, so no number comes back
        db.execute(text("DELETE FROM admin.mrn_counter"))


def test_concurrent_registrations_wait_for_the_counter(app_engine: Engine,
                                                       admin_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    first, second = open_session(app_engine, tenant), open_session(app_engine, tenant)
    second.commit()                # keeps its clinic setting past the rollback below
    try:
        _counter(first)
        first.commit()
        assert _next_mrn(first)[1] == "TEST-000001"          # holds the row until it commits
        second.execute(text("SET lock_timeout = '200ms'"))
        with pytest.raises(DBAPIError) as waited:
            _next_mrn(second)
        assert waited.value.orig.sqlstate == "55P03"          # type: ignore[union-attr]
        second.rollback()
        first.commit()
        assert _next_mrn(second)[1] == "TEST-000002"
        second.commit()
    finally:
        for s in (first, second):
            conn = s.bind
            s.close()
            conn.close()  # type: ignore[union-attr]


def test_concurrent_next_mrn_calls_never_return_the_same_number(app_engine: Engine,
                                                                admin_engine: Engine) -> None:
    # Two registrations in the same practice, on their own connections, call next_mrn() at the
    # same moment, round after round; each holds its number a little before committing, so the
    # other is waiting on the counter row when it does.
    tenant = make_tenant(admin_engine)
    setup = open_session(app_engine, tenant)
    _counter(setup)
    setup.commit()
    conn = setup.bind
    setup.close()
    conn.close()  # type: ignore[union-attr]
    rounds, start = 25, threading.Barrier(2, timeout=30)

    def register() -> list[str]:
        s = open_session(app_engine, tenant)
        s.commit()
        got = []
        try:
            for _ in range(rounds):
                start.wait()
                got.append(_next_mrn(s)[1])
                s.execute(text("SELECT pg_sleep(0.02)"))
                s.commit()
        finally:
            conn = s.bind
            s.close()
            conn.close()  # type: ignore[union-attr]
        return got

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [f.result(timeout=120) for f in [pool.submit(register) for _ in range(2)]]
    issued = results[0] + results[1]
    assert len(set(issued)) == len(issued) == 2 * rounds
    assert sorted(issued) == [f"TEST-{n:06d}" for n in range(1, 2 * rounds + 1)]


def test_next_mrn_runs_as_the_caller_for_shri_app_only(admin_engine: Engine) -> None:
    function = "admin.next_mrn()"
    with admin_engine.connect() as c:
        definer, config = c.execute(text(
            "SELECT p.prosecdef, p.proconfig FROM pg_proc p "
            "WHERE p.oid = CAST(:f AS regprocedure)"), {"f": function}).one()
        assert not definer and config == ["search_path=pg_catalog, pg_temp"]
        for role in SERVICE_ROLES:
            assert c.execute(text("SELECT has_function_privilege(:r, :f, 'EXECUTE')"),
                             {"r": role, "f": function}).scalar_one() == (role == "shri_app")


def test_next_mrn_sees_only_its_own_clinic(app_engine: Engine, admin_engine: Engine) -> None:
    for prefix in ("AAA", "BBB"):
        s = open_session(app_engine, make_tenant(admin_engine))
        _counter(s, prefix)
        assert _next_mrn(s)[1] == f"{prefix}-000001"
        s.commit()
        conn = s.bind
        s.close()
        conn.close()  # type: ignore[union-attr]
    with app_engine.connect() as c:                      # no clinic set
        with pytest.raises(DBAPIError) as refused:
            c.execute(text("SELECT * FROM admin.next_mrn()"))
        assert refused.value.orig.sqlstate == "42501"  # type: ignore[union-attr]


# ====================================================================== self-pay (selfPay)
@pytest.fixture
def billing(db: Session, admin_engine: Engine) -> Iterator[dict[str, Any]]:
    payer_id = uuid.uuid4()
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.payer (id, name, payer_type, supports_eligibility, "
                       "supports_claim_status, supports_era, is_active) "
                       "VALUES (:i, 'Test Health Plan', 'commercial', true, true, true, true)"),
                  {"i": payer_id})
    ctx = b.practice(db)
    pt = b.patient(db)
    cov = M["coverage"](status="active", beneficiary_patient_id=pt.id, order=1,
                        relationship_code="self", subscriber_id="W123456789")
    db.add(cov)
    db.flush()
    cov.payor = [M["coverage_payor"](payer_id=payer_id)]
    db.flush()
    yield {"ctx": ctx, "patient": pt, "coverage": cov, "payer_id": payer_id}


def _superbill(db: Session, billing: dict[str, Any], *, self_pay: bool) -> Any:
    enc = b.encounter(db, billing["patient"], billing["ctx"], status="finished")
    enc.ext_self_pay = self_pay
    sb = M["superbill"](encounter_id=enc.id, patient_id=billing["patient"].id,
                        rendering_practitioner_id=billing["ctx"]["practitioner"].id,
                        facility_id=billing["ctx"]["facility"].id)
    db.add(sb)
    db.flush()
    return sb


def _claim(db: Session, billing: dict[str, Any], sb: Any, **kw: Any) -> Any:
    claim = M["claim"](superbill_id=sb.id, patient_id=billing["patient"].id,
                       coverage_id=billing["coverage"].id, payer_id=billing["payer_id"],
                       patient_control_number=uuid.uuid4().hex[:20], total_charge=150, **kw)
    db.add(claim)
    db.flush()
    return claim


def test_a_self_pay_visit_has_no_insurance_claim(db: Session, billing: dict[str, Any]) -> None:
    insured = _superbill(db, billing, self_pay=False)
    self_pay = _superbill(db, billing, self_pay=True)
    claim = _claim(db, billing, insured)
    with fails(db, "P0001", message="self-pay"):
        _claim(db, billing, self_pay)
    with fails(db, "P0001", message="self-pay"):
        claim.superbill_id = self_pay.id
        db.flush()


def test_a_claim_sent_before_the_visit_became_self_pay_can_still_be_voided(
        db: Session, billing: dict[str, Any]) -> None:
    sb = _superbill(db, billing, self_pay=False)
    original = _claim(db, billing, sb, status="submitted", submitted_at=b.NOW)
    db.execute(text("UPDATE clinical.encounter SET ext_self_pay = true WHERE id = :e"),
               {"e": sb.encounter_id})
    with fails(db, "P0001", message="self-pay"):
        _claim(db, billing, sb, frequency_code="7", original_claim_id=original.id)
    void = _claim(db, billing, sb, frequency_code="8", original_claim_id=original.id)
    assert void.id is not None


# ====================================================================== facility, setting
def test_a_facility_has_a_time_zone(db: Session) -> None:
    ctx = b.practice(db)
    assert ctx["facility"].timezone == "America/New_York"
    with fails(db, "23502"):
        db.add(M["facility"](location_id=ctx["facility"].location_id, code="NOTZ",
                             name="No time zone"))
        db.flush()


def test_the_d39_registration_setting_is_off_by_default(db: Session) -> None:
    row = db.execute(text(
        "SELECT value_type, default_value FROM admin.setting_definition "
        "WHERE key = 'registration.show_sogi_fields'")).one()
    assert tuple(row) == ("boolean", "false")


def test_a_practice_setting_has_a_server_side_version_for_its_etag(db: Session) -> None:
    # PATCH /practice-settings needs If-Match (A49): the version goes up on every update, and a
    # value the client sends for it is ignored (A41).
    setting = M["tenant_setting"](setting_key="registration.show_sogi_fields", value="false")
    db.add(setting)
    db.commit()
    assert setting.version == 1
    db.execute(text("UPDATE admin.tenant_setting SET value = 'true' WHERE id = :i"),
               {"i": setting.id})
    db.execute(text("UPDATE admin.tenant_setting SET value = 'false', version = 1 WHERE id = :i"),
               {"i": setting.id})
    db.commit()
    db.refresh(setting)
    assert (setting.value, setting.version) == ("false", 3)


def test_tribal_affiliation_codes_are_registered(db: Session) -> None:
    assert db.execute(text("SELECT count(*) FROM admin.code_system WHERE uri = :u"),
                      {"u": systems.TRIBAL_ENTITY_US}).scalar_one() == 1


def test_history_keeps_the_d39_columns_but_fhir_leaves_them_out(db: Session) -> None:
    # A snapshot keeps every column (to_jsonb); a /fhir history read still leaves them out.
    pt = b.patient(db, ext_occupation_text="Teacher")
    db.commit()
    snap = db.execute(text(
        "SELECT snapshot FROM clinical.fhir_resource_history WHERE resource_id = :i "
        "ORDER BY version_id DESC LIMIT 1"), {"i": pt.id}).scalar_one()
    assert snap["ext_occupation_text"] == "Teacher"
    assert "Teacher" not in repr(to_fhir(M["patient"], SnapshotRow(snap)))
