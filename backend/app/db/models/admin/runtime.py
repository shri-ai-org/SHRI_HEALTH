"""Thulasi's core runtime tables (issue #13, follow-up a): server-side login sessions,
idempotency records, long-running operations and the event replay log.

All four are clinic-scoped under forced row-level security. Retention is enforced by core's
clean-up job, clinic by clinic: sessions 24 hours after they end, idempotency records after 24
hours, operations after 7 days, events after 10 minutes. None of them holds patient data in clear
text: tokens are stored as SHA-256 hashes or encrypted (encrypt_field, OpenBao transit), and
events carry IDs and statuses only (EVENTS §1).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Identity,
    Index,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import ADMIN_SCHEMA, AdminMixin, Base, TenantMixin, UUIDPKMixin, enum_type
from app.db.models.enums import IdempotencyState, OperationStatus

SHA256_HEX = "~ '^[0-9a-f]{64}$'"


class AppSession(Base, AdminMixin):
    """One server-side login session (reference-token login, T7, D52). The session and CSRF
    tokens are stored only as SHA-256 hashes, and Keycloak's tokens only encrypted. The cookie is
    resolved before the clinic is known through ``admin.lookup_session(token_hash)``, a narrow
    SECURITY DEFINER function, never by a cross-clinic read."""
    __tablename__ = "app_session"
    __table_args__ = (
        UniqueConstraint("token_hash"),
        Index("ix_app_session_user", "tenant_id", "user_id"),
        Index("ix_app_session_expires", "expires_at"),
        CheckConstraint(f"token_hash {SHA256_HEX}", name="token_hash_format"),
        CheckConstraint(f"csrf_token_hash {SHA256_HEX}", name="csrf_token_hash_format"),
        CheckConstraint("idle_expires_at <= expires_at", name="idle_within_absolute"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.app_user.id"),
                                               nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    csrf_token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    keycloak_access_token_enc: Mapped[str] = mapped_column(Text, nullable=False)
    keycloak_refresh_token_enc: Mapped[str] = mapped_column(Text, nullable=False)
    last_activity_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    # #35: user-initiated requests refresh the stored Keycloak tokens when this is > 5 min old.
    tokens_refreshed_at: Mapped[datetime] = mapped_column(nullable=False,
                                                          server_default=func.now())
    idle_expires_at: Mapped[datetime] = mapped_column(nullable=False)
    expires_at: Mapped[datetime] = mapped_column(nullable=False)
    revoked_at: Mapped[datetime | None]


class IdempotencyRecord(Base, AdminMixin):
    """One use of an Idempotency-Key (T21, ADR-0007), kept 24 hours. The request body is never
    stored, only its hash; the response body only encrypted (it may hold patient data). 5xx and
    429 responses are not stored."""
    __tablename__ = "idempotency_record"
    __table_args__ = (
        UniqueConstraint("tenant_id", "user_id", "method", "path", "key"),
        Index("ix_idempotency_record_expires", "expires_at"),
        CheckConstraint(f"request_hash {SHA256_HEX}", name="request_hash_format"),
        CheckConstraint("method IN ('POST', 'PUT', 'PATCH')", name="unsafe_method"),
        CheckConstraint("state <> 'done' OR response_status IS NOT NULL",
                        name="done_has_response"),
        CheckConstraint("response_status IS NULL OR (response_status BETWEEN 200 AND 499 "
                        "AND response_status <> 429)", name="stored_status"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.app_user.id"),
                                               nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    path: Mapped[str] = mapped_column(String(500), nullable=False)
    key: Mapped[str] = mapped_column(String(255), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[IdempotencyState] = mapped_column(enum_type(IdempotencyState), nullable=False)
    response_status: Mapped[int | None] = mapped_column(SmallInteger)
    response_headers: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    response_body_enc: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(nullable=False)


class Operation(Base, AdminMixin):
    """Long-running 202 work (T26, API_STANDARDS §13), kept 7 days. IDs, kinds and statuses only;
    ``error`` is a Problem without patient data. In the MVP only its creator sees it (core)."""
    __tablename__ = "operation"
    __table_args__ = (
        Index("ix_operation_creator", "tenant_id", "created_by_user_id", "created_at"),
        Index("ix_operation_created", "created_at"),
        CheckConstraint("created_by_user_id IS NOT NULL", name="creator_required"),
        CheckConstraint("(completed_at IS NOT NULL) = "
                        "(status IN ('succeeded', 'failed', 'cancelled'))",
                        name="completed_when_final"),
        CheckConstraint("status <> 'failed' OR error IS NOT NULL", name="failure_has_error"),
        CheckConstraint("(result_type IS NULL) = (result_id IS NULL)", name="result_pair"),
    )
    kind: Mapped[str] = mapped_column(String(60), nullable=False)
    status: Mapped[OperationStatus] = mapped_column(enum_type(OperationStatus), nullable=False)
    result_type: Mapped[str | None] = mapped_column(String(64))
    result_id: Mapped[uuid.UUID | None]
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    completed_at: Mapped[datetime | None]


class EventLog(Base, UUIDPKMixin, TenantMixin):
    """Thin events for SSE delivery and Last-Event-ID replay (T28), kept 10 minutes. IDs and
    statuses only (EVENTS §1). ``seq`` orders replay after a given event; ``id`` is the event
    UUID sent to the browser."""
    __tablename__ = "event_log"
    __table_args__ = (
        Index("ix_event_log_replay", "tenant_id", "seq"),
        Index("ix_event_log_created", "created_at"),
    )
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), nullable=False,
                                     unique=True)
    facility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.facility.id"))
    type: Mapped[str] = mapped_column(String(100), nullable=False)
    subject: Mapped[str] = mapped_column(String(200), nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False,
                                                 server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
