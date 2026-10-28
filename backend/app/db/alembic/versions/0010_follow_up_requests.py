"""The follow-up request on the encounter (D98, A52; demo step 10, check-out).

New table, clinic-scoped with forced RLS:
  clinical.encounter_follow_up  the clinician's request for a revisit, one per visit: the
                      interval (value and unit), the optional visit type, provider and note,
                      who asked and when, the status (open, booked, declined, withdrawn), the
                      booked appointment (the same patient's) and the reason for a decline or
                      a withdrawal. A child of the encounter: every change moves the
                      encounter's version (the ETag decline's If-Match carries) and is kept in
                      its history. shri_app may read, add and change it, never delete it;
                      /fhir never serves it (and hides it for restricted charts, as 0006).

Rules (shri_follow_up_guard, shri_fixed_columns):
  the request changes only while open; the status moves open -> booked, declined or
  withdrawn, booked -> open (revisit cancelled) or booked (revisit rescheduled); a declined or
  withdrawn request is final; the encounter and patient never change.

Frozen SQL in sql_0010/:
  01_tables.sql            generated from the models: the new table
  02_versioning.sql        generated (gen_db_rules.versioning_sql): the encounter's history
                           snapshot with the follow-up, and the trigger that moves its version
  03_rls_grants.sql        generated (gen_db_rules.rls_sql, fhir_visibility_sql): RLS, grants
                           and the /fhir restricted-chart policy for the new table
  04_functions.sql         hand-written: shri_follow_up_guard
  05_triggers.sql          generated (gen_db_rules.GUARDS): the triggers
  90_downgrade_snapshot.sql the encounter's snapshot as 0002 left it, for the downgrade

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-27
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0010")
FILES = ["01_tables.sql", "02_versioning.sql", "03_rls_grants.sql", "04_functions.sql",
         "05_triggers.sql"]

DOWNGRADE = [
    # The snapshot first: it names the table.
    (SQL_DIR / "90_downgrade_snapshot.sql").read_text(),
    # Its triggers, policies, grants, indexes and keys go with it.
    "DROP TABLE clinical.encounter_follow_up",
    "DROP FUNCTION public.shri_follow_up_guard()",
]


def upgrade() -> None:
    for name in FILES:
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
