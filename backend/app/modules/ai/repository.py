"""The AI module's data: switches, prompt versions, and the gateway's own records
(``admin.ai_request``, ``ai_request_input_ref``, ``ai_suggestion``, ``ai_suggestion_unknown``).

These are admin tables (Anand's schema, ``app/db/models/admin/ai.py``), written through the
request's session, so the clinic's row-level security applies. Nothing here commits. Clinical
records (the draft note) are never written here: the encounters module writes them.

``ai_request`` keeps hashes and record references only, never a transcript, prompt or draft
text (FRS §3.4; the model's structured output is the suggestion's ``content``, reviewable
by the clinician, which is a clinical-grade record, not a log).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import TENANT_ID_INFO_KEY, session_user_id
from app.db.models.admin.ai import (
    AIFeatureSetting,
    AIRequest,
    AIRequestInputRef,
    AISuggestion,
    AISuggestionUnknown,
    PromptTemplate,
)
from app.db.models.admin.core import Tenant
from app.db.models.enums import AIDecision, AIFeature, AIRequestStatus

from .schemas import PromptRef, SourceRef


@dataclass(frozen=True)
class Switches:
    clinic: bool    # admin.tenant.ai_enabled: the clinic-wide switch
    feature: bool   # admin.ai_feature_setting.is_enabled; a feature with no row is off


@dataclass(frozen=True)
class RequestRecord:
    feature: AIFeature
    status: AIRequestStatus
    pipeline_version: str
    model_name: str
    prompt_template_id: UUID
    input_sha256: str
    patient_id: UUID | None
    encounter_id: UUID | None
    latency_ms: int | None
    input_tokens: int | None
    output_tokens: int | None
    error_message: str | None
    correlation_id: str | None
    sources: tuple[SourceRef, ...]


@dataclass(frozen=True)
class SuggestionRecord:
    request_id: UUID
    feature: AIFeature
    patient_id: UUID | None
    encounter_id: UUID | None
    target_resource_type: str
    content: dict[str, Any]
    confidence: str
    rationale: str
    unknowns: tuple[str, ...]


class AIRepository(Protocol):
    async def switches(self, db: AsyncSession, feature: AIFeature) -> Switches: ...

    async def set_feature(self, db: AsyncSession, feature: AIFeature, enabled: bool,
                          reason: str | None = None) -> None: ...

    async def active_prompt(self, db: AsyncSession, code: str) -> PromptRef | None: ...

    async def publish_prompt(self, db: AsyncSession, code: str, feature: AIFeature,
                             template: str, output_schema: dict[str, Any] | None
                             ) -> PromptRef: ...

    async def record_request(self, db: AsyncSession, rec: RequestRecord
                             ) -> tuple[UUID, datetime]: ...

    async def record_suggestion(self, db: AsyncSession, rec: SuggestionRecord) -> UUID: ...

    async def set_suggestion_target(self, db: AsyncSession, suggestion_id: UUID,
                                    target_id: UUID) -> None: ...

    async def decide(self, db: AsyncSession, suggestion_id: UUID, decision: AIDecision, *,
                     edited_content: dict[str, Any] | None = None,
                     rejection_reason: str | None = None) -> None: ...


def _prompt(row: PromptTemplate) -> PromptRef:
    return PromptRef(id=row.id, code=row.code, version=row.version,
                     feature=AIFeature(row.feature), template=row.template,
                     output_schema=row.output_schema)


class SqlAIRepository:
    async def switches(self, db: AsyncSession, feature: AIFeature) -> Switches:
        # RLS (tenant_self) shows the session's own clinic only.
        clinic = (await db.execute(select(Tenant.ai_enabled))).scalar_one_or_none()
        enabled = (await db.execute(select(AIFeatureSetting.is_enabled).where(
            AIFeatureSetting.feature == feature))).scalar_one_or_none()
        return Switches(clinic=bool(clinic), feature=bool(enabled))

    async def set_feature(self, db: AsyncSession, feature: AIFeature, enabled: bool,
                          reason: str | None = None) -> None:
        """One clinic's switch for one feature. Turning it off needs a reason (the table's
        ``disabled_has_reason``); the AI settings endpoint (#115) will call this."""
        row = (await db.execute(select(AIFeatureSetting).where(
            AIFeatureSetting.feature == feature).with_for_update())).scalar_one_or_none()
        user = session_user_id(db)
        if row is None:
            db.add(AIFeatureSetting(feature=feature, is_enabled=enabled, reason=reason,
                                    created_by_user_id=user, updated_by_user_id=user))
        else:
            row.is_enabled, row.reason, row.updated_by_user_id = enabled, reason, user
        await db.flush()

    async def active_prompt(self, db: AsyncSession, code: str) -> PromptRef | None:
        """The clinic's active version of the prompt, else the platform's (tenant_id NULL)."""
        rows = (await db.execute(select(PromptTemplate).where(
            PromptTemplate.code == code, PromptTemplate.is_active.is_(True)).order_by(
            PromptTemplate.tenant_id.is_(None)))).scalars().all()
        return _prompt(rows[0]) if rows else None

    async def publish_prompt(self, db: AsyncSession, code: str, feature: AIFeature,
                             template: str, output_schema: dict[str, Any] | None
                             ) -> PromptRef:
        """A new active version of the clinic's prompt; the earlier one stays, inactive."""
        current = (await db.execute(select(func.max(PromptTemplate.version)).where(
            PromptTemplate.code == code, PromptTemplate.tenant_id.is_not(None)))).scalar()
        await db.execute(update(PromptTemplate).where(
            PromptTemplate.code == code, PromptTemplate.tenant_id.is_not(None),
            PromptTemplate.is_active.is_(True)).values(is_active=False))
        await db.flush()
        row = PromptTemplate(code=code, version=(current or 0) + 1, feature=feature,
                             template=template, output_schema=output_schema, is_active=True,
                             tenant_id=db.info.get(TENANT_ID_INFO_KEY))
        db.add(row)
        await db.flush()
        return _prompt(row)

    async def record_request(self, db: AsyncSession, rec: RequestRecord
                             ) -> tuple[UUID, datetime]:
        user = session_user_id(db)
        row = AIRequest(feature=rec.feature, status=rec.status, user_id=user,
                        patient_id=rec.patient_id, encounter_id=rec.encounter_id,
                        pipeline_version=rec.pipeline_version, model_name=rec.model_name,
                        prompt_template_id=rec.prompt_template_id,
                        input_sha256=rec.input_sha256, latency_ms=rec.latency_ms,
                        input_tokens=rec.input_tokens, output_tokens=rec.output_tokens,
                        error_message=rec.error_message, correlation_id=rec.correlation_id,
                        created_by_user_id=user, updated_by_user_id=user)
        db.add(row)
        await db.flush()
        db.add_all(AIRequestInputRef(ai_request_id=row.id, resource_type=s.resource_type,
                                     resource_id=s.resource_id, resource_version_id=s.version,
                                     created_by_user_id=user)
                   for s in _unique(rec.sources))
        await db.flush()
        await db.refresh(row, attribute_names=["created_at"])
        return row.id, row.created_at

    async def record_suggestion(self, db: AsyncSession, rec: SuggestionRecord) -> UUID:
        user = session_user_id(db)
        row = AISuggestion(ai_request_id=rec.request_id, feature=rec.feature,
                           patient_id=rec.patient_id, encounter_id=rec.encounter_id,
                           target_resource_type=rec.target_resource_type, content=rec.content,
                           confidence=rec.confidence, rationale=rec.rationale,
                           created_by_user_id=user, updated_by_user_id=user)
        db.add(row)
        await db.flush()
        db.add_all(AISuggestionUnknown(ai_suggestion_id=row.id, description=u,
                                       created_by_user_id=user) for u in rec.unknowns)
        await db.flush()
        return row.id

    async def set_suggestion_target(self, db: AsyncSession, suggestion_id: UUID,
                                    target_id: UUID) -> None:
        """Once only: the database refuses a second target (shri_ai_suggestion_guard)."""
        await db.execute(update(AISuggestion).where(AISuggestion.id == suggestion_id).values(
            target_id=target_id, updated_by_user_id=session_user_id(db)))

    async def decide(self, db: AsyncSession, suggestion_id: UUID, decision: AIDecision, *,
                     edited_content: dict[str, Any] | None = None,
                     rejection_reason: str | None = None) -> None:
        """A person's accept, edit or reject (D70), once; the session's user is the reviewer.
        The decision endpoint (#113) will call this; the gateway never does."""
        user = session_user_id(db)
        if user is None:
            raise PermissionError("a decision needs a signed-in user")
        await db.execute(update(AISuggestion).where(AISuggestion.id == suggestion_id).values(
            decision=decision, decided_by_user_id=user, decided_at=func.now(),
            edited_content=edited_content, rejection_reason=rejection_reason,
            updated_by_user_id=user))


def _unique(sources: Sequence[SourceRef]) -> list[SourceRef]:
    seen: set[tuple[str, UUID]] = set()
    out = []
    for s in sources:
        if (s.resource_type, s.resource_id) not in seen:
            seen.add((s.resource_type, s.resource_id))
            out.append(s)
    return out
