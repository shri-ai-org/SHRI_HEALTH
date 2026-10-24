"""Audit trail, break-the-glass, duplicate review and merge, integration message store and
OpenEMR migration records."""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    AdminMixin,
    Base,
    OptionalTenantMixin,
    TimestampMixin,
    UUIDPKMixin,
    enum_type,
)
from app.db.models.enums import (
    ActorType,
    AuditAction,
    AuditOutcome,
    EndpointEnvironment,
    IntegrationKind,
    IntegrationMessageStatus,
    IssueSeverity,
    MessageDirection,
    MigrationRecordStatus,
    MigrationRunStatus,
)


# =========================================================================== audit
class AuditEvent(Base, OptionalTenantMixin):
    """Append-only, SHA-256 hash-chained per tenant (trigger assigns chain_seq under an
    advisory lock); verify with ``shri_audit_verify(tenant_id)``. Exposed as FHIR
    AuditEvent. Clinical payloads are not logged - only references."""
    __tablename__ = "audit_event"
    __table_args__ = (
        UniqueConstraint("tenant_id", "chain_seq", postgresql_nulls_not_distinct=True),
        Index("ix_audit_event_patient_time", "patient_id", "recorded_at"),
        Index("ix_audit_event_actor_time", "actor_user_id", "recorded_at"),
        Index("ix_audit_event_entity", "entity_type", "entity_id"),
        CheckConstraint("action <> 'break-glass' OR reason IS NOT NULL",
                        name="break_glass_reason"),
        CheckConstraint("actor_type <> 'user' OR actor_user_id IS NOT NULL", name="user_actor"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    event_uuid: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4, unique=True,
                                                  server_default=text("gen_random_uuid()"))
    recorded_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    actor_type: Mapped[ActorType] = mapped_column(enum_type(ActorType), nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    actor_display: Mapped[str | None] = mapped_column(String(200))
    action: Mapped[AuditAction] = mapped_column(enum_type(AuditAction), nullable=False)
    outcome: Mapped[AuditOutcome] = mapped_column(enum_type(AuditOutcome), nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(64))     # FHIR type or table name
    entity_id: Mapped[str | None] = mapped_column(String(64))
    entity_version_id: Mapped[int | None] = mapped_column(Integer)
    patient_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.patient.id"))
    purpose_of_use: Mapped[str | None] = mapped_column(String(20))   # TREAT, HPAYMT, ETREAT
    reason: Mapped[str | None] = mapped_column(String(500))
    source_ip: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(300))
    correlation_id: Mapped[str | None] = mapped_column(String(64))
    chain_seq: Mapped[int | None] = mapped_column(BigInteger)
    prev_hash: Mapped[str | None] = mapped_column(String(64))
    hash: Mapped[str | None] = mapped_column(String(64))


class BreakGlassAccess(Base, AdminMixin):
    """Time-boxed access to a restricted chart (meta.security R / V) with a stated reason.
    Reviewed in the restricted-access audit report."""
    __tablename__ = "break_glass_access"
    __table_args__ = (
        CheckConstraint("expires_at > granted_at", name="expiry_after_grant"),
        CheckConstraint("expires_at <= granted_at + interval '24 hours'", name="max_24h"),
        CheckConstraint("length(trim(reason)) >= 10", name="reason_stated"),
        CheckConstraint("(reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)",
                        name="review_pair"),
        Index("ix_break_glass_access_active", "user_id", "patient_id", "expires_at"),
    )

    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.app_user.id"), nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    granted_at: Mapped[datetime] = mapped_column(nullable=False)
    expires_at: Mapped[datetime] = mapped_column(nullable=False)
    audit_event_id: Mapped[int | None] = mapped_column(BigInteger,
                                                       ForeignKey("audit.audit_event.id"))
    reviewed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    reviewed_at: Mapped[datetime | None]


# =========================================================================== identity resolution
class DuplicateCandidate(Base, AdminMixin):
    __tablename__ = "duplicate_candidate"
    __table_args__ = (
        UniqueConstraint("patient_a_id", "patient_b_id"),
        CheckConstraint("patient_a_id < patient_b_id", name="ordered_pair"),
        CheckConstraint("match_score BETWEEN 0 AND 1", name="score_range"),
        CheckConstraint("status IN ('open', 'merged', 'not-duplicate')", name="status_code"),
        CheckConstraint("(status = 'open') = (reviewed_at IS NULL)", name="reviewed_at"),
    )

    patient_a_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"),
                                                    nullable=False)
    patient_b_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"),
                                                    nullable=False)
    match_score: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open")
    reviewed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    reviewed_at: Mapped[datetime | None]
    review_note: Mapped[str | None] = mapped_column(Text)


class DuplicateMatchEvidence(Base, AdminMixin):
    """Which attributes matched (name, DOB, phone, identifier) and their weights."""
    __tablename__ = "duplicate_match_evidence"
    __table_args__ = (UniqueConstraint("duplicate_candidate_id", "attribute"),)

    duplicate_candidate_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.duplicate_candidate.id", ondelete="CASCADE"), nullable=False)
    attribute: Mapped[str] = mapped_column(String(40), nullable=False)
    weight: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False)


