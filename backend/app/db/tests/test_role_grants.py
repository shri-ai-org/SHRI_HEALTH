"""Migrations 0003 and 0004: what each service role may do on the public and audit schemas,
and on the result tables the partner worker files into.

Every test runs as the real role (SET ROLE from the superuser URL, see conftest.py), with forced
row-level security in force, and checks the database's own answer: a refused statement must
fail with SQLSTATE 42501 (insufficient privilege, which includes an RLS WITH CHECK refusal).
"""

import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db.models import MAPPERS, systems
from app.db.tests import builders as b
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant, switch_to_role, sync_url

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

WRITERS = ("shri_app", "shri_integration", "shri_fhir_reader")
READER = "shri_fhir_reader"
DENIED = "42501"

AUDIT_INSERT = text("INSERT INTO audit.audit_event (tenant_id, actor_type, action, category, "
                    "outcome) VALUES (:t, 'system', 'read', 'phi-read', 'success')")


@pytest.fixture(scope="module")
def role_engine() -> Iterator[dict[str, Engine]]:
    engines: dict[str, Engine] = {}
    for role in (*WRITERS, "shri_reporting"):
        engine = create_engine(sync_url(), poolclass=NullPool)
        switch_to_role(engine, role, require_search_path=role != READER)
        engines[role] = engine
    yield engines
    for engine in engines.values():
        engine.dispose()


def with_clinic(conn: Connection, tenant: uuid.UUID | None) -> Connection:
    if tenant is not None:
        conn.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                     {"t": str(tenant)})
    return conn


def assert_refused(conn: Connection, sql: str, params: dict[str, object] | None = None) -> None:
    with pytest.raises(DBAPIError) as caught, conn.begin_nested():
        conn.execute(text(sql), params or {})
    assert getattr(caught.value.orig, "sqlstate", None) == DENIED, caught.value.orig


@pytest.mark.parametrize("role", WRITERS)
def test_writers_have_usage_on_public(admin_engine: Engine, role: str) -> None:
    with admin_engine.connect() as c:
        assert c.execute(text("SELECT has_schema_privilege(:r, 'public', 'USAGE')"),
                         {"r": role}).scalar_one()


@pytest.mark.parametrize("role", (*WRITERS, "shri_reporting"))
def test_no_service_role_can_create_in_public(admin_engine: Engine,
                                              role_engine: dict[str, Engine], role: str) -> None:
    with admin_engine.connect() as c:
        assert not c.execute(text("SELECT has_schema_privilege(:r, 'public', 'CREATE')"),
                             {"r": role}).scalar_one()
    with role_engine[role].connect() as conn:
        assert_refused(conn, "CREATE TABLE public.zz_probe (i int)")
        assert_refused(conn, "CREATE FUNCTION public.zz_probe() RETURNS int "
                             "LANGUAGE sql AS 'SELECT 1'")


def test_app_fires_the_triggers(db: Session, admin_engine: Engine) -> None:
    pt = b.patient(db)  # insert fires the versioning triggers (public and clinical functions)
    db.commit()
    with admin_engine.connect() as c:
        history = c.execute(text("SELECT count(*) FROM clinical.fhir_resource_history "
                                 "WHERE resource_id = :i"), {"i": pt.id}).scalar_one()
    assert history == 1


def test_integration_fires_the_triggers(db: Session, admin_engine: Engine,
                                        role_engine: dict[str, Engine]) -> None:
    pt = b.patient(db)
    db.commit()
    obs_id = uuid.uuid4()
    with role_engine["shri_integration"].connect() as conn:
        with_clinic(conn, db.info["tenant_id"])
        # No RETURNING: shri_integration may insert results but not read them back.
        conn.execute(text(
            "INSERT INTO clinical.observation (id, tenant_id, status, subject_patient_id, "
            "code_system, code_code, effective_date_time, value_quantity_value, "
            "value_quantity_unit, value_quantity_system, value_quantity_code) "
            "VALUES (:i, :t, 'final', :p, :sys, '8867-4', now(), 72, '/min', :ucum, '/min')"),
            {"i": obs_id, "t": db.info["tenant_id"], "p": pt.id, "sys": systems.LOINC,
             "ucum": systems.UCUM})
        conn.commit()
    with admin_engine.connect() as c:
        history = c.execute(text("SELECT count(*) FROM clinical.fhir_resource_history "
                                 "WHERE resource_id = :i"), {"i": obs_id}).scalar_one()
    assert history == 1


