"""Migration 0003: what each service role may do on the public and audit schemas.

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

from app.db.models import systems
from app.db.tests import builders as b
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant, switch_to_role, sync_url

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

WRITERS = ("shri_app", "shri_integration", "shri_fhir_reader")
READER = "shri_fhir_reader"
DENIED = "42501"

AUDIT_INSERT = text("INSERT INTO audit.audit_event (tenant_id, actor_type, action, outcome) "
                    "VALUES (:t, 'system', 'read', 'success')")


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
