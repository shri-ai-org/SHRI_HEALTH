"""AI-02, the chart summary (contracts/openapi/modules/ai.yaml: createChartSummary,
getChartSummary; FRS §3.4; D70).

**What the model sees.** The chart, read as the clinician through each module's own service
(the reader in api.py): the recent visits with their diagnoses, the active allergies and the
active medications, each part only with its read permission, the facility check and the
restricted-chart check (D37). Every record is one numbered line ("S3: ..."), names and dates
only, never an ID or other patient data. Entered-in-error records are never read. A part the
clinician may not read, or that has no data source yet (results, the problem list), is named
as such, so the model lists it under ``missing``.

**What comes back.** Statements by topic, each citing the lines it rests on ("S3"). The
gateway maps each cited line back to its record (``AiSourceLink``: resource type, our ID and a
label). **A statement that cites no line it was given is dropped**, never kept as an
unsupported claim; anything dropped lowers the band. Statements are ``medium`` at best (no
grounding check yet; D70) and ``sourced``.

**Where it is kept.** One ``ai_suggestion`` (target type chart summary) whose ID is the
summary's; its ``content`` holds the statements, their links and the gaps. It is never part of
the chart, and its requester accepts or rejects it (decideAiSuggestion). The request record
keeps hashes, token counts and the records sent (``ai_request_input_ref``), never text.
Nothing here logs content.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.request_id import current_request_id
from app.db.models.enums import AIConfidence, AIFeature, AIRequestStatus

from . import budget
from .model_client import ModelClient, ModelError, ModelReply
from .output import DROP, prune
from .repository import AIRepository, RequestRecord, SuggestionRecord
from .schemas import PIPELINE_VERSION, PromptRef, SourceRef
from .service import BudgetReached, ModelUnavailable, OutputRejected, parse

log = logging.getLogger("app.modules.ai.gateway")

#: ``ai_suggestion.target_resource_type`` of a chart summary (contract ``targetType:
#: chart-summary``; the suggestion's own ID is the summary's).
CHART_SUMMARY = "ChartSummary"
PROMPT_CODE = "chart-summary"
TOPICS = ("encounters", "diagnoses", "medications", "allergies", "results",
          "outstanding-issues")
MAX_OUTPUT_TOKENS = 4096
_HANDLE = re.compile(r"^S[0-9]{1,4}$")

#: What the model must return. Handles ("S3") point at the numbered chart lines.
SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["sections", "missing"],
    "properties": {
        "sections": {"type": "array", "maxItems": 6, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["topic", "statements"],
            "properties": {
                "topic": {"type": "string", "enum": list(TOPICS)},
                "statements": {"type": "array", "maxItems": 40, "items": {
                    "type": "object", "additionalProperties": False,
                    "required": ["text", "sources"],
                    "properties": {
                        "text": {"type": "string", "minLength": 1, "maxLength": 2000},
                        "sources": {"type": "array", "maxItems": 20,
                                    "items": {"type": "string", "pattern": "^S[0-9]{1,4}$"}},
                    }}},
            }}},
        "missing": {"type": "array", "maxItems": 50, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["topic", "description"],
            "properties": {
                "topic": {"type": "string", "enum": list(TOPICS)},
                "description": {"type": "string", "minLength": 1, "maxLength": 500},
            }}},
    },
}

SUMMARY_V1 = "\n".join((
    "You summarize a patient's chart for the clinician before a visit. The chart is given as "
    "numbered lines (S1, S2, ...).",
    "Return only a JSON object, with no other text:",
    '{"sections": [{"topic": "<topic>", "statements": [{"text": "<statement>", '
    '"sources": ["S1"]}]}], "missing": [{"topic": "<topic>", "description": "<what>"}]}',
    "Rules:",
    "- Topics, in this order, only when they have statements: encounters, diagnoses, "
    "medications, allergies, results, outstanding-issues.",
    "- Every statement cites the line numbers it rests on, in \"sources\". Use only facts the "
    "cited lines state. Never add a diagnosis, medicine, dose, date or result that isn't there.",
    "- Where two lines disagree, say so in one statement that cites both.",
    "- A part marked as not available or not readable goes in \"missing\", with what is "
    "missing; so does anything a pre-visit summary would need that the chart doesn't give.",
    "- Short, plain clinical English; no Markdown; no line numbers in the text itself.",
))
PROMPT = PromptRef(id=None, code=PROMPT_CODE, version=1, feature=AIFeature.CHART_SUMMARY,
                   template=SUMMARY_V1, output_schema=SUMMARY_SCHEMA)


@dataclass(frozen=True)
class ChartLine:
    """One numbered line the model sees, and the record behind it."""
    text: str
    source: SourceRef
    label: str


@dataclass(frozen=True)
class SummaryChart:
    """The chart as read for a summary (api.py's reader)."""
    lines: tuple[ChartLine, ...] = ()
    unavailable: tuple[str, ...] = ()   # parts with no source or no read permission
    reason_for_visit: str | None = None


@dataclass(frozen=True)
class SummaryRequest:
    patient_id: UUID
    encounter_id: UUID | None
    patient_context: str | None
    chart: SummaryChart


@dataclass
class SummaryDraft:
    sections: list[dict[str, Any]] = field(default_factory=list)
    missing: list[dict[str, Any]] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)


