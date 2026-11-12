"""AI-03's differential for a visit (contracts/openapi/modules/ai.yaml: createDifferential,
getDifferential; FRS §3.4; D116).

**Who asks.** A clinician who can diagnose: ``chart-summaries:create`` and ``diagnoses:create``
(the roles that add a visit's diagnoses); anyone else gets ``403 permission-denied``.

**What the model sees.** The visit, read as the clinician through each module's own service
(the reader in api.py) with their permissions and the restricted-chart check (D37): its reason
for visit, its diagnoses so far, the vital signs taken at it and its notes' sections. **A
section the AI drafted and nobody reviewed yet is left out**: the differential rests on what the
clinician wrote or accepted. Then the chart lines a summary uses (recent visits and their
diagnoses, allergies, medications). Every record is one numbered line ("S3").

**What comes back.** Up to six candidates, most likely first, each with its reasoning and the
lines it rests on; a candidate citing none is dropped. Confidence is ``low`` or ``medium``,
never ``high`` (no grounding check yet; D70). ``insufficientEvidence`` when nothing is left.
It suggests and never concludes: nothing is written to the chart or the visit.

**Where it is kept.** One ``ai_suggestion`` (target type differential) whose ID is the
differential's; readable by its requester only, after the chart check. Nothing is logged.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import Forbidden, NotFound
from app.core.long_running import Operation
from app.db.models.enums import AIConfidence, AIFeature, AIRequestStatus

from . import calls
from .output import DROP, prune
from .repository import AIRepository, SuggestionRecord
from .schemas import AiSourceLink, Differential, DifferentialCandidate, DifferentialCreate
from .service import OutputRejected, ensure_enabled
from .summary import ChartLine, SummaryChart

DIFFERENTIAL = "Differential"
KIND = "ai.differential"
PROMPT_CODE = "differential"
MAX_CANDIDATES = 6
MAX_OUTPUT_TOKENS = 3000
#: The permission to add a visit's diagnoses (MD, APP): the roles that diagnose.
DIAGNOSES = "diagnoses:create"
_HANDLE = re.compile(r"^S[0-9]{1,4}$")

DIFFERENTIAL_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "required": ["candidates", "insufficientEvidence"],
    "properties": {
        "candidates": {"type": "array", "maxItems": MAX_CANDIDATES, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["condition", "rationale", "likelihood", "sources"],
            "properties": {
                "condition": {"type": "string", "minLength": 1, "maxLength": 200},
                "rationale": {"type": "string", "minLength": 1, "maxLength": 1000},
                "likelihood": {"type": "string", "enum": ["low", "medium"]},
                "sources": {"type": "array", "maxItems": 20,
                            "items": {"type": "string", "pattern": "^S[0-9]{1,4}$"}}}}},
        "insufficientEvidence": {"type": "boolean"},
    },
}

DIFFERENTIAL_V1 = "\n".join((
    "You suggest a differential diagnosis to a clinician for one visit. The visit and the "
    "patient's chart are given as numbered lines (S1, S2, ...). Use only those lines.",
    "Return only a JSON object, with no other text:",
    '{"candidates": [{"condition": "<diagnosis>", "rationale": "<why, from the lines>", '
    '"likelihood": "medium", "sources": ["S1"]}], "insufficientEvidence": false}',
    "Rules:",
    f"- At most {MAX_CANDIDATES} candidates, the most likely first. likelihood is \"low\" or "
    "\"medium\", never higher.",
    "- Every candidate cites the lines that support it, and its rationale states only what "
    "those lines say. Never invent findings, results or history.",
    "- If the visit's lines hold too little to suggest anything, return no candidates and "
    "insufficientEvidence true.",
    "- You suggest; you never conclude, order or treat. Plain English; no Markdown; no line "
    "numbers in the text itself.",
))


@dataclass(frozen=True)
class VisitChart:
    """The visit's lines and the chart's, as read for a differential (api.py's reader)."""
    patient_id: UUID
    visit: tuple[ChartLine, ...]
    chart: SummaryChart


VisitReader = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[VisitChart]]
ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[Any]]


def lines_of(found: VisitChart) -> tuple[ChartLine, ...]:
    return found.visit + found.chart.lines


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
    return [{"role": "system", "content": DIFFERENTIAL_V1}, {"role": "user", "content": body}]


