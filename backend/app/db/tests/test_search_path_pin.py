"""Migration 0030: every trigger function and every SECURITY DEFINER function in clinical,
admin, audit and public runs with search_path pinned to pg_catalog, pg_temp, and names every
table and every one of our functions with its schema (Thulasi's #424 review; Anand's plan).

A function that resolved a bare name through the caller's search_path, or through a pinned path
naming our schemas, could be pointed at another table or function by whoever could create one
there. Pinned to pg_catalog, pg_temp, it finds only built-ins bare.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.db.tests import builders as b
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE
from app.db.tests.test_db_rules import fails
from app.db.tools.server_check import PINNED_SEARCH_PATH

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

#: Functions allowed another search_path, each with the reason. Empty: none is. A function
#: added here must be named with its arguments (regprocedure text) and say why.
EXCEPTIONS: dict[str, str] = {}

_FUNCTIONS = """
SELECT p.oid::regprocedure::text AS name, p.prosecdef AS definer,
       p.prorettype = 'trigger'::regtype AS is_trigger, p.proconfig AS config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('clinical', 'admin', 'audit', 'public')
   AND (p.prosecdef OR p.prorettype = 'trigger'::regtype)
"""


def test_every_trigger_and_definer_function_pins_search_path(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        rows = c.execute(text(_FUNCTIONS)).all()
    names = {r.name for r in rows}
    # The query sees what it should: a few of each kind, so it can't pass on an empty list.
    assert {"shri_fhir_touch_parent()", "shri_fhir_history()", "shri_audit_chain()",
            "admin.portal_request_refill(uuid)",
            "audit.record_fhir_lookup_denied(text,uuid)"} <= names, names
    unpinned = {r.name: r.config for r in rows
                if PINNED_SEARCH_PATH not in (r.config or [])}
    assert set(unpinned) - set(EXCEPTIONS) == set(), unpinned
    # No exception outlives its function or its need.
    assert set(EXCEPTIONS) <= set(unpinned), set(EXCEPTIONS) - set(unpinned)
    # The pin is the only search_path setting each one has.
    for r in rows:
        if r.name not in EXCEPTIONS:
            paths = [s for s in r.config if s.startswith("search_path=")]
            assert paths == [PINNED_SEARCH_PATH], (r.name, r.config)


@pytest.mark.parametrize(("table", "qualified"), [
    ("service_request", "clinical.service_request"),
    ("employer", "admin.employer"),
    ("audit_event", "audit.audit_event"),
])
def test_a_bare_trigger_argument_resolves_in_our_schemas(admin_engine: Engine, table: str,
                                                         qualified: str) -> None:
    with admin_engine.connect() as c:
        got = c.execute(text("SELECT public.shri_qualified_table(:t)"), {"t": table}).scalar()
    assert got == qualified


def test_a_table_in_none_of_our_schemas_is_refused(db: Session) -> None:
    for missing in ("pg_class", "no_such_table"):
        with fails(db, "42P01", message="does not exist in clinical, admin or audit"):
            db.execute(text("SELECT public.shri_qualified_table(:t)"), {"t": missing})


def test_the_triggers_need_nothing_on_the_callers_search_path(db: Session) -> None:
    """As shri_app with an empty search_path: an admin row touches its clinical parent
    (shri_fhir_touch_parent across schemas, then shri_fhir_version, and at commit
    shri_fhir_history with the snapshot); before 0030 this failed ("relation does not
    exist")."""
    pt = b.patient(db)
    db.commit()
    assert pt.meta_version_id == 1
    tenant = db.info["tenant_id"]
    db.execute(text("SELECT set_config('search_path', '', false)"))
    db.execute(text(
        "INSERT INTO admin.employer (id, tenant_id, patient_id, name) "
        "VALUES (CAST(:i AS uuid), CAST(:t AS uuid), CAST(:p AS uuid), 'Acme Tools')"),
        {"i": str(uuid.uuid4()), "t": str(tenant), "p": str(pt.id)})
    db.commit()
    version, history = db.execute(text(
        "SELECT p.meta_version_id, (SELECT count(*) FROM clinical.fhir_resource_history h "
        "WHERE h.resource_type = 'Patient' AND h.resource_id = p.id) "
        "FROM clinical.patient p WHERE p.id = CAST(:p AS uuid)"), {"p": str(pt.id)}).one()
    assert (version, history) == (2, 2)
