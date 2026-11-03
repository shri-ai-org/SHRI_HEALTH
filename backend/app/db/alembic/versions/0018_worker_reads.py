"""The partner worker reads what its two demo messages need (D97, D95; Vimal on #85 and #157).

The worker runs as shri_integration in the clinic of the message it sends (core's
system_session). It builds the NewRx and the eligibility request (270) at send time, from IDs
in the outbox row, so it reads the prescription, the check and what they point at. Every
clinic table it reads keeps its tenant_isolation policy (no TO clause), so it reads only the
clinic it works in; pharmacy, payer and payer_clearinghouse_id are platform reference tables.

Changes:
  SELECT        clinical medication_request, dosage, patient, human_name, identifier,
                encounter, coverage, coverage_payor, coverage_class, related_person,
                appointment, appointment_participant, organization; admin pharmacy,
                eligibility_check, eligibility_service_type, payer, payer_clearinghouse_id,
                facility
  SELECT (id, timezone) on admin.tenant: the service date's time zone, nothing else of the
                clinic (never its pre-registration code)
  UPDATE (status, error_code, error_message, updated_by_user_id, updated_at) on
                admin.eligibility_check: the dead-letter hook times a request out
  admin.operation: the rest of the columns core's finish_operation reads back, and
                updated_by_user_id, which it sets; the assigned-only policy (0005) still limits
                the rows

No INSERT (event_log stays the only one, 0005), no DELETE, nothing on audit. The replies are
filed by the inbound handlers, which run as shri_app, so eligibility_benefit gets nothing.

Frozen SQL in sql_0018/:
  01_grants.sql     as generated (gen_db_rules.INTEGRATION_READ_TABLES, INTEGRATION_COLUMN_READ,
                    INTEGRATION_COLUMN_UPDATE)
  02_operation.sql  hand-written, as 0005's grants on admin.operation are
  90_downgrade.sql  the grants revoked

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-02
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0018")


def upgrade() -> None:
    for name in ("01_grants.sql", "02_operation.sql"):
        op.execute((SQL_DIR / name).read_text())


def downgrade() -> None:
    op.execute((SQL_DIR / "90_downgrade.sql").read_text())
