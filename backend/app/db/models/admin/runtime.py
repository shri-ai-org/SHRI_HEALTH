"""Thulasi's core runtime tables (issue #13, follow-up a): server-side login sessions,
idempotency records, long-running operations and the event replay log.

All four are clinic-scoped under forced row-level security. Nothing deletes from them but
``admin.purge_expired_runtime_rows()`` (migration 0005), which core's clean-up job calls as
shri_app: it removes, across clinics, only rows past retention: sessions 24 hours after they end
(the earliest of logout, idle timeout and absolute expiry), idempotency records at
``expires_at``, events after 10 minutes, finished operations after 7 days. No request path can
delete a live session or a stored response. A dedicated maintenance role instead of shri_app is
open on #52; it would be a small follow-up migration.

None of them holds patient data in clear text: tokens are stored as SHA-256 hashes or encrypted
(encrypt_field, OpenBao transit), and events carry IDs and statuses only (EVENTS §1).

For core (Thulasi), from the #52 reviews:
- the CSRF token is not stored at all: core derives it from the session with a keyed HMAC;
- ``response_headers`` holds only ``Location``, ``ETag`` and the content type, never
  ``Set-Cookie`` or anything else sensitive;
- replay stops at 5 minutes (EVENTS §3), well inside the 10-minute retention; replay after a
  ``seq`` re-reads a small overlap and de-duplicates on ``id``, because an identity ``seq`` is
  not in commit order;
- replay re-checks access every time from ``patient_id``, ``target_user_id`` and
  ``target_role_code``, never from what was allowed when the event was written.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Identity,
    Index,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    false,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    ADMIN_SCHEMA,
    CLINICAL_SCHEMA,
    AdminMixin,
    Base,
    TenantMixin,
    UUIDPKMixin,
    enum_type,
)
from app.db.models.enums import IdempotencyState, OperationStatus

SHA256_HEX = "~ '^[0-9a-f]{64}$'"
# encrypt_field returns OpenBao Transit ciphertext as it comes: vault:v<key version>:<base64>.
# The version grows with each key rotation (Thulasi, #52). Refuses plain text by mistake.
CIPHERTEXT = "~ '^vault:v[0-9]+:'"


class AppSession(Base, AdminMixin):
    """One server-side login session (reference-token login, T7, D52). The session token is
    stored only as a SHA-256 hash, and Keycloak's tokens only encrypted. The CSRF token is not
    stored: core derives it from the session (ADR-0006 §4). The cookie is resolved before the
    clinic is known through ``admin.lookup_session(token_hash)``, a narrow SECURITY DEFINER
    function, never by a cross-clinic read."""
    __tablename__ = "app_session"
    __table_args__ = (
        UniqueConstraint("token_hash"),
        Index("ix_app_session_user", "tenant_id", "user_id"),
        Index("ix_app_session_expires", "expires_at"),
        CheckConstraint(f"token_hash {SHA256_HEX}", name="token_hash_format"),
        CheckConstraint("idle_expires_at <= expires_at", name="idle_within_absolute"),
        CheckConstraint(f"keycloak_access_token_enc {CIPHERTEXT} AND "
                        f"keycloak_refresh_token_enc {CIPHERTEXT}", name="tokens_encrypted"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.app_user.id"),
                                               nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
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
        CheckConstraint(f"response_body_enc IS NULL OR response_body_enc {CIPHERTEXT}",
                        name="response_body_encrypted"),
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
    """Long-running 202 work (T26, API_STANDARDS §13), kept 7 days once finished. IDs, kinds and
    statuses only; ``error`` is a Problem without patient data. In the MVP only its creator sees
    it (core). An operation the partner worker completes (eligibility, medication history) is
    marked ``assigned_to_integration``: shri_integration may then update its status, result and
    error, and nothing else (migration 0005).

    Not purged: an operation that never finishes (stuck in ``queued`` or ``running``). Whether
    the purge removes it after 7 days or core marks it failed is open on #52."""
    __tablename__ = "operation"
    __table_args__ = (
        Index("ix_operation_creator", "tenant_id", "created_by_user_id", "created_at"),
        Index("ix_operation_created", "created_at"),
        CheckConstraint("(completed_at IS NOT NULL) = "
                        "(status IN ('succeeded', 'failed', 'cancelled'))",
                        name="completed_when_final"),
        CheckConstraint("status <> 'failed' OR error IS NOT NULL", name="failure_has_error"),
        CheckConstraint("(result_type IS NULL) = (result_id IS NULL)", name="result_pair"),
    )
    # Required, and kept: the creator is who may see the operation (overrides the mixin's
    # nullable ON DELETE SET NULL).
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey(f"{ADMIN_SCHEMA}.app_user.id", ondelete="RESTRICT"), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)   # the contract's OperationKind
    status: Mapped[OperationStatus] = mapped_column(enum_type(OperationStatus), nullable=False)
    result_type: Mapped[str | None] = mapped_column(String(64))
    result_id: Mapped[uuid.UUID | None]
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    completed_at: Mapped[datetime | None]
    assigned_to_integration: Mapped[bool] = mapped_column(Boolean, nullable=False,
                                                          server_default=false())


class EventLog(Base, UUIDPKMixin, TenantMixin):
    """Thin events for SSE delivery and Last-Event-ID replay (T28), kept 10 minutes; replay
    covers 5 (EVENTS §3). IDs and statuses only (EVENTS §1). ``seq`` orders replay after a given
    event; ``id`` is the event UUID sent to the browser. ``patient_id``, ``target_user_id`` and
    ``target_role_code`` say whom the event concerns, so core can re-check access on every
    replay (T28, D37). The role is a code from core's ROLE_PERMISSIONS (``FD``, ``MD``, ...), not
    a reference to ``admin.role``, which is not seeded. The partner worker may insert events
    (``result.received``)."""
    __tablename__ = "event_log"
    __table_args__ = (
        Index("ix_event_log_replay", "tenant_id", "seq"),
        Index("ix_event_log_created", "created_at"),
        # A role code as core's ROLE_PERMISSIONS spells it (FD, MD, ...). Only the format is
        # checked: core owns the list, so a new role (PAT, D84) needs no migration.
        CheckConstraint("target_role_code ~ '^[A-Z]{2,10}$'", name="target_role_code_format"),
    )
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), nullable=False,
                                     unique=True)
    facility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.facility.id"))
    # Read on replay and filtered by core, never searched in SQL: no index of their own, so
    # this mostly-written table pays only for (tenant_id, seq) (Vimal's review of #52).
    patient_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(f"{CLINICAL_SCHEMA}.patient.id"))
    target_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(f"{ADMIN_SCHEMA}.app_user.id"))
    target_role_code: Mapped[str | None] = mapped_column(Text)
    type: Mapped[str] = mapped_column(String(100), nullable=False)
    subject: Mapped[str] = mapped_column(String(200), nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False,
                                                 server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