def test_fhir_reader_fires_the_audit_chain(admin_engine: Engine,
                                           role_engine: dict[str, Engine]) -> None:
    tenant = make_tenant(admin_engine)
    with role_engine[READER].connect() as conn:
        with_clinic(conn, tenant)
        conn.execute(AUDIT_INSERT, {"t": tenant})
        conn.commit()
    with admin_engine.connect() as c:
        row = c.execute(text("SELECT chain_seq, hash FROM audit.audit_event "
                             "WHERE tenant_id = :t"), {"t": tenant}).one()
    assert row.chain_seq == 1 and row.hash


def test_fhir_reader_is_insert_only_on_audit(admin_engine: Engine,
                                             role_engine: dict[str, Engine]) -> None:
    tenant, other = make_tenant(admin_engine), make_tenant(admin_engine)
    with role_engine[READER].connect() as conn:
        with_clinic(conn, tenant)
        conn.execute(AUDIT_INSERT, {"t": tenant})          # allowed
        assert_refused(conn, "SELECT * FROM audit.audit_event")
        assert_refused(conn, "SELECT id FROM audit.audit_event")
        assert_refused(conn, "UPDATE audit.audit_event SET reason = 'x'")
        assert_refused(conn, "DELETE FROM audit.audit_event")
        assert_refused(conn, AUDIT_INSERT.text, {"t": other})  # RLS: another clinic
        conn.rollback()
    with admin_engine.connect() as c:
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            granted = c.execute(text("SELECT has_table_privilege(:r, :tbl, :p)"),
                                {"r": READER, "tbl": "audit.audit_event", "p": privilege}
                                ).scalar_one()
            assert granted is (privilege == "INSERT"), privilege
            assert not c.execute(text("SELECT has_table_privilege(:r, :tbl, :p)"),
                                 {"r": READER, "tbl": "audit.break_glass_access",
                                  "p": privilege}).scalar_one()


def test_fhir_reader_has_no_break_glass_access(role_engine: dict[str, Engine],
                                               tenant: uuid.UUID) -> None:
    with role_engine[READER].connect() as conn:
        with_clinic(conn, tenant)
        assert_refused(conn, "SELECT * FROM audit.break_glass_access")
        assert_refused(conn, "INSERT INTO audit.break_glass_access (tenant_id) VALUES (:t)",
                       {"t": tenant})


def test_fhir_reader_cannot_write_clinical(db: Session, role_engine: dict[str, Engine]) -> None:
    pt = b.patient(db)
    db.commit()
    with role_engine[READER].connect() as conn:
        with_clinic(conn, db.info["tenant_id"])
        assert_refused(conn, "INSERT INTO clinical.patient (id, tenant_id) VALUES (:i, :t)",
                       {"i": uuid.uuid4(), "t": db.info["tenant_id"]})
        assert_refused(conn, "UPDATE clinical.patient SET gender = 'other' WHERE id = :i",
                       {"i": pt.id})
        assert_refused(conn, "DELETE FROM clinical.patient WHERE id = :i", {"i": pt.id})


def test_fhir_reader_reads_only_its_clinic(db: Session, admin_engine: Engine,
                                           role_engine: dict[str, Engine]) -> None:
    b.patient(db)
    db.commit()
    tenant = db.info["tenant_id"]
    with admin_engine.connect() as c:
        mine = c.execute(text("SELECT count(*) FROM clinical.patient WHERE tenant_id = :t"),
                         {"t": tenant}).scalar_one()
        everyone = c.execute(text("SELECT count(*) FROM clinical.patient")).scalar_one()
    assert everyone > mine >= 1
    with role_engine[READER].connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM clinical.patient")).scalar_one() == 0
        conn.rollback()
        with_clinic(conn, tenant)
        assert conn.execute(text("SELECT count(*) FROM clinical.patient")).scalar_one() == mine