class PatientMerge(Base, AdminMixin):
    """Audited merge. Moved records are listed in patient_merge_record so it can be undone;
    the merged patient gets a Patient.link 'replaced-by'."""
    __tablename__ = "patient_merge"
    __table_args__ = (
        CheckConstraint("surviving_patient_id <> merged_patient_id", name="distinct_patients"),
        CheckConstraint("(unmerged_at IS NULL) = (unmerged_by_user_id IS NULL)",
                        name="unmerge_pair"),
    )

    surviving_patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"),
                                                            nullable=False)
    merged_patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"),
                                                         nullable=False)
    duplicate_candidate_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.duplicate_candidate.id"))
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    performed_at: Mapped[datetime] = mapped_column(nullable=False)
    performed_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.app_user.id"),
                                                            nullable=False)
    unmerged_at: Mapped[datetime | None]
    unmerged_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))


class PatientMergeRecord(Base, AdminMixin):
    __tablename__ = "patient_merge_record"
    __table_args__ = (UniqueConstraint("patient_merge_id", "resource_type", "resource_id"),)

    patient_merge_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.patient_merge.id"),
                                                        nullable=False)
    resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    version_before_merge: Mapped[int] = mapped_column(Integer, nullable=False)


# =========================================================================== integration
class IntegrationEndpoint(Base, AdminMixin):
    """A configured connection: quest-hl7, waystar, erx vendor, sms, fax, payment processor.
    Credentials are OpenBao references only."""
    __tablename__ = "integration_endpoint"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name"),
        CheckConstraint("environment <> 'production' OR baa_on_file OR kind = 'payment'",
                        name="production_needs_baa"),
    )

    kind: Mapped[IntegrationKind] = mapped_column(enum_type(IntegrationKind), nullable=False)
    adapter: Mapped[str] = mapped_column(String(60), nullable=False)   # python adapter key
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    environment: Mapped[EndpointEnvironment] = mapped_column(enum_type(EndpointEnvironment),
                                                             nullable=False,
                                                             default=EndpointEnvironment.TEST.value)
    secret_ref: Mapped[str | None] = mapped_column(String(300))       # OpenBao path
    baa_on_file: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    silence_alert_minutes: Mapped[int | None] = mapped_column(SmallInteger)  # clinic hours
    last_success_at: Mapped[datetime | None]
    last_failure_at: Mapped[datetime | None]


class IntegrationEndpointSetting(Base, AdminMixin):
    """Non-secret adapter settings (host, port, facility codes ...)."""
    __tablename__ = "integration_endpoint_setting"
    __table_args__ = (UniqueConstraint("endpoint_id", "key"),
                      CheckConstraint("key !~* '(password|secret|token|apikey)'",
                                      name="no_secrets"))

    endpoint_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.integration_endpoint.id", ondelete="CASCADE"), nullable=False)
    key: Mapped[str] = mapped_column(String(80), nullable=False)
    value: Mapped[str] = mapped_column(String(1000), nullable=False)


class IntegrationMessage(Base, AdminMixin):
    """Outbox + inbox for every partner message. Payloads (HL7 / X12 / JSON / fax) are stored
    encrypted in object storage; only the key and hash are kept here."""
    __tablename__ = "integration_message"
    __table_args__ = (
        Index("ix_integration_message_dispatch", "status", "next_attempt_at"),
        Index("ix_integration_message_control", "endpoint_id", "control_id"),
        UniqueConstraint("tenant_id", "idempotency_key"),
        UniqueConstraint("endpoint_id", "direction", "control_id"),   # HL7 MSH-10 dedupe
        CheckConstraint("attempts >= 0 AND attempts <= max_attempts", name="attempts"),
        CheckConstraint("status <> 'dead-letter' OR last_error IS NOT NULL",
                        name="dead_letter_reason"),
        CheckConstraint("direction = 'outbound' OR received_at IS NOT NULL",
                        name="inbound_received_at"),
    )

    endpoint_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.integration_endpoint.id"),
                                                   nullable=False)
    direction: Mapped[MessageDirection] = mapped_column(enum_type(MessageDirection),
                                                        nullable=False)
    message_type: Mapped[str] = mapped_column(String(30), nullable=False)  # ORU^R01, 271, 837P
    status: Mapped[IntegrationMessageStatus] = mapped_column(enum_type(IntegrationMessageStatus),
                                                             nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(100))
    correlation_id: Mapped[str | None] = mapped_column(String(64))
    control_id: Mapped[str | None] = mapped_column(String(60))      # MSH-10 / ISA13 / ST02
    payload_binary_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey(
        "admin.binary_object.id"))
    response_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.integration_message.id"))
    ack_code: Mapped[str | None] = mapped_column(String(10))       # AA/AE/AR, 999 A/R
    attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=5)
    next_attempt_at: Mapped[datetime | None]
    last_error: Mapped[str | None] = mapped_column(String(2000))
    sent_at: Mapped[datetime | None]
    received_at: Mapped[datetime | None]
    processed_at: Mapped[datetime | None]


