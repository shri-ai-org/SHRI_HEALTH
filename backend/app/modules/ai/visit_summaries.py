"""The AI visit summary at the top of the consultation note (contracts/openapi/modules/ai.yaml:
createVisitSummary, getVisitSummary; D119, Sena's demo plan §3/§4).

**Who asks.** A clinician with ``chart-summaries:create`` (MD, APP); the summary is theirs alone.

**What the model sees.** The same lines as a differential (differentials.VisitChart, read by
api.py's reader as the clinician, through each module's own service with their permissions and
the restricted-chart check, D37): the visit's reason, its diagnoses so far, the vital signs taken
at it and its notes' sections, then the chart lines a summary uses. **A note section the AI
drafted and nobody reviewed yet is left out by the reader**: the summary rests on what the
clinician wrote or accepted, never on an unreviewed draft. Every record is one numbered line.

**What comes back.** Up to five short statements about this visit, each citing the lines it
rests on; a statement citing none of them is dropped. ``insufficientEvidence`` when nothing is
left. Nothing is written to the note, the visit or the chart.

**Where it is kept.** One ``ai_suggestion`` (target type visit summary, feature
``chart-summary``) whose ID is the summary's; readable by its requester only, after the chart
check. Nothing of it is logged.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import NotFound
from app.core.long_running import Operation
from app.db.models.enums import AIConfidence, AIFeature, AIRequestStatus

from . import calls
from .differentials import ChartCheck, VisitChart, VisitReader, lines_of
from .output import DROP, prune
from .repository import AIRepository, SuggestionRecord
from .schemas import AiSourceLink, ChartAnswerStatement, VisitSummary, VisitSummaryCreate
from .service import OutputRejected, ensure_enabled
from .summary import ChartLine

VISIT_SUMMARY = "VisitSummary"
KIND = "ai.visit-summary"
PROMPT_CODE = "visit-summary"
MAX_STATEMENTS = 5
MAX_OUTPUT_TOKENS = 2000
_HANDLE = re.compile(r"^S[0-9]{1,4}$")

VISIT_SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "required": ["statements", "insufficientEvidence"],
    "properties": {
        "statements": {"type": "array", "maxItems": MAX_STATEMENTS, "items": {
            "type": "object", "additionalProperties": False, "required": ["text", "sources"],
            "properties": {
                "text": {"type": "string", "minLength": 1, "maxLength": 600},
                "sources": {"type": "array", "maxItems": 20,
                            "items": {"type": "string", "pattern": "^S[0-9]{1,4}$"}}}}},
        "insufficientEvidence": {"type": "boolean"},
    },
}

VISIT_SUMMARY_V1 = "\n".join((
    "You summarize one visit for the clinician who is writing its note. The visit and the "
    "patient's chart are given as numbered lines (S1, S2, ...). Use only those lines.",
    "Return only a JSON object, with no other text:",
    '{"statements": [{"text": "<statement>", "sources": ["S1"]}], '
    '"insufficientEvidence": false}',
    "Rules:",
    f"- At most {MAX_STATEMENTS} short statements, in this order: why the patient came, what "
    "was found (vital signs, examination), the assessment and diagnoses, the plan.",
    "- Summarize this visit. Use a chart line only when it bears on this visit (for example an "
    "allergy or a medication relevant to the plan).",
    "- Every statement cites the lines it rests on, and states only what those lines say. Never "
    "invent findings, results, history or plans; never recommend anything.",
    "- If the visit's lines hold too little to summarize, return no statements and "
    "insufficientEvidence true.",
    "- Plain English; no Markdown; no line numbers in the text itself.",
))


def render(found: VisitChart, context: str | None) -> list[dict[str, str]]:
    lines = lines_of(found)
    n = len(found.visit)
    visit = "\n".join(f"S{i}: {line.text}" for i, line in enumerate(lines[:n], 1))
    chart = "\n".join(f"S{i}: {line.text}" for i, line in enumerate(lines[n:], n + 1))
    body = "\n\n".join(p for p in (
        f"Patient: {context}." if context else "",
        "This visit:\n" + (visit or "(nothing recorded yet)"),
        "The chart:\n" + (chart or "(nothing recorded)"),
        "Not available: " + "; ".join(found.chart.unavailable) + "."
        if found.chart.unavailable else "") if p)
    return [{"role": "system", "content": VISIT_SUMMARY_V1}, {"role": "user", "content": body}]


def keep(raw: Any, lines: tuple[ChartLine, ...]) -> tuple[list[dict[str, Any]], bool] | None:
    """The statements that cite lines they were given, in order, and whether the evidence was
    insufficient; None when the reply doesn't fit the schema at all."""
    kept, _ = prune(raw, VISIT_SUMMARY_SCHEMA)
    if kept is DROP or not isinstance(kept, dict):
        return None
    statements: list[dict[str, Any]] = []
    for s in kept.get("statements", []):
        handles = [h for h in dict.fromkeys(s["sources"]) if _HANDLE.match(h)
                   and 1 <= int(h[1:]) <= len(lines)]
        if not handles:
            continue
        statements.append({
            "sequence": len(statements) + 1, "text": s["text"].strip(),
            "sources": [{"resourceType": lines[int(h[1:]) - 1].source.resource_type,
                         "resourceId": str(lines[int(h[1:]) - 1].source.resource_id),
                         "label": lines[int(h[1:]) - 1].label} for h in handles]})
    return statements, not statements


