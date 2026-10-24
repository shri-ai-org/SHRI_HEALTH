"""AI gateway records, reviewable suggestions, audio / transcripts and RAG knowledge (FRS §3.4).

Every AI output is labelled, carries a confidence band, a rationale and evidence links, and
every accept / edit / reject is recorded once with reviewer and time (DB trigger)."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (Boolean, CheckConstraint, Computed, ForeignKey, ForeignKeyConstraint,
                        Index, Integer, Numeric, SmallInteger, String, Text, UniqueConstraint, text)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (AdminMixin, Base, OptionalTenantMixin, TimestampMixin, UUIDPKMixin,
                          enum_type)
from app.db.models.enums import (AIConfidence, AIDecision, AIFeature, AIRequestStatus, AudioMode,
                               AudioStatus, KnowledgeApprovalStatus)

EMBEDDING_DIM = 1024   # Qwen3-Embedding-0.6B
RESOURCE_TYPE = "resource_type ~ '^[A-Z][A-Za-z]{2,63}$'"


class AIFeatureSetting(Base, AdminMixin):
    """Feature-level kill switch (the tenant-level switch is tenant.ai_enabled)."""
    __tablename__ = "ai_feature_setting"
    __table_args__ = (UniqueConstraint("tenant_id", "feature"),
                      CheckConstraint("is_enabled OR reason IS NOT NULL",
                                      name="disabled_has_reason"))

    feature: Mapped[AIFeature] = mapped_column(enum_type(AIFeature), nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    reason: Mapped[str | None] = mapped_column(String(500))


class PromptTemplate(Base, UUIDPKMixin, OptionalTenantMixin, TimestampMixin):
    """Versioned prompts (mirrors the MLflow registry); one active version per code."""
    __tablename__ = "prompt_template"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code", "version", postgresql_nulls_not_distinct=True),
        Index("uq_prompt_template_one_active", "tenant_id", "code", unique=True,
              postgresql_where=text("is_active"), postgresql_nulls_not_distinct=True),
        CheckConstraint("version >= 1", name="version"),
    )

    code: Mapped[str] = mapped_column(String(80), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    feature: Mapped[AIFeature] = mapped_column(enum_type(AIFeature), nullable=False)
    template: Mapped[str] = mapped_column(Text, nullable=False)
    output_schema: Mapped[dict[str, Any] | None] = mapped_column(JSONB)   # JSON Schema doc
    mlflow_run_id: Mapped[str | None] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class AIRequest(Base, AdminMixin):
    """One gateway call. Stores hashes and record references, never raw PHI payloads."""
    __tablename__ = "ai_request"
    __table_args__ = (
        Index("ix_ai_request_feature_time", "tenant_id", "feature", "created_at"),
        CheckConstraint("status <> 'failed' OR error_message IS NOT NULL", name="failed_reason"),
        CheckConstraint("input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$'",
                        name="sha256_format"),
    )

    feature: Mapped[AIFeature] = mapped_column(enum_type(AIFeature), nullable=False)
    status: Mapped[AIRequestStatus] = mapped_column(enum_type(AIRequestStatus), nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    patient_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.patient.id"), index=True)
    encounter_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.encounter.id"))
    pipeline_version: Mapped[str] = mapped_column(String(40), nullable=False)
    model_name: Mapped[str | None] = mapped_column(String(120))
    model_version: Mapped[str | None] = mapped_column(String(80))
    prompt_template_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.prompt_template.id"))
    input_sha256: Mapped[str | None] = mapped_column(String(64))
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(String(1000))
    correlation_id: Mapped[str | None] = mapped_column(String(64), index=True)


class AIRequestInputRef(Base, AdminMixin):
    """Which chart records (resource + version) were sent to the model."""
    __tablename__ = "ai_request_input_ref"
    __table_args__ = (UniqueConstraint("ai_request_id", "resource_type", "resource_id"),
                      CheckConstraint(RESOURCE_TYPE, name="resource_type_format"))

    ai_request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.ai_request.id",
                                                                ondelete="CASCADE"),
                                                     nullable=False)
    resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    resource_version_id: Mapped[int | None] = mapped_column(Integer)


class AIRequestRetrievedChunk(Base, AdminMixin):
    __tablename__ = "ai_request_retrieved_chunk"
    __table_args__ = (UniqueConstraint("ai_request_id", "rank"),)

    ai_request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.ai_request.id",
                                                                ondelete="CASCADE"),
                                                     nullable=False)
    knowledge_chunk_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.knowledge_chunk.id"),
                                                          nullable=False)
    rank: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    score: Mapped[Decimal | None] = mapped_column(Numeric(8, 6))


class AISuggestion(Base, AdminMixin):
    """A reviewable AI output (note draft, summary, code, order, alert, extraction).
    ``content`` is the model's structured output document (validated against the prompt's
    output schema); it is immutable, and the review decision is recorded once."""
    __tablename__ = "ai_suggestion"
    __table_args__ = (
        Index("ix_ai_suggestion_pending", "tenant_id", "decision", "feature"),
        Index("ix_ai_suggestion_target", "target_resource_type", "target_id"),
        CheckConstraint("decision = 'pending' OR decided_at IS NOT NULL",
                        name="decision_recorded"),
        CheckConstraint("decision NOT IN ('accepted', 'edited', 'rejected') "
                        "OR decided_by_user_id IS NOT NULL", name="decision_has_reviewer"),
        CheckConstraint("decision <> 'edited' OR edited_content IS NOT NULL",
                        name="edit_has_content"),
        CheckConstraint("decision <> 'rejected' OR rejection_reason IS NOT NULL",
                        name="rejection_has_reason"),
        CheckConstraint("jsonb_typeof(content) = 'object'", name="content_is_object"),
    )

    ai_request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.ai_request.id"), nullable=False)
    feature: Mapped[AIFeature] = mapped_column(enum_type(AIFeature), nullable=False)
    patient_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.patient.id"), index=True)
    encounter_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.encounter.id"))
    target_resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    target_id: Mapped[uuid.UUID | None]
    content: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    confidence: Mapped[AIConfidence] = mapped_column(enum_type(AIConfidence), nullable=False)
    rationale: Mapped[str] = mapped_column(Text, nullable=False)
    decision: Mapped[AIDecision] = mapped_column(enum_type(AIDecision), nullable=False,
                                                 default=AIDecision.PENDING.value,
                                                 server_default=AIDecision.PENDING.value)
    decided_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    decided_at: Mapped[datetime | None]
    edited_content: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    rejection_reason: Mapped[str | None] = mapped_column(String(500))


class AISuggestionEvidence(Base, AdminMixin):
    """Links from a suggestion to the chart records that support it (§3.4 rationale)."""
    __tablename__ = "ai_suggestion_evidence"
    __table_args__ = (UniqueConstraint("ai_suggestion_id", "sequence"),
                      CheckConstraint(RESOURCE_TYPE, name="resource_type_format"))

    ai_suggestion_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.ai_suggestion.id", ondelete="CASCADE"), nullable=False)
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    excerpt: Mapped[str | None] = mapped_column(String(1000))


class AISuggestionUnknown(Base, AdminMixin):
    """Facts the model could not determine; kept unknown, never invented (§3.4)."""
    __tablename__ = "ai_suggestion_unknown"

    ai_suggestion_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.ai_suggestion.id", ondelete="CASCADE"), nullable=False, index=True)
    description: Mapped[str] = mapped_column(String(500), nullable=False)


class AudioRecording(Base, AdminMixin):
    """AI-01 audio (ambient, dictation or uploaded). The composite FK on (consent, kind)
    means it can only reference an *ambient-recording* consent of the same patient."""
    __tablename__ = "audio_recording"
    __table_args__ = (
        ForeignKeyConstraint(["consent_id", "consent_kind"], ["clinical.consent.id", "clinical.consent.ext_kind"],
                             name="fk_audio_recording_consent_kind"),
        CheckConstraint("duration_seconds IS NULL OR duration_seconds >= 0", name="duration"),
        CheckConstraint("(status = 'purged') = (purged_at IS NOT NULL)", name="purged_at"),
    )

    encounter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.encounter.id"), nullable=False,
                                                    index=True)
    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"), nullable=False)
    consent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.consent.id"), nullable=False)
    consent_kind: Mapped[str] = mapped_column(String(40),
                                              Computed("'ambient-recording'", persisted=True))
    mode: Mapped[AudioMode] = mapped_column(enum_type(AudioMode), nullable=False)
    binary_object_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.binary_object.id"))
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[AudioStatus] = mapped_column(enum_type(AudioStatus), nullable=False,
                                                default=AudioStatus.UPLOADED.value)
    retention_until: Mapped[date | None]
    purged_at: Mapped[datetime | None]


class Transcript(Base, AdminMixin):
    """Original transcript, preserved; clinician edits live in the note (Composition)."""
    __tablename__ = "transcript"

    audio_recording_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.audio_recording.id"),
                                                          nullable=False, unique=True)
    encounter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.encounter.id"), nullable=False)
    ai_request_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.ai_request.id"))
    language: Mapped[str] = mapped_column(String(20), nullable=False, default="en-US")
    binary_object_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.binary_object.id"),
                                                        nullable=False)
    segment_count: Mapped[int | None] = mapped_column(Integer)
    asr_model: Mapped[str | None] = mapped_column(String(80))
    retention_until: Mapped[date | None]
    purged_at: Mapped[datetime | None]


class KnowledgeSource(Base, UUIDPKMixin, OptionalTenantMixin, TimestampMixin):
    """Approved RAG content with governance. tenant_id NULL = shared guideline."""
    __tablename__ = "knowledge_source"
    __table_args__ = (
        CheckConstraint("approval_status <> 'approved' OR "
                        "(approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)",
                        name="approved_has_approver"),
    )

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    source_type: Mapped[str] = mapped_column(String(40), nullable=False)  # guideline, protocol
    publisher: Mapped[str | None] = mapped_column(String(200))
    version: Mapped[str] = mapped_column(String(40), nullable=False)
    binary_object_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.binary_object.id"))
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    approval_status: Mapped[KnowledgeApprovalStatus] = mapped_column(
        enum_type(KnowledgeApprovalStatus), nullable=False,
        default=KnowledgeApprovalStatus.DRAFT.value)
    approved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    approved_at: Mapped[datetime | None]
    effective_date: Mapped[date | None]
    withdrawn_at: Mapped[datetime | None]
    superseded_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.knowledge_source.id"))
    last_indexed_at: Mapped[datetime | None]


class KnowledgeSourceRole(Base, OptionalTenantMixin):
    """Roles allowed to retrieve a source (none listed = all clinical roles)."""
    __tablename__ = "knowledge_source_role"

    knowledge_source_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.knowledge_source.id", ondelete="CASCADE"), primary_key=True)
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.role.id", ondelete="CASCADE"),
                                               primary_key=True)


class KnowledgeChunk(Base, UUIDPKMixin, OptionalTenantMixin, TimestampMixin):
    """Hybrid retrieval: pgvector HNSW + PostgreSQL full-text (generated tsvector)."""
    __tablename__ = "knowledge_chunk"
    __table_args__ = (
        UniqueConstraint("knowledge_source_id", "chunk_index"),
        Index("ix_knowledge_chunk_embedding", "embedding", postgresql_using="hnsw",
              postgresql_with={"m": 16, "ef_construction": 64},
              postgresql_ops={"embedding": "vector_cosine_ops"}),
        Index("ix_knowledge_chunk_tsv", "content_tsv", postgresql_using="gin"),
    )

    knowledge_source_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.knowledge_source.id", ondelete="CASCADE"), nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_tsv = mapped_column(TSVECTOR, Computed("to_tsvector('english', content)",
                                                   persisted=True))
    embedding = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    embedding_model: Mapped[str | None] = mapped_column(String(80))
    section_path: Mapped[str | None] = mapped_column(String(500))
    page_number: Mapped[int | None] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
