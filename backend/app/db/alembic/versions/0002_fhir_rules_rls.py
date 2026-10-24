"""FHIR versioning and history, clinical safety triggers, reference data, row-level security,
across the clinical/admin/audit schemas and the shri_fhir_reader/shri_integration/shri_reporting
roles (D23).

Frozen SQL in sql_0002/:
  10_rules.sql            hand-written rule functions (signed notes, Rx, orders, results, AI,
                          scheduling, audit hash chain) - unqualified table references, resolved
                          via search_path (set on each role by sql/00_extensions.sql)
  20_fhir_versioning.sql  per-resource snapshot functions and version / history / touch triggers
  30_guards.sql           attaches the rule functions to tables
  95_seed.sql             code systems, permission catalogue, system roles
  90_rls_grants.sql       forced RLS policies and privileges for all 5 roles (applied last, so
                          the seed above runs before tenant policies exist)

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-23
"""
from __future__ import annotations

import pathlib
import re

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0002")
FILES = ["10_rules.sql", "20_fhir_versioning.sql", "30_guards.sql", "95_seed.sql",
         "90_rls_grants.sql"]


def upgrade() -> None:
    for name in FILES:
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    rls = (SQL_DIR / "90_rls_grants.sql").read_text()
    # Schema-qualified identifiers (\w+\.\w+) now, not bare \w+.
    qualified = r"[\w]+\.[\w]+"
    for table in sorted(set(re.findall(rf"ALTER TABLE ({qualified}) ENABLE ROW LEVEL SECURITY",
                                        rls))):
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    for policy, table in sorted(set(re.findall(rf"CREATE POLICY (\w+) ON ({qualified})", rls))):
        op.execute(f"DROP POLICY IF EXISTS {policy} ON {table}")
    for schema in ("clinical", "admin", "audit"):
        op.execute(f"REVOKE ALL ON ALL TABLES IN SCHEMA {schema} FROM "
                   "shri_app, shri_fhir_reader, shri_integration, shri_reporting")
    # Reference data (code systems, permissions, system roles) is kept: clinical rows reference
    # it, and the seed is idempotent on re-upgrade.
    # Dropping the functions drops every trigger that uses them. They live in public (D23's
    # note: shared rule functions are schema-agnostic utilities, not tied to one data schema).
    op.execute("""
        DO $$ DECLARE f record; BEGIN
          FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname LIKE 'shri\\_%'
                     AND p.proname <> 'shri_npi_valid' LOOP
            EXECUTE 'DROP FUNCTION IF EXISTS ' || f.sig || ' CASCADE';
          END LOOP;
        END $$""")
