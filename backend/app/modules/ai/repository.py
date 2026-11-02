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

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import func, select, text, update
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

from .schemas import (
    NOTE_SECTION,
    AiGeneratedBy,
    AiSourceLink,
    AiSuggestion,
    ClinicianRef,
    PromptRef,
    SourceRef,
)


@dataclass(frozen=True)
class Switches:
    clinic: bool    # admin.tenant.ai_enabled: the clinic-wide switch
    feature: bool   # admin.ai_feature_setting.is_enabled; a feature with no row is off


@dataclass(frozen=True)
class FeatureState:
    feature: AIFeature
    enabled: bool
    reason: str | None = None
    updated_at: datetime | None = None   # None: never set (off)


@dataclass(frozen=True)
class SettingsState:
    """The clinic's AI switches: ``admin.tenant.ai_enabled`` and one row per feature set."""
    clinic_enabled: bool
    clinic_updated_at: datetime | None
    features: dict[AIFeature, FeatureState] = field(default_factory=dict)


@dataclass(frozen=True)
class SuggestionHead:
    """What a decision needs: the suggestion, its target and who requested it."""
    id: UUID
    feature: str
    target_resource_type: str
    target_id: UUID | None
    patient_id: UUID | None
    encounter_id: UUID | None
    content: dict[str, Any]
    decision: str
    requested_by: UUID | None


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

    async def suggestion(self, db: AsyncSession, suggestion_id: UUID, *, lock: bool = False
                         ) -> SuggestionHead | None: ...

    async def suggestion_views(self, db: AsyncSession, ids: Iterable[UUID]
                               ) -> dict[UUID, AiSuggestion]: ...

    async def settings(self, db: AsyncSession, *, lock: bool = False) -> SettingsState: ...

    async def set_clinic(self, db: AsyncSession, enabled: bool) -> None: ...

    async def patient_context(self, db: AsyncSession, patient_id: UUID) -> str | None: ...


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
        ``disabled_has_reason``); replaceAiSettings (#115) calls this."""
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
        decideAiSuggestion (#113) calls this; the gateway never does."""
        user = session_user_id(db)
        if user is None:
            raise PermissionError("a decision needs a signed-in user")
        await db.execute(update(AISuggestion).where(AISuggestion.id == suggestion_id).values(
            decision=decision, decided_by_user_id=user, decided_at=func.now(),
            edited_content=edited_content, rejection_reason=rejection_reason,
            updated_by_user_id=user))


    async def suggestion(self, db: AsyncSession, suggestion_id: UUID, *, lock: bool = False
                         ) -> SuggestionHead | None:
        r = (await db.execute(_SUGGESTION_LOCKED if lock else _SUGGESTION,
                              {"id": suggestion_id})).mappings().first()
        if r is None:
            return None
        return SuggestionHead(
            id=r["id"], feature=str(r["feature"]), target_resource_type=r["target_resource_type"],
            target_id=r["target_id"], patient_id=r["patient_id"], encounter_id=r["encounter_id"],
            content=dict(r["content"]), decision=str(r["decision"]), requested_by=r["user_id"])

    async def suggestion_views(self, db: AsyncSession, ids: Iterable[UUID]
                               ) -> dict[UUID, AiSuggestion]:
        """The contract's AiSuggestion for each ID the session can see."""
        wanted = list(dict.fromkeys(ids))
        if not wanted:
            return {}
        rows = (await db.execute(_SUGGESTION_VIEWS, {"ids": wanted})).mappings().all()
        return {r["id"]: _view(r) for r in rows if r["patient_id"] is not None}

    async def settings(self, db: AsyncSession, *, lock: bool = False) -> SettingsState:
        # RLS (tenant_self) shows the session's own clinic only.
        clinic = (await db.execute(_TENANT_LOCKED if lock else _TENANT)).mappings().first()
        rows = (await db.execute(select(AIFeatureSetting))).scalars().all()
        return SettingsState(
            clinic_enabled=bool(clinic and clinic["ai_enabled"]),
            clinic_updated_at=clinic["updated_at"] if clinic else None,
            features={AIFeature(r.feature): FeatureState(AIFeature(r.feature), r.is_enabled,
                                                         r.reason, r.updated_at)
                      for r in rows})

    async def set_clinic(self, db: AsyncSession, enabled: bool) -> None:
        """The clinic-wide switch (``admin.tenant.ai_enabled``)."""
        await db.execute(_SET_CLINIC, {"enabled": enabled})

    async def patient_context(self, db: AsyncSession, patient_id: UUID) -> str | None:
        """The minimum a note draft needs from the chart: age and administrative sex, e.g.
        "41-year-old female"; None when neither is known."""
        r = (await db.execute(_PATIENT, {"id": patient_id})).mappings().first()
        if r is None:
            return None
        age = _age(r["birth_date"]) if r["birth_date"] else None
        sex = r["gender"] if r["gender"] in ("female", "male") else None
        parts = [f"{age}-year-old" if age is not None else None, sex or "patient"]
        return " ".join(p for p in parts if p) if (age is not None or sex) else None


def _age(born: date) -> int:
    today = datetime.now(UTC).date()
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


_SUGGESTION_SQL = """
SELECT s.id, s.feature, s.target_resource_type, s.target_id, s.patient_id, s.encounter_id,
       s.content, s.decision, r.user_id
FROM admin.ai_suggestion s
JOIN admin.ai_request r ON r.id = s.ai_request_id
WHERE s.id = :id
"""
_SUGGESTION = text(_SUGGESTION_SQL)
_SUGGESTION_LOCKED = text(_SUGGESTION_SQL + " FOR UPDATE OF s")
_SUGGESTION_VIEWS = text("""
SELECT s.id, s.feature, s.target_resource_type, s.target_id, s.patient_id, s.encounter_id,
       s.content, s.confidence, s.rationale, s.decision, s.decided_at, s.rejection_reason,
       s.created_at, r.model_name, r.model_version, r.pipeline_version,
       p.code AS prompt_code, p.version AS prompt_version,
       u.id AS decider_id, u.practitioner_id AS decider_practitioner_id,
       u.display_name AS decider_name, cs.composition_id AS note_id
FROM admin.ai_suggestion s
JOIN admin.ai_request r ON r.id = s.ai_request_id
LEFT JOIN admin.prompt_template p ON p.id = r.prompt_template_id
LEFT JOIN admin.app_user u ON u.id = s.decided_by_user_id
LEFT JOIN clinical.composition_section cs
       ON s.target_resource_type = 'CompositionSection' AND cs.id = s.target_id
WHERE s.id = ANY(CAST(:ids AS uuid[]))
""")
_TENANT = text("SELECT ai_enabled, updated_at FROM admin.tenant")
_TENANT_LOCKED = text("SELECT ai_enabled, updated_at FROM admin.tenant FOR UPDATE")
# shri_app may update ai_enabled (a column grant), not updated_at: the settings' ETag covers the
# switch's value, which is what a second admin's PUT must not overwrite unseen.
_SET_CLINIC = text("UPDATE admin.tenant SET ai_enabled = :enabled")
_PATIENT = text("SELECT birth_date, gender FROM clinical.patient WHERE id = :id")


def _view(r: Any) -> AiSuggestion:
    content: dict[str, Any] = dict(r["content"] or {})
    section = r["target_resource_type"] == NOTE_SECTION
    decided = r["decision"] != AIDecision.PENDING.value and r["decider_id"] is not None
    return AiSuggestion(
        id=r["id"], feature=str(r["feature"]),
        target_type="note-section" if section else "chart-summary",
        target_id=r["target_id"] or r["id"], note_id=r["note_id"] if section else None,
        patient_id=r["patient_id"], encounter_id=r["encounter_id"],
        confidence=str(r["confidence"]), rationale=r["rationale"],
        suggested_text=content.get("text") if section else None,
        source_status=content.get("sourceStatus") if section else None,
        sources=[AiSourceLink.model_validate(s) for s in content.get("sources", [])]
        if section else None,
        unknowns=list(content.get("unknowns", [])), decision=str(r["decision"]),
        decided_at=r["decided_at"] if decided else None,
        decided_by=ClinicianRef(id=r["decider_practitioner_id"] or r["decider_id"],
                                display_name=r["decider_name"] or "") if decided else None,
        rejection_reason=r["rejection_reason"],
        generated_by=AiGeneratedBy(model_name=r["model_name"] or "unrecorded",
                                   model_version=r["model_version"],
                                   prompt_code=r["prompt_code"],
                                   prompt_version=r["prompt_version"],
                                   pipeline_version=r["pipeline_version"]),
        created_at=r["created_at"])


def _unique(sources: Sequence[SourceRef]) -> list[SourceRef]:
    seen: set[tuple[str, UUID]] = set()
    out = []
    for s in sources:
        if (s.resource_type, s.resource_id) not in seen:
            seen.add((s.resource_type, s.resource_id))
            out.append(s)
    return out