def test_chain_verifies_with_rows_from_app_and_fhir_reader(
        admin_engine: Engine, app_engine: Engine, role_engine: dict[str, Engine]) -> None:
    tenant = make_tenant(admin_engine)
    for engine in (app_engine, role_engine[READER], app_engine, role_engine[READER]):
        with engine.connect() as conn:
            with_clinic(conn, tenant)
            conn.execute(AUDIT_INSERT, {"t": tenant})
            conn.commit()
    with admin_engine.connect() as c:
        seqs = c.execute(text("SELECT chain_seq FROM audit.audit_event WHERE tenant_id = :t "
                              "ORDER BY chain_seq"), {"t": tenant}).scalars().all()
        problems = c.execute(text("SELECT count(*) FROM public.shri_audit_verify(:t)"),
                             {"t": tenant}).scalar_one()
    assert seqs == [1, 2, 3, 4]
    assert problems == 0


# --------------------------------------------------------------------------- migration 0004
ALL_ROLES = (*WRITERS, "shri_reporting")
INTEGRATION = "shri_integration"


def test_app_reads_the_audit_trail_of_its_clinic_only(admin_engine: Engine, app_engine: Engine,
                                                       role_engine: dict[str, Engine]) -> None:
    mine, theirs = make_tenant(admin_engine), make_tenant(admin_engine)
    for tenant in (mine, theirs):
        with app_engine.connect() as conn:
            with_clinic(conn, tenant)
            conn.execute(AUDIT_INSERT, {"t": tenant})
            conn.commit()
    with role_engine["shri_app"].connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM audit.audit_event")).scalar_one() == 0
        conn.rollback()
        with_clinic(conn, mine)
        rows = conn.execute(text("SELECT tenant_id, action, hash FROM audit.audit_event "
                                 "WHERE tenant_id IN (:a, :b)"), {"a": mine, "b": theirs}).all()
    assert [r.tenant_id for r in rows] == [mine] and rows[0].hash


@pytest.mark.parametrize("role", ALL_ROLES)
def test_no_role_can_change_or_remove_audit_rows(admin_engine: Engine, app_engine: Engine,
                                                 role_engine: dict[str, Engine],
                                                 role: str) -> None:
    tenant = make_tenant(admin_engine)
    with app_engine.connect() as conn:
        with_clinic(conn, tenant)
        conn.execute(AUDIT_INSERT, {"t": tenant})
        conn.commit()
    with admin_engine.connect() as c:
        for privilege in ("UPDATE", "DELETE", "TRUNCATE"):
            assert not c.execute(text("SELECT has_table_privilege(:r, 'audit.audit_event', :p)"),
                                 {"r": role, "p": privilege}).scalar_one(), (role, privilege)
    with role_engine[role].connect() as conn:
        with_clinic(conn, tenant)
        assert_refused(conn, "UPDATE audit.audit_event SET reason = 'changed'")
        assert_refused(conn, "DELETE FROM audit.audit_event")


def test_integration_is_insert_only_on_audit(admin_engine: Engine,
                                             role_engine: dict[str, Engine]) -> None:
    tenant, other = make_tenant(admin_engine), make_tenant(admin_engine)
    with role_engine[INTEGRATION].connect() as conn:
        with_clinic(conn, tenant)
        conn.execute(AUDIT_INSERT, {"t": tenant})          # allowed, no RETURNING
        assert_refused(conn, "SELECT id FROM audit.audit_event")
        assert_refused(conn, AUDIT_INSERT.text, {"t": other})  # RLS: another clinic
        assert_refused(conn, "SELECT * FROM audit.break_glass_access")
        assert_refused(conn, "INSERT INTO audit.break_glass_access (tenant_id) VALUES (:t)",
                       {"t": tenant})
        conn.commit()
    with admin_engine.connect() as c:
        row = c.execute(text("SELECT chain_seq, hash FROM audit.audit_event "
                             "WHERE tenant_id = :t"), {"t": tenant}).one()
    assert row.chain_seq == 1 and row.hash