async def summarize(db: AsyncSession, repo: AIRepository, model: Any, encounter_id: UUID,
                    found: VisitChart) -> UUID:
    lines = lines_of(found)
    call = calls.Call(feature=AIFeature.CHART_SUMMARY, name=PROMPT_CODE,
                      messages=render(found, await repo.patient_context(db, found.patient_id)),
                      schema=VISIT_SUMMARY_SCHEMA, max_tokens=MAX_OUTPUT_TOKENS,
                      sources=[line.source for line in lines], patient_id=found.patient_id,
                      encounter_id=encounter_id)
    reply, record = await calls.complete(db, repo, model, call)
    kept = keep(reply.raw, lines)
    if kept is None:
        raise OutputRejected(await record(AIRequestStatus.FAILED, reply.reply,
                                          "output-rejected: nothing matched the schema"))
    statements, insufficient = kept
    request_id = await record(AIRequestStatus.COMPLETED, reply.reply, None)
    return await repo.record_suggestion(db, SuggestionRecord(
        request_id=request_id, feature=AIFeature.CHART_SUMMARY, patient_id=found.patient_id,
        encounter_id=encounter_id, target_resource_type=VISIT_SUMMARY,
        content={"statements": statements, "insufficientEvidence": insufficient},
        confidence=AIConfidence.LOW.value if insufficient else AIConfidence.MEDIUM.value,
        rationale="Summarized by AI from the records cited; it is not part of the note. Check "
                  "them before relying on it.",
        unknowns=()))


async def create(db: AsyncSession, repo: AIRepository, model: Any, read: VisitReader,
                 user: CurrentUser, body: VisitSummaryCreate,
                 name_patients: Callable[[list[UUID]], None]) -> Operation:
    """createVisitSummary: the switch (409), the visit as the user may read it (404, 403 D37),
    then the summary as a finished operation. The permission is the route's ``require``."""
    await ensure_enabled(db, repo, AIFeature.CHART_SUMMARY)
    found = await read(db, user, body.encounter_id)
    name_patients([found.patient_id])
    return await calls.as_operation(
        db, KIND, "visit-summary",
        lambda: summarize(db, repo, model, body.encounter_id, found))


async def get(db: AsyncSession, repo: AIRepository, check: ChartCheck, user: CurrentUser,
              summary_id: UUID) -> VisitSummary:
    """getVisitSummary: its requester only (404 for anyone else), after the chart check."""
    found = await repo.suggestion(db, summary_id)
    if found is None or found.target_resource_type != VISIT_SUMMARY \
            or found.patient_id is None or found.encounter_id is None \
            or found.requested_by != user.id:
        raise NotFound()
    await check(db, user, found.patient_id)
    made = await repo.generation(db, summary_id)
    if made is None:
        raise NotFound()
    return VisitSummary(
        id=summary_id, patient_id=found.patient_id, encounter_id=found.encounter_id,
        statements=[ChartAnswerStatement(
            sequence=s["sequence"], text=s["text"],
            sources=[AiSourceLink.model_validate(link) for link in s["sources"]])
            for s in found.content.get("statements", [])],
        insufficient_evidence=bool(found.content.get("insufficientEvidence", True)),
        ai_generated=True, generated_by=made[0], created_at=made[1])
