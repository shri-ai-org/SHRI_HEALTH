"""In-memory stand-ins for the gateway's three dependencies: the AI repository, the model and
the encounters module's draft writer. Synthetic data only."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.enums import AIDecision, AIFeature
from app.modules.ai.budget import Usage
from app.modules.ai.model_client import ModelError, ModelReply
from app.modules.ai.prompts import NOTE_DRAFT_V1
from app.modules.ai.repository import (
    FeatureState,
    RequestRecord,
    SettingsState,
    SuggestionHead,
    SuggestionRecord,
    Switches,
)
from app.modules.ai.schemas import (
    NOTE_DRAFT_PROMPT,
    AIDraftIn,
    AiSuggestion,
    DraftWritten,
    NoteDraftRequest,
    PromptRef,
    SourceRef,
    TemplateSection,
)

NOW = datetime(2026, 11, 2, 15, 0, tzinfo=UTC)
FOLLOW_UP = (TemplateSection("10154-3", "Chief complaint", True),
             TemplateSection("10164-2", "Interval history", True),
             TemplateSection("29545-1", "Physical exam", True),
             TemplateSection("51847-2", "Assessment and plan", True),
             TemplateSection("69730-0", "Patient instructions"))
#: A fictional transcript; the logging tests look for these exact strings.
TRANSCRIPT = ("Clinician: How have the headaches been since we started topiramate?\n"
              "Patient: Down to five or six days a month. The sumatriptan works in an hour.")
CHIEF = "Follow-up of chronic migraine on topiramate."
HISTORY = "Headache days down to five or six a month; sumatriptan works in an hour."
GOOD_REPLY: dict[str, Any] = {"sections": [
    {"code": "10154-3", "text": CHIEF},
    {"code": "10164-2", "text": HISTORY},
    {"code": "29545-1", "text": "Not examined in the transcript."},
    {"code": "51847-2", "text": "Chronic migraine, improving. Continue topiramate."},
    {"code": "69730-0", "text": ""}]}


def request(**kw: Any) -> NoteDraftRequest:
    values: dict[str, Any] = {
        "encounter_id": uuid4(), "patient_id": uuid4(), "transcript": TRANSCRIPT,
        "sections": FOLLOW_UP, "note_type_loinc": "11506-3", "title": "Follow-up visit",
        "patient_context": "41-year-old female",
        "sources": (SourceRef("DocumentReference", uuid4(), 1),)}
    return NoteDraftRequest(**(values | kw))


@dataclass
class FakeAIRepository:
    clinic_on: bool = True
    features_on: set[AIFeature] = field(default_factory=lambda: set(AIFeature))
    prompts: dict[str, PromptRef] = field(default_factory=dict)
    requests: list[RequestRecord] = field(default_factory=list)
    suggestions: dict[UUID, SuggestionRecord] = field(default_factory=dict)
    targets: dict[UUID, UUID] = field(default_factory=dict)
    decisions: dict[UUID, AIDecision] = field(default_factory=dict)
    reads: int = 0
    usage: list[Usage] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.prompts:
            self.prompts[NOTE_DRAFT_PROMPT] = PromptRef(
                id=uuid4(), code=NOTE_DRAFT_PROMPT, version=3,
                feature=AIFeature.AMBIENT_DOCUMENTATION, template=NOTE_DRAFT_V1,
                output_schema=None)

    async def switches(self, db: AsyncSession, feature: AIFeature) -> Switches:
        self.reads += 1
        return Switches(clinic=self.clinic_on, feature=feature in self.features_on)

    async def set_feature(self, db: AsyncSession, feature: AIFeature, enabled: bool,
                          reason: str | None = None) -> None:
        (self.features_on.add if enabled else self.features_on.discard)(feature)

    async def active_prompt(self, db: AsyncSession, code: str) -> PromptRef | None:
        return self.prompts.get(code)

    async def publish_prompt(self, db: AsyncSession, code: str, feature: AIFeature,
                             template: str, output_schema: dict[str, Any] | None
                             ) -> PromptRef:
        old = self.prompts.get(code)
        self.prompts[code] = PromptRef(uuid4(), code, (old.version if old else 0) + 1, feature,
                                       template, output_schema)
        return self.prompts[code]

    async def record_request(self, db: AsyncSession, rec: RequestRecord
                             ) -> tuple[UUID, datetime]:
        self.requests.append(rec)
        return uuid4(), NOW

    async def record_suggestion(self, db: AsyncSession, rec: SuggestionRecord) -> UUID:
        suggestion_id = uuid4()
        self.suggestions[suggestion_id] = rec
        return suggestion_id

    async def set_suggestion_target(self, db: AsyncSession, suggestion_id: UUID,
                                    target_id: UUID) -> None:
        assert suggestion_id not in self.targets
        self.targets[suggestion_id] = target_id

    async def decide(self, db: AsyncSession, suggestion_id: UUID, decision: AIDecision, *,
                     edited_content: dict[str, Any] | None = None,
                     rejection_reason: str | None = None) -> None:
        self.decisions[suggestion_id] = decision

    async def suggestion(self, db: AsyncSession, suggestion_id: UUID, *, lock: bool = False
                         ) -> SuggestionHead | None:
        rec = self.suggestions.get(suggestion_id)
        if rec is None:
            return None
        decision = self.decisions.get(suggestion_id, AIDecision.PENDING)
        return SuggestionHead(suggestion_id, rec.feature.value, rec.target_resource_type,
                              self.targets.get(suggestion_id), rec.patient_id,
                              rec.encounter_id, rec.content, decision.value, None)

    async def suggestion_views(self, db: AsyncSession, ids: Any) -> dict[UUID, AiSuggestion]:
        return {}

    async def settings(self, db: AsyncSession, *, lock: bool = False) -> SettingsState:
        return SettingsState(self.clinic_on, NOW, {
            f: FeatureState(f, True, None, NOW) for f in self.features_on})

    async def set_clinic(self, db: AsyncSession, enabled: bool) -> None:
        self.clinic_on = enabled

    async def patient_context(self, db: AsyncSession, patient_id: UUID) -> str | None:
        return "41-year-old female"

    async def practitioner_of_user(self, db: AsyncSession, user_id: UUID) -> UUID | None:
        return None

    async def generation(self, db: AsyncSession, suggestion_id: UUID) -> Any:
        return None

    async def month_usage(self, db: AsyncSession) -> list[Usage]:
        return list(self.usage)


@dataclass
class StubModelClient:
    """Returns canned replies (or raises) and keeps what it was sent."""
    replies: list[str | ModelError] = field(default_factory=lambda: [json.dumps(GOOD_REPLY)])
    model: str = "stub/qwen3-8b"
    sent: list[list[dict[str, str]]] = field(default_factory=list)
    schemas: list[Mapping[str, Any] | None] = field(default_factory=list)

    async def complete(self, messages: Sequence[Mapping[str, str]], *, max_tokens: int,
                       schema: Mapping[str, Any] | None = None) -> ModelReply:
        self.sent.append([dict(m) for m in messages])
        self.schemas.append(schema)
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(reply, ModelError):
            raise reply
        return ModelReply(content=reply, model=self.model, latency_ms=1234,
                          prompt_tokens=812, completion_tokens=240)


@dataclass
class FakeNoteDrafts:
    """The encounters side: keeps each draft. It has no sign method, like the real one."""
    drafts: dict[UUID, AIDraftIn] = field(default_factory=dict)

    async def create_ai_draft(self, db: AsyncSession, draft: AIDraftIn) -> DraftWritten:
        note_id = uuid4()
        self.drafts[note_id] = draft
        return DraftWritten(note_id=note_id, version=1,
                            sections=tuple((s.code, uuid4()) for s in draft.sections))