def keep(raw: Any, lines: tuple[ChartLine, ...]) -> tuple[list[dict[str, Any]], bool] | None:
    kept, _ = prune(raw, DIFFERENTIAL_SCHEMA)
    if kept is DROP or not isinstance(kept, dict):
        return None
    candidates: list[dict[str, Any]] = []
    for c in kept.get("candidates", []):
        handles = [h for h in dict.fromkeys(c["sources"]) if _HANDLE.match(h)
                   and 1 <= int(h[1:]) <= len(lines)]
        if not handles:
            continue
        candidates.append({
            "sequence": len(candidates) + 1, "condition": c["condition"].strip(),
            "rationale": c["rationale"].strip(),
            "confidence": "medium" if c["likelihood"] == "medium" else "low",
            "sources": [{"resourceType": lines[int(h[1:]) - 1].source.resource_type,
                         "resourceId": str(lines[int(h[1:]) - 1].source.resource_id),
                         "label": lines[int(h[1:]) - 1].label} for h in handles]})
    insufficient = bool(kept.get("insufficientEvidence", True)) and not candidates
    return candidates, insufficient or not candidates


async def differential(db: AsyncSession, repo: AIRepository, model: Any, encounter_id: UUID,
                       found: VisitChart) -> UUID:
    lines = lines_of(found)
    call = calls.Call(feature=AIFeature.DECISION_SUPPORT, name=PROMPT_CODE,
                      messages=render(found, await repo.patient_context(db, found.patient_id)),
                      schema=DIFFERENTIAL_SCHEMA, max_tokens=MAX_OUTPUT_TOKENS,
                      sources=[line.source for line in lines], patient_id=found.patient_id,
                      encounter_id=encounter_id)
    reply, record = await calls.complete(db, repo, model, call)
    kept = keep(reply.raw, lines)
    if kept is None:
        raise OutputRejected(await record(AIRequestStatus.FAILED, reply.reply,
                                          "output-rejected: nothing matched the schema"))
    candidates, insufficient = kept
    request_id = await record(AIRequestStatus.COMPLETED, reply.reply, None)
    return await repo.record_suggestion(db, SuggestionRecord(
        request_id=request_id, feature=AIFeature.DECISION_SUPPORT, patient_id=found.patient_id,
        encounter_id=encounter_id, target_resource_type=DIFFERENTIAL,
        content={"candidates": candidates, "insufficientEvidence": insufficient},
        confidence=AIConfidence.LOW.value if insufficient else AIConfidence.MEDIUM.value,
        rationale="Suggested by AI from the records cited; it never concludes. Check them "
                  "before acting.",
        unknowns=()))


async def create(db: AsyncSession, repo: AIRepository, model: Any, read: VisitReader,
                 user: CurrentUser, body: DifferentialCreate,
                 name_patients: Callable[[list[UUID]], None]) -> Operation:
    """createDifferential: the diagnosing permission (403), the switch (409), the visit as the
    user may read it (404, 403 D37), then the differential as a finished operation."""
    if not user.can(DIAGNOSES):
        raise Forbidden("Only clinicians who diagnose may ask for a differential",
                        code="permission-denied")
    await ensure_enabled(db, repo, AIFeature.CHART_SUMMARY)
    found = await read(db, user, body.encounter_id)
    name_patients([found.patient_id])
    return await calls.as_operation(
        db, KIND, "differential",
        lambda: differential(db, repo, model, body.encounter_id, found))


async def get(db: AsyncSession, repo: AIRepository, check: ChartCheck, user: CurrentUser,
              differential_id: UUID) -> Differential:
    """getDifferential: its requester only (404 for anyone else), after the chart check."""
    found = await repo.suggestion(db, differential_id)
    if found is None or found.target_resource_type != DIFFERENTIAL \
            or found.patient_id is None or found.encounter_id is None \
            or found.requested_by != user.id:
        raise NotFound()
    await check(db, user, found.patient_id)
    view = (await repo.suggestion_views(db, [differential_id]))[differential_id]
    return Differential(
        id=differential_id, patient_id=found.patient_id, encounter_id=found.encounter_id,
        candidates=[DifferentialCandidate(
            sequence=c["sequence"], condition=c["condition"], rationale=c["rationale"],
            confidence=c["confidence"],
            sources=[AiSourceLink.model_validate(link) for link in c["sources"]])
            for c in found.content.get("candidates", [])],
        insufficient_evidence=bool(found.content.get("insufficientEvidence", True)),
        ai_generated=True, generated_by=view.generated_by, created_at=view.created_at)
