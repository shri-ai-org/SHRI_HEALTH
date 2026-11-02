"""The AI gateway (service layer): one entry point for every AI call (FRS §3.4; Vimal's guide,
Step 7.3). No routes yet: they come with the AI contract (batch 7, inventory #107-#115).

**The off switch.** Every public gateway call first checks the clinic's switch
(``admin.tenant.ai_enabled``) and the feature's (``admin.ai_feature_setting``; a feature with no
row is off). Either off: ``409 feature-disabled`` with ``feature`` (API_STANDARDS §9.3), before
anything is read, sent or written. Nothing in the visit workflow calls the gateway: encounters,
notes and signing work the same with AI off (tests/test_gateway_live.py).

**Drafts are suggestions, never signed records.** A note draft (AI-01) is:

1. the active prompt version (``prompt_template``) rendered with the template's sections;
2. one model call; the reply parsed and pruned to the output schema, keeping only the
   template's section codes, once each (anything else is dropped, never repaired);
3. an ``ai_request`` (metadata, the input's SHA-256, the source references) and a pending
   ``ai_suggestion`` (the pruned output, its unknowns, a confidence band) in the session;
4. an unsigned note written by the **encounters module** (``NoteDrafts``), its AI sections
   linked to the suggestion. The gateway has no way to sign: ``NoteDrafts`` has no sign
   method, and the database refuses to sign a note while an AI section's suggestion is
   undecided (``shri_composition_signed_check``). Signing stays a person's act, by the author,
   after accepting or editing each AI section (D70).

Nothing here commits: the caller's transaction (the AI operation, API_STANDARDS §13) holds it.
A failed model call or rejected output raises after its ``ai_request`` row is flushed, so the
caller can commit that record with the failed operation.

**Logging:** request metadata only (feature, request ID, model, prompt version, latency,
token counts, how much was kept or dropped). Never the transcript, the prompt or the output.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from string import Template
from typing import Any, Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, InternalError, ServiceUnavailable
from app.core.request_id import current_request_id
from app.db.models.enums import AIConfidence, AIFeature, AIRequestStatus

from .model_client import ModelClient, ModelError, ModelReply
from .output import DROP, SchemaError, check_schema, prune
from .repository import AIRepository, RequestRecord, SuggestionRecord
from .schemas import (
    NOTE_DRAFT_PROMPT,
    NOTE_DRAFT_SCHEMA,
    PIPELINE_VERSION,
    AIDraftIn,
    DraftProvenance,
    DraftResult,
    DraftSectionIn,
    DraftWritten,
    NoteDraftRequest,
    PromptRef,
    SourceRef,
)

log = logging.getLogger("app.modules.ai.gateway")

MAX_OUTPUT_TOKENS = 2048
RATIONALE = ("Drafted by AI from the visit transcript. Review, edit or reject every section "
             "before signing.")


class ModelUnavailable(ServiceUnavailable):
    """The model did not answer, or failed. (The operation's Problem becomes `ai-unavailable`
    once core's catalogue has the operation codes.)"""

    def __init__(self, request_id: Any) -> None:
        super().__init__("The AI model is unavailable")
        self.request_id = request_id


class OutputRejected(ServiceUnavailable):
    """Nothing of the model's output fits the schema. (Operation code `ai-output-rejected`.)"""

    def __init__(self, request_id: Any) -> None:
        super().__init__("The AI output did not match its schema")
        self.request_id = request_id


class NoteDrafts(Protocol):
    """What the gateway may do to notes: create an unsigned draft. Nothing else, by design:
    no update, no sign. The encounters module implements it (encounters/ai_drafts.py)."""

    async def create_ai_draft(self, db: AsyncSession, draft: AIDraftIn) -> DraftWritten: ...


def feature_disabled(feature: AIFeature) -> Conflict:
    return Conflict("AI is switched off for this feature", code="feature-disabled",
                    feature=feature.value)


async def ensure_enabled(db: AsyncSession, repo: AIRepository, feature: AIFeature) -> None:
    switches = await repo.switches(db, feature)
    if not (switches.clinic and switches.feature):
        raise feature_disabled(feature)


def _sha256(messages: list[dict[str, str]]) -> str:
    return hashlib.sha256(json.dumps(messages, sort_keys=True).encode()).hexdigest()


def render(prompt: PromptRef, request: NoteDraftRequest) -> list[dict[str, str]]:
    sections = "\n".join(f"- {s.code}: {s.title}{' (required)' if s.required else ''}"
                         for s in request.sections)
    patient = f"Patient: {request.patient_context}.\n" if request.patient_context else ""
    return [{"role": "system",
             "content": Template(prompt.template).safe_substitute(sections=sections)},
            {"role": "user", "content": f"{patient}Transcript:\n{request.transcript}"}]


def parse(content: str) -> Any:
    """The reply as JSON: a leading <think> block and code fences are ignored."""
    text = content.strip()
    if text.startswith("<think>") and "</think>" in text:
        text = text.split("</think>", 1)[1].strip()
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return DROP


def keep_draft(raw: Any, schema: dict[str, Any], request: NoteDraftRequest
               ) -> tuple[dict[str, Any] | None, list[str]]:
    """The output pruned to the schema, then to the template: its section codes only, once
    each. ``None`` when nothing usable is left."""
    try:
        check_schema(schema)
    except SchemaError as bad:
        raise InternalError() from bad      # a prompt version with an unsupported schema
    kept, dropped = prune(raw, schema)
    if kept is DROP or not isinstance(kept, dict):
        return None, dropped or ["/"]
    allowed = {s.code for s in request.sections}
    sections, seen = [], set()
    for i, s in enumerate(kept.get("sections", [])):
        if s["code"] not in allowed or s["code"] in seen:
            dropped.append(f"/sections/{i}")
            continue
        seen.add(s["code"])
        sections.append({"code": s["code"], "text": s["text"].strip()})
    if not any(s["text"] for s in sections):
        return None, dropped
    return {"sections": sections, "unknowns": list(kept.get("unknowns", []))}, dropped


def confidence(draft: dict[str, Any], dropped: list[str], request: NoteDraftRequest) -> str:
    """The D70 band, by rule: never ``high`` until a grounding check exists; ``low`` when
    output was dropped, the model listed unknowns, or a required section is empty."""
    texts = {s["code"]: s["text"] for s in draft["sections"]}
    empty_required = any(r.required and not texts.get(r.code) for r in request.sections)
    if dropped or draft["unknowns"] or empty_required:
        return AIConfidence.LOW.value
    return AIConfidence.MEDIUM.value


@dataclass
class Gateway:
    repo: AIRepository
    model: ModelClient
    drafts: NoteDrafts

    async def _enabled(self, db: AsyncSession, feature: AIFeature) -> None:
        await ensure_enabled(db, self.repo, feature)

    async def _prompt(self, db: AsyncSession, code: str) -> PromptRef:
        prompt = await self.repo.active_prompt(db, code)
        if prompt is None:
            raise ServiceUnavailable("No active prompt version for this AI feature")
        return prompt

    async def _record(self, db: AsyncSession, request: NoteDraftRequest, prompt: PromptRef,
                      digest: str, status: AIRequestStatus, reply: ModelReply | None,
                      error: str | None) -> Any:
        return await self.repo.record_request(db, RequestRecord(
            feature=AIFeature.AMBIENT_DOCUMENTATION, status=status,
            pipeline_version=PIPELINE_VERSION, model_name=reply.model if reply else
            self.model.model, prompt_template_id=prompt.id, input_sha256=digest,
            patient_id=request.patient_id, encounter_id=request.encounter_id,
            latency_ms=reply.latency_ms if reply else None,
            input_tokens=reply.prompt_tokens if reply else None,
            output_tokens=reply.completion_tokens if reply else None, error_message=error,
            correlation_id=current_request_id(), sources=_sources(request)))

    async def draft_note(self, db: AsyncSession, request: NoteDraftRequest) -> DraftResult:
        """AI-01: an unsigned, AI-marked draft note on the encounter (see the module notes)."""
        feature = AIFeature.AMBIENT_DOCUMENTATION
        await self._enabled(db, feature)
        prompt = await self._prompt(db, NOTE_DRAFT_PROMPT)
        messages = render(prompt, request)
        digest = _sha256(messages)
        try:
            reply = await self.model.complete(messages, max_tokens=MAX_OUTPUT_TOKENS)
        except ModelError as err:
            status = (AIRequestStatus.TIMEOUT if err.kind == "timeout"
                      else AIRequestStatus.FAILED)
            request_id, _ = await self._record(db, request, prompt, digest, status, None,
                                               str(err))
            _log(feature, request_id, prompt, None, status.value, kept=0, dropped=0)
            raise ModelUnavailable(request_id) from None
        draft, dropped = keep_draft(parse(reply.content), prompt.output_schema or
                                    NOTE_DRAFT_SCHEMA, request)
        if draft is None:
            request_id, _ = await self._record(db, request, prompt, digest,
                                               AIRequestStatus.FAILED, reply,
                                               "output-rejected: nothing matched the schema")
            _log(feature, request_id, prompt, reply, "output-rejected", kept=0,
                 dropped=len(dropped))
            raise OutputRejected(request_id)
        request_id, requested_at = await self._record(db, request, prompt, digest,
                                                      AIRequestStatus.COMPLETED, reply, None)
        band = confidence(draft, dropped, request)
        suggestion_id = await self.repo.record_suggestion(db, SuggestionRecord(
            request_id=request_id, feature=feature, patient_id=request.patient_id,
            encounter_id=request.encounter_id, target_resource_type="Composition",
            content=draft, confidence=band, rationale=RATIONALE,
            unknowns=tuple(draft["unknowns"])))
        texts = {s["code"]: s["text"] for s in draft["sections"]}
        note = await self.drafts.create_ai_draft(db, AIDraftIn(
            encounter_id=request.encounter_id, note_type_loinc=request.note_type_loinc,
            title=request.title, template_id=request.template_id, suggestion_id=suggestion_id,
            sections=tuple(DraftSectionIn(s.code, s.title, texts.get(s.code, ""))
                           for s in request.sections)))
        await self.repo.set_suggestion_target(db, suggestion_id, note.note_id)
        _log(feature, request_id, prompt, reply, "completed",
             kept=sum(1 for t in texts.values() if t), dropped=len(dropped))
        return DraftResult(
            note=note, confidence=band, unknowns=tuple(draft["unknowns"]),
            dropped=tuple(dropped),
            provenance=DraftProvenance(
                request_id=request_id, suggestion_id=suggestion_id, model=reply.model,
                prompt_template_id=prompt.id, prompt_code=prompt.code,
                prompt_version=prompt.version, requested_at=requested_at,
                sources=_sources(request)))


#: Each public gateway call and the feature it needs; a test checks every call is listed and
#: refuses when its feature is off.
FEATURES: dict[str, AIFeature] = {"draft_note": AIFeature.AMBIENT_DOCUMENTATION}


def _sources(request: NoteDraftRequest) -> tuple[SourceRef, ...]:
    """The request's own references plus the encounter it drafts for."""
    encounter = SourceRef("Encounter", request.encounter_id)
    return (encounter, *[s for s in request.sources if s != encounter])


def _log(feature: AIFeature, request_id: Any, prompt: PromptRef, reply: ModelReply | None,
         status: str, *, kept: int, dropped: int) -> None:
    """Metadata only (never the transcript, the prompt or the output)."""
    log.info("ai.request id=%s feature=%s status=%s model=%s prompt=%s/v%s latency_ms=%s "
             "tokens_in=%s tokens_out=%s sections_kept=%s items_dropped=%s request=%s",
             request_id, feature.value, status, reply.model if reply else "-", prompt.code,
             prompt.version, reply.latency_ms if reply else "-",
             reply.prompt_tokens if reply else "-", reply.completion_tokens if reply else "-",
             kept, dropped, current_request_id() or "-")