def render(request: SummaryRequest) -> list[dict[str, str]]:
    lines = "\n".join(f"S{i}: {line.text}" for i, line in enumerate(request.chart.lines, 1))
    parts = [f"Patient: {request.patient_context}." if request.patient_context else "",
             f"Reason for this visit: {request.chart.reason_for_visit}."
             if request.chart.reason_for_visit else "",
             "Chart:\n" + (lines or "(nothing recorded)"),
             "Not available: " + "; ".join(request.chart.unavailable) + "."
             if request.chart.unavailable else ""]
    return [{"role": "system", "content": PROMPT.template},
            {"role": "user", "content": "\n".join(p for p in parts if p)}]


def keep(raw: Any, chart: SummaryChart) -> SummaryDraft | None:
    """The reply pruned to the schema, then to the lines it was given: a statement must cite
    at least one real line (the dropped pointers say where one went). None when nothing
    usable is left."""
    kept, dropped = prune(raw, SUMMARY_SCHEMA)
    if kept is DROP or not isinstance(kept, dict):
        return None
    draft = SummaryDraft(dropped=list(dropped))
    sequence, seen = 0, set()
    for i, section in enumerate(kept.get("sections", [])):
        if section["topic"] in seen:
            draft.dropped.append(f"/sections/{i}")
            continue
        seen.add(section["topic"])
        statements = []
        for j, statement in enumerate(section["statements"]):
            handles = [h for h in dict.fromkeys(statement["sources"]) if _HANDLE.match(h)
                       and 1 <= int(h[1:]) <= len(chart.lines)]
            if not handles:
                draft.dropped.append(f"/sections/{i}/statements/{j}")
                continue
            sequence += 1
            statements.append({"sequence": sequence, "text": statement["text"].strip(),
                               "sources": [_link(chart.lines[int(h[1:]) - 1]) for h in handles]})
        if statements:
            draft.sections.append({"topic": section["topic"], "statements": statements})
    draft.sections.sort(key=lambda s: TOPICS.index(s["topic"]))
    draft.missing = [{"topic": g["topic"], "description": g["description"].strip()}
                     for g in kept.get("missing", [])]
    if not draft.sections and not draft.missing:
        return None
    return draft


def _link(line: ChartLine) -> dict[str, Any]:
    return {"resourceType": line.source.resource_type,
            "resourceId": str(line.source.resource_id), "label": line.label}


def band(draft: SummaryDraft) -> str:
    """Never ``high`` until a grounding check exists; ``low`` when anything was dropped."""
    return AIConfidence.LOW.value if draft.dropped else AIConfidence.MEDIUM.value


def content(draft: SummaryDraft, confidence: str) -> dict[str, Any]:
    """The suggestion's content: the contract's sections (each statement with its band and
    ``sourced``) and the gaps."""
    return {"sections": [
        {"topic": s["topic"], "statements": [
            {**st, "confidence": confidence, "sourceStatus": "sourced"}
            for st in s["statements"]]} for s in draft.sections],
        "missing": draft.missing}