def test_integration_reads_and_writes_its_result_tables_but_never_deletes(
        admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        tables = c.execute(text(
            "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables "
            "WHERE schemaname IN ('clinical', 'admin') "
            "AND has_table_privilege(:r, format('%I.%I', schemaname, tablename), 'INSERT')"),
            {"r": INTEGRATION}).scalars().all()
        assert {"clinical.observation", "clinical.diagnostic_report"} <= set(tables)
        for table in tables:
            for privilege, expected in (("SELECT", True), ("UPDATE", True), ("DELETE", False)):
                granted = c.execute(text("SELECT has_table_privilege(:r, :t, :p)"),
                                    {"r": INTEGRATION, "t": table, "p": privilege}).scalar_one()
                assert granted is expected, (table, privilege)


def test_integration_reads_nothing_else(role_engine: dict[str, Engine],
                                        tenant: uuid.UUID) -> None:
    with role_engine[INTEGRATION].connect() as conn:
        with_clinic(conn, tenant)
        assert_refused(conn, "SELECT * FROM clinical.patient")
        assert_refused(conn, "SELECT * FROM clinical.condition")
        assert_refused(conn, "SELECT * FROM clinical.medication_request")


def test_integration_files_a_corrected_lab_result(db: Session, admin_engine: Engine,
                                                  role_engine: dict[str, Engine]) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx)
    obs = MAPPERS["observation"](status="final", code_system=systems.LOINC, code_code="2345-7",
                                 subject_patient_id=pt.id, encounter_id=enc.id,
                                 effective_date_time=b.NOW, value_quantity_value=99)
    db.add(obs)
    db.commit()
    correct = text("UPDATE clinical.observation SET value_quantity_value = 199, "
                   "status = 'corrected' WHERE id = :i")
    other = make_tenant(admin_engine)
    with role_engine[INTEGRATION].connect() as conn:
        with_clinic(conn, other)                      # another clinic cannot see the row
        assert conn.execute(correct, {"i": obs.id}).rowcount == 0
        conn.rollback()
        with_clinic(conn, db.info["tenant_id"])
        assert conn.execute(correct, {"i": obs.id}).rowcount == 1
        assert_refused(conn, "DELETE FROM clinical.observation WHERE id = :i", {"i": obs.id})
        conn.commit()
    with admin_engine.connect() as c:
        status = c.execute(text("SELECT status FROM clinical.observation WHERE id = :i"),
                           {"i": obs.id}).scalar_one()
        versions = c.execute(text(
            "SELECT snapshot->>'value_quantity_value' FROM clinical.fhir_resource_history "
            "WHERE resource_id = :i ORDER BY version_id"), {"i": obs.id}).scalars().all()
    assert status == "corrected"
    assert [float(v) for v in versions] == [99.0, 199.0]


def test_app_never_reads_clinic_less_audit_rows(admin_engine: Engine) -> None:
    """Thulasi's condition on #13/#44: platform security events with no clinic (a failed
    sign-in before a clinic is known) are not visible to the clinic API, with or without a
    clinic set. The clinic policy compares tenant_id with the setting, so a null never matches.

    One transaction, rolled back, so nothing is kept and every run starts the same. The row is
    written as the superuser; then the same transaction switches to shri_app, so the row is
    there but RLS must hide it. (Migration 0005 lets shri_app write such rows, A47; see
    test_core_runtime.py.)"""
    tenant = make_tenant(admin_engine)
    lookup = text("SELECT count(*) FROM audit.audit_event WHERE id = :i OR tenant_id IS NULL")
    with admin_engine.connect() as conn:
        row_id = conn.execute(text(
            "INSERT INTO audit.audit_event (tenant_id, actor_type, action, category, outcome, "
            "reason) VALUES (NULL, 'system', 'login', 'security', 'failure', 'unknown user') "
            "RETURNING id")
        ).scalar_one()
        assert conn.execute(lookup, {"i": row_id}).scalar_one() >= 1   # the superuser sees it
        conn.execute(text("SET LOCAL ROLE shri_app"))
        assert conn.execute(lookup, {"i": row_id}).scalar_one() == 0   # no clinic set
        with_clinic(conn, tenant)
        assert conn.execute(lookup, {"i": row_id}).scalar_one() == 0   # a clinic set
        conn.rollback()