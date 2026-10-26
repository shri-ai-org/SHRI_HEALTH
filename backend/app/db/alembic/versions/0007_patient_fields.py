"""What the patient endpoints need (A45; issue #13, follow-up d; locked with the schema, D72).

New tables, clinic-scoped with forced RLS:
  admin.mrn_counter   one per practice (D41): prefix, MRN system and the next number.
                      admin.next_mrn() takes the next MRN inside the registration transaction;
                      the number only grows, and the prefix and system are fixed once the first
                      MRN is issued (shri_mrn_counter_guard). No role may delete it.
  admin.employer      the employer of a patient or a related person (D38): name, phone, U.S.
                      address. A change touches its patient or related person, so the ETag
                      changes; shri_app may delete it to clear the employer.

Changes to existing tables:
  clinical.patient    the D39 coded demographics: gender identity, sexual orientation,
                      occupation, industry, tribal affiliation (system, code, display, text
                      each; the system is a registered code system). Not served on /fhir yet.
  clinical.encounter  ext_self_pay, from check-in (CheckInRequest.selfPay). The database
                      refuses an insurance claim for a self-pay visit, except the void of one
                      sent before (shri_claim_not_self_pay).
  admin.facility      timezone NOT NULL (D40); a facility without one takes its practice's.

Reference data: the TribalEntityUS code system, and the setting
registration.show_sexual_orientation_and_gender_identity (boolean, default false; A49).

Frozen SQL in sql_0007/:
  01_tables.sql          generated from the models: the new tables
  02_existing_tables.sql hand-written: the column changes to existing tables
  03_rls_grants.sql      generated (gen_db_rules.rls_sql): RLS and grants for the new tables
  04_functions.sql       hand-written: shri_claim_not_self_pay, shri_mrn_counter_guard,
                         admin.next_mrn (EXECUTE for shri_app only)
  05_triggers.sql        generated (gen_db_rules.GUARDS): the triggers that attach them
  06_seed.sql            generated: the code system and the setting

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-26
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0007")
FILES = ["01_tables.sql", "02_existing_tables.sql", "03_rls_grants.sql", "04_functions.sql",
         "05_triggers.sql", "06_seed.sql"]
D39_CODED = ("gender_identity", "sexual_orientation", "occupation", "industry",
             "tribal_affiliation")

DOWNGRADE = [
    # Refused, rightly, once a practice has set it (tenant_setting refers to the key): a
    # downgrade past 0007 is for development only.
    "DELETE FROM admin.setting_definition "
    "WHERE key = 'registration.show_sexual_orientation_and_gender_identity'",
    "DROP FUNCTION admin.next_mrn()",
    "DROP TRIGGER trg_claim_self_pay ON admin.claim",
    "DROP FUNCTION public.shri_claim_not_self_pay()",
    # Their triggers, policies, grants, indexes and keys go with them.
    "DROP TABLE admin.employer",
    "DROP TABLE admin.mrn_counter",
    "DROP FUNCTION public.shri_mrn_counter_guard()",
    # The time zones filled in by the upgrade stay.
    "ALTER TABLE admin.facility ALTER COLUMN timezone DROP NOT NULL",
    "ALTER TABLE clinical.encounter DROP COLUMN ext_self_pay",
    # Their checks and keys go with them.
    *(f"ALTER TABLE clinical.patient DROP COLUMN ext_{k}_{part}"
      for k in D39_CODED for part in ("system", "code", "display", "text")),
    "DELETE FROM admin.code_system "
    "WHERE uri = 'http://terminology.hl7.org/CodeSystem/v3-TribalEntityUS'",
]


def upgrade() -> None:
    for name in FILES:
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
