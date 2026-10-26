"""Audit reads for the API; result corrections and audit inserts for the partner worker.

From Vimal's review of the role grants (issue #13, comment 6383359605), gaps 1 and 3:

1. shri_app: SELECT on audit.audit_event. It could read only the id and recorded_at columns
   (for RETURNING), but the compliance officer's audit search and chart-access report
   (GET /audit-events, GET /reports/chart-access) are API endpoints that must read the rows.
   Forced RLS keeps each clinic to its own rows; the API permissions audit-events:read and
   chart-access-reports:read keep it to CO. Still no UPDATE or DELETE, and the insert-only
   trigger refuses any change, so the trail stays append-only.

2. shri_integration:
   - SELECT on the result tables it already inserts into and updates. PostgreSQL needs SELECT
     on every column an UPDATE ... WHERE reads, so without it a corrected lab result
     (UPDATE ... SET status = 'corrected' ... WHERE id = ...) fails with "permission denied".
     Whole-table SELECT, clinic-isolated by forced RLS. Still no DELETE.
   - USAGE on audit and INSERT on audit.audit_event only, like shri_fhir_reader (0003): it can
     write audit rows but not read them, so its audit inserts must not use RETURNING, and it
     has no access to audit.break_glass_access.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-26
"""
from __future__ import annotations

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

#: Every table 0002 grants shri_integration INSERT and UPDATE on (sql_0002/90_rls_grants.sql).
RESULT_TABLES = (
    "admin.service_request_status_event",
    "admin.unmatched_result",
    "admin.unmatched_result_candidate",
    "clinical.diagnostic_report",
    "clinical.diagnostic_report_based_on",
    "clinical.diagnostic_report_category",
    "clinical.diagnostic_report_coding",
    "clinical.diagnostic_report_performer",
    "clinical.diagnostic_report_presented_form",
    "clinical.diagnostic_report_result",
    "clinical.diagnostic_report_specimen",
    "clinical.observation",
    "clinical.observation_category",
    "clinical.observation_coding",
    "clinical.observation_component",
    "clinical.observation_has_member",
    "clinical.observation_interpretation",
    "clinical.observation_performer",
    "clinical.observation_reference_range",
)

UPGRADE = [
    "GRANT SELECT ON audit.audit_event TO shri_app",
    *[f"GRANT SELECT ON {table} TO shri_integration" for table in RESULT_TABLES],
    "GRANT USAGE ON SCHEMA audit TO shri_integration",
    "GRANT INSERT ON audit.audit_event TO shri_integration",
]

DOWNGRADE = [
    "REVOKE INSERT ON audit.audit_event FROM shri_integration",
    "REVOKE USAGE ON SCHEMA audit FROM shri_integration",
    # S608: "SELECT ... FROM" here is a privilege name, and the tables are the constants above.
    *[f"REVOKE SELECT ON {table} FROM shri_integration" for table in RESULT_TABLES],  # noqa: S608
    "REVOKE SELECT ON audit.audit_event FROM shri_app",
    # Back to exactly what 0002 granted: the two columns RETURNING needs.
    "GRANT SELECT (id, recorded_at) ON audit.audit_event TO shri_app",
]


def upgrade() -> None:
    for statement in UPGRADE:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