# =========================================================================== migration
class OpenemrColumnMap(Base, UUIDPKMixin, TimestampMixin):
    """FR-MIG-00 (P0): every OpenEMR 8.x column mapped as keep / merge / drop to a Shri column
    and FHIR element. Platform-wide (one matrix per OpenEMR version)."""
    __tablename__ = "openemr_column_map"
    __table_args__ = (
        UniqueConstraint("openemr_version", "source_table", "source_column"),
        CheckConstraint("action IN ('keep', 'merge', 'drop')", name="action_code"),
        CheckConstraint("action = 'drop' OR target_table IS NOT NULL", name="kept_has_target"),
        CheckConstraint("action <> 'drop' OR drop_reason IS NOT NULL", name="drop_has_reason"),
    )

    openemr_version: Mapped[str] = mapped_column(String(20), nullable=False)
    source_table: Mapped[str] = mapped_column(String(80), nullable=False)
    source_column: Mapped[str] = mapped_column(String(80), nullable=False)
    action: Mapped[str] = mapped_column(String(10), nullable=False)
    target_table: Mapped[str | None] = mapped_column(String(80))
    target_column: Mapped[str | None] = mapped_column(String(80))
    fhir_path: Mapped[str | None] = mapped_column(String(200))     # Patient.name.family
    release: Mapped[str] = mapped_column(String(4), nullable=False, default="P1")
    drop_reason: Mapped[str | None] = mapped_column(String(300))
    notes: Mapped[str | None] = mapped_column(Text)


class MigrationRun(Base, AdminMixin):
    __tablename__ = "migration_run"
    __table_args__ = (
        CheckConstraint("status <> 'accepted' OR (accepted_by_user_id IS NOT NULL AND "
                        "accepted_at IS NOT NULL)", name="accepted_has_acceptor"),
        CheckConstraint("target_environment IN ('test', 'production')", name="environment"),
    )

    source_system: Mapped[str] = mapped_column(String(40), nullable=False, default="openemr")
    source_version: Mapped[str] = mapped_column(String(40), nullable=False)
    target_environment: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[MigrationRunStatus] = mapped_column(enum_type(MigrationRunStatus),
                                                       nullable=False,
                                                       default=MigrationRunStatus.PLANNED.value)
    started_at: Mapped[datetime | None]
    completed_at: Mapped[datetime | None]
    accepted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    accepted_at: Mapped[datetime | None]
    rollback_plan_document_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.document_reference.id"))
    log_binary_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.binary_object.id"))


class MigrationReconciliation(Base, AdminMixin):
    """Source vs target counts per entity for a run."""
    __tablename__ = "migration_reconciliation"
    __table_args__ = (
        UniqueConstraint("migration_run_id", "entity"),
        CheckConstraint("source_count >= 0 AND target_count >= 0 AND mismatch_count >= 0",
                        name="counts"),
    )

    migration_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.migration_run.id",
                                                                   ondelete="CASCADE"),
                                                        nullable=False)
    entity: Mapped[str] = mapped_column(String(60), nullable=False)
    source_count: Mapped[int] = mapped_column(Integer, nullable=False)
    target_count: Mapped[int] = mapped_column(Integer, nullable=False)
    mismatch_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sample_checked: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class MigrationRecordMap(Base, AdminMixin):
    """OpenEMR (table, id) -> Shri (resource type, id). Also makes re-runs idempotent."""
    __tablename__ = "migration_record_map"
    __table_args__ = (
        UniqueConstraint("migration_run_id", "source_table", "source_id"),
        Index("ix_migration_record_map_target", "target_resource_type", "target_id"),
        CheckConstraint("status <> 'imported' OR target_id IS NOT NULL", name="imported_target"),
    )

    migration_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.migration_run.id"),
                                                        nullable=False)
    source_table: Mapped[str] = mapped_column(String(80), nullable=False)
    source_id: Mapped[str] = mapped_column(String(80), nullable=False)
    target_resource_type: Mapped[str | None] = mapped_column(String(64))
    target_id: Mapped[uuid.UUID | None]
    status: Mapped[MigrationRecordStatus] = mapped_column(enum_type(MigrationRecordStatus),
                                                          nullable=False)
    source_checksum: Mapped[str | None] = mapped_column(String(64))


class MigrationIssue(Base, AdminMixin):
    __tablename__ = "migration_issue"
    __table_args__ = (
        Index("ix_migration_issue_run_severity", "migration_run_id", "severity"),
        CheckConstraint("(resolved_at IS NULL) = (resolved_by_user_id IS NULL)",
                        name="resolved_pair"),
    )

    migration_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.migration_run.id"),
                                                        nullable=False)
    severity: Mapped[IssueSeverity] = mapped_column(enum_type(IssueSeverity), nullable=False)
    issue_type: Mapped[str] = mapped_column(String(40), nullable=False)
    source_table: Mapped[str | None] = mapped_column(String(80))
    source_id: Mapped[str | None] = mapped_column(String(80))
    field_name: Mapped[str | None] = mapped_column(String(80))
    message: Mapped[str] = mapped_column(Text, nullable=False)
    resolution: Mapped[str | None] = mapped_column(Text)
    resolved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    resolved_at: Mapped[datetime | None]