def rationale(draft: SummaryDraft, chart: SummaryChart) -> str:
    counts: dict[str, int] = {}
    for line in chart.lines:
        counts[line.source.resource_type] = counts.get(line.source.resource_type, 0) + 1
    read = ", ".join(f"{n} {kind}" for kind, n in sorted(counts.items())) or "no records"
    note = (f" {len(draft.dropped)} unsupported item(s) were left out." if draft.dropped
            else "")
    return (f"Summarized by AI from the chart ({read}); every statement links to its source "
            f"records. Review it against the chart.{note}")


async def summarize(db: AsyncSession, repo: AIRepository, model: ModelClient,
                    request: SummaryRequest) -> UUID:
    """One summary: the budget check, one model call, the request record and the suggestion.
    Returns the summary's ID. Raises like the note draft (BudgetReached, ModelUnavailable,
    OutputRejected) after flushing the request record, for the caller to commit."""
    messages = render(request)
    digest = hashlib.sha256(json.dumps(messages, sort_keys=True).encode()).hexdigest()
    sources = tuple(dict.fromkeys(line.source for line in request.chart.lines))

    async def record(status: AIRequestStatus, reply: ModelReply | None,
                     error: str | ModelError | None) -> UUID:
        failed = error if isinstance(error, ModelError) else None
        request_id, _ = await repo.record_request(db, RequestRecord(
            feature=AIFeature.CHART_SUMMARY, status=status, pipeline_version=PIPELINE_VERSION,
            model_name=reply.model if reply else (failed.model if failed and failed.model
                                                  else model.model),
            prompt_template_id=None, input_sha256=digest, patient_id=request.patient_id,
            encounter_id=request.encounter_id,
            latency_ms=reply.latency_ms if reply else None,
            input_tokens=reply.prompt_tokens if reply else (
                failed.prompt_tokens if failed else None),
            output_tokens=reply.completion_tokens if reply else (
                failed.completion_tokens if failed else None),
            error_message=str(error) if error is not None else None,
            correlation_id=current_request_id(), sources=sources))
        _log(request_id, status.value, reply)
        return request_id

    if budget.price(model.model) is not None and budget.estimate(
            await repo.month_usage(db)) >= budget.limit():
        raise BudgetReached(await record(AIRequestStatus.BLOCKED, None,
                                         "budget-reached: the month's AI budget is used up"))
    try:
        reply = await model.complete(messages, max_tokens=MAX_OUTPUT_TOKENS,
                                     schema=SUMMARY_SCHEMA)
    except ModelError as err:
        status = AIRequestStatus.TIMEOUT if err.kind == "timeout" else AIRequestStatus.FAILED
        raise ModelUnavailable(await record(status, None, err)) from None
    draft = keep(parse(reply.content), request.chart)
    if draft is None:
        raise OutputRejected(await record(AIRequestStatus.FAILED, reply,
                                          "output-rejected: nothing matched the schema"))
    request_id = await record(AIRequestStatus.COMPLETED, reply, None)
    confidence = band(draft)
    return await repo.record_suggestion(db, SuggestionRecord(
        request_id=request_id, feature=AIFeature.CHART_SUMMARY, patient_id=request.patient_id,
        encounter_id=request.encounter_id, target_resource_type=CHART_SUMMARY,
        content=content(draft, confidence), confidence=confidence,
        rationale=rationale(draft, request.chart),
        unknowns=tuple(g["description"] for g in draft.missing)))


def _log(request_id: UUID, status: str, reply: ModelReply | None) -> None:
    """Metadata only (never the chart, the prompt or the output)."""
    log.info("ai.request id=%s feature=chart-summary status=%s model=%s prompt=%s/v%s "
             "latency_ms=%s tokens_in=%s tokens_out=%s request=%s", request_id, status,
             reply.model if reply else "-", PROMPT.code, PROMPT.version,
             reply.latency_ms if reply else "-", reply.prompt_tokens if reply else "-",
             reply.completion_tokens if reply else "-", current_request_id() or "-")


def lines_of(kind: str, entries: Sequence[tuple[str, SourceRef, str]]) -> list[ChartLine]:
    """Chart lines from (text, source, label) triples; ``kind`` prefixes the text."""
    return [ChartLine(f"{kind}: {text}", source, label) for text, source, label in entries]
