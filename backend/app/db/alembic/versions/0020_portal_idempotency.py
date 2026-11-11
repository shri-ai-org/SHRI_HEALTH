"""Idempotency-Key for the patient portal's writes (Vimal for Thulasi's core, #85).

Core claims an Idempotency-Key per clinic, user, method, path and key. A portal request has no
staff user: its key belongs to the session's patient, so a record now names exactly one owner,
a staff user or a patient. Staff keys keep their unique constraint (a NULL user never collides);
a partial unique index does the same for patient keys. Core writes them as shri_app (its own
claim session, as for staff), so shri_portal gets no new grant, and the tenant policy is
unchanged.

Changes:
  admin.idempotency_record  user_id nullable; patient_id → clinical.patient (new), with the
                            clinic-carrying key (tenant_id, patient_id) → patient (tenant_id, id);
                            CHECK exactly one of user_id and patient_id, ck_..._one_owner;
                            UNIQUE (tenant_id, patient_id, method, path, key) WHERE patient_id
                            IS NOT NULL, uq_idempotency_record_patient_key

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None

TABLE = "idempotency_record"


def upgrade() -> None:
    op.alter_column(TABLE, "user_id", nullable=True, schema="admin")
    op.add_column(TABLE, sa.Column("patient_id", UUID(as_uuid=True), nullable=True),
                  schema="admin")
    op.create_foreign_key(op.f("fk_idempotency_record_patient_id_patient"), TABLE, "patient",
                          ["patient_id"], ["id"], source_schema="admin",
                          referent_schema="clinical")
    # Same clinic as the record (the clinic-carrying key every clinic table gets, ADR-0011).
    op.create_foreign_key(op.f("fk_idempotency_record_patient_id_tenant"), TABLE, "patient",
                          ["tenant_id", "patient_id"], ["tenant_id", "id"],
                          source_schema="admin", referent_schema="clinical")
    op.create_check_constraint(op.f("ck_idempotency_record_one_owner"), TABLE,
                               "(user_id IS NULL) <> (patient_id IS NULL)", schema="admin")
    op.create_index("uq_idempotency_record_patient_key", TABLE,
                    ["tenant_id", "patient_id", "method", "path", "key"], unique=True,
                    schema="admin", postgresql_where=sa.text("patient_id IS NOT NULL"))


def downgrade() -> None:
    # A patient's keys live 24 hours at most; they go before user_id is required again.
    op.execute("DELETE FROM admin.idempotency_record WHERE patient_id IS NOT NULL")
    op.drop_index("uq_idempotency_record_patient_key", table_name=TABLE, schema="admin")
    op.drop_constraint(op.f("ck_idempotency_record_one_owner"), TABLE, schema="admin",
                       type_="check")
    op.drop_constraint(op.f("fk_idempotency_record_patient_id_tenant"), TABLE, schema="admin",
                       type_="foreignkey")
    op.drop_constraint(op.f("fk_idempotency_record_patient_id_patient"), TABLE, schema="admin",
                       type_="foreignkey")
    op.drop_column(TABLE, "patient_id", schema="admin")
    op.alter_column(TABLE, "user_id", nullable=False, schema="admin")
