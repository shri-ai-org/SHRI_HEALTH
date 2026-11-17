"""AI-04's ICD-10-CM coding suggestions for a visit (contracts/openapi/modules/ai.yaml:
createCodingSuggestion, getCodingSuggestion, decideSuggestedCode; D70, D119).

**Who asks.** A clinician who can diagnose: ``chart-summaries:create`` and ``diagnoses:create``
(MD, APP); anyone else gets ``403 permission-denied``. The same for each decision.

**What the model sees.** The same lines as a differential (differentials.VisitChart, read by
api.py's reader as the clinician with their permissions and the restricted-chart check, D37):
the visit's reason, diagnoses, vital signs and reviewed note sections, then the chart. **A note
section the AI drafted and nobody reviewed yet is left out by the reader.**

**What comes back.** Up to six codes, best supported first, each with its reasoning and the
lines it rests on. A code is kept only when it cites a line it was given **and** is an active,
billable code in the loaded ICD-10-CM table (the encounters' own lookup, the one
addEncounterDiagnosis checks), and is not already on the visit; its name is the table's, never
the model's. Confidence is ``low`` or ``medium``, never ``high``.

**Where it is kept.** One ``ai_suggestion`` for the whole suggestion (target type
``CodingSuggestion``; its ID is the suggestion's), and one per code (``SuggestedCode``, its ID
the code's), all from the same ``ai_request``; feature ``coding-suggestion``. Each code carries
its own decision, recorded once (the database refuses a second). Readable by its requester only.

**The decision.** ``rejected`` (with a reason) changes nothing on the visit. ``accepted`` is the
clinician's action that adds the code: in one transaction the decision is recorded and the code
becomes a visit diagnosis through the encounters' diagnosis service (same rules and refusals
as addEncounterDiagnosis), which commits both; the code's suggestion then points at the new
Condition (``target_id``), the response's ``diagnosisId``. Nothing is ever added without it.
Nothing of any of it is logged.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed, field_error
from app.core.long_running import Operation
from app.db.models.enums import AIConfidence, AIDecision, AIFeature, AIRequestStatus

from . import calls
from .differentials import ChartCheck, VisitChart, lines_of
from .output import DROP, prune
from .repository import AIRepository, SuggestionHead, SuggestionRecord
from .schemas import (
    AiSourceLink,
    CodingSuggestion,
    CodingSuggestionCreate,
    SuggestedCode,
    SuggestedCodeDecision,
)
from .service import OutputRejected, ensure_enabled
from .summary import ChartLine

SET = "CodingSuggestion"
CODE = "SuggestedCode"
KIND = "ai.coding-suggestion"
PROMPT_CODE = "coding-suggestion"
MAX_CODES = 6
MAX_OUTPUT_TOKENS = 3000
#: The permission to add a visit's diagnoses (MD, APP): the roles that code a visit.
DIAGNOSES = "diagnoses:create"
_HANDLE = re.compile(r"^S[0-9]{1,4}$")
_ICD10CM = re.compile(r"^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$")

CODING_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "required": ["codes", "insufficientEvidence"],
    "properties": {
        "codes": {"type": "array", "maxItems": MAX_CODES, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["code", "rationale", "likelihood", "sources"],
            "properties": {
                "code": {"type": "string", "minLength": 3, "maxLength": 10},
                "rationale": {"type": "string", "minLength": 1, "maxLength": 1000},
                "likelihood": {"type": "string", "enum": ["low", "medium"]},
                "sources": {"type": "array", "maxItems": 20,
                            "items": {"type": "string", "pattern": "^S[0-9]{1,4}$"}}}}},
        "insufficientEvidence": {"type": "boolean"},
    },
}

CODING_V1 = "\n".join((
    "You suggest ICD-10-CM diagnosis codes to a clinician for one visit. The visit and the "
    "patient's chart are given as numbered lines (S1, S2, ...). Use only those lines.",
    "Return only a JSON object, with no other text:",
    '{"codes": [{"code": "<ICD-10-CM code, e.g. J20.9>", "rationale": "<why, from the '
    'lines>", "likelihood": "medium", "sources": ["S1"]}], "insufficientEvidence": false}',
    "Rules:",
    f"- At most {MAX_CODES} codes, the best supported first: codes for what this visit "
    "assessed or treated, as specific as the lines allow. Only billable ICD-10-CM codes (the "
    "most specific level), written with their dot.",
    "- Never suggest a code for a diagnosis already listed at this visit.",
    "- Every code cites the lines that support it, and its rationale states only what those "
    "lines say. Never invent findings, results or history. likelihood is \"low\" or "
    "\"medium\", never higher.",
    "- If the visit's lines hold too little to code, return no codes and insufficientEvidence "
    "true.",
    "- Plain English; no Markdown; no line numbers in the rationale.",
))


@dataclass(frozen=True)
class CodingVisit:
    """The visit's lines and the chart's (as a differential reads them) and the ICD-10-CM codes
    already on the visit."""
    chart: VisitChart
    existing: frozenset[str]


@dataclass(frozen=True)
class Concept:
    """An ICD-10-CM concept as the loaded table holds it."""
    code: str
    display: str
    billable: bool


CodingReader = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[CodingVisit]]
CodeLookup = Callable[[AsyncSession, str], Awaitable[Concept | None]]
#: Adds an accepted code as a visit diagnosis through the encounters' diagnosis service, which
#: names the patient for the audit and commits; returns the new diagnosis' ID.
AddDiagnosis = Callable[[AsyncSession, CurrentUser, UUID, str, str, Callable[[UUID], None]],
                        Awaitable[UUID]]


def normalize(code: str) -> str | None:
    """A code as the table writes it (upper case, with its dot), or None when it can't be one."""
    raw = re.sub(r"\s+", "", code).upper()
    if "." not in raw and len(raw) > 3:
        raw = f"{raw[:3]}.{raw[3:]}"
    return raw if _ICD10CM.match(raw) else None


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
    return [{"role": "system", "content": CODING_V1}, {"role": "user", "content": body}]


async def keep(db: AsyncSession, raw: Any, lines: tuple[ChartLine, ...],
               existing: frozenset[str], lookup: CodeLookup
               ) -> tuple[list[dict[str, Any]], bool] | None:
    """The codes that cite a line they were given, exist (active, billable) in the ICD-10-CM
    table and aren't on the visit, each once, renumbered; None when the reply doesn't fit the
    schema at all."""
    kept, _ = prune(raw, CODING_SCHEMA)
    if kept is DROP or not isinstance(kept, dict):
        return None
    codes: list[dict[str, Any]] = []
    seen: set[str] = set(existing)
    for c in kept.get("codes", []):
        handles = [h for h in dict.fromkeys(c["sources"]) if _HANDLE.match(h)
                   and 1 <= int(h[1:]) <= len(lines)]
        code = normalize(c["code"])
        if not handles or code is None or code in seen:
            continue
        concept = await lookup(db, code)
        if concept is None or not concept.billable or concept.code in seen:
            continue
        seen.add(concept.code)
        codes.append({
            "sequence": len(codes) + 1, "code": concept.code, "display": concept.display,
            "rationale": c["rationale"].strip(),
            "confidence": "medium" if c["likelihood"] == "medium" else "low",
            "sources": [{"resourceType": lines[int(h[1:]) - 1].source.resource_type,
                         "resourceId": str(lines[int(h[1:]) - 1].source.resource_id),
                         "label": lines[int(h[1:]) - 1].label} for h in handles]})
    return codes, not codes


async def suggest(db: AsyncSession, repo: AIRepository, model: Any, lookup: CodeLookup,
                  encounter_id: UUID, found: CodingVisit) -> UUID:
    chart = found.chart
    lines = lines_of(chart)
    call = calls.Call(feature=AIFeature.CODING_SUGGESTION, name=PROMPT_CODE,
                      messages=render(chart, await repo.patient_context(db, chart.patient_id)),
                      schema=CODING_SCHEMA, max_tokens=MAX_OUTPUT_TOKENS,
                      sources=[line.source for line in lines], patient_id=chart.patient_id,
                      encounter_id=encounter_id)
    reply, record = await calls.complete(db, repo, model, call)
    kept = await keep(db, reply.raw, lines, found.existing, lookup)
    if kept is None:
        raise OutputRejected(await record(AIRequestStatus.FAILED, reply.reply,
                                          "output-rejected: nothing matched the schema"))
    codes, insufficient = kept
    request_id = await record(AIRequestStatus.COMPLETED, reply.reply, None)
    rationale = ("Suggested by AI from the records cited; nothing is added to the visit until "
                 "the clinician accepts it.")
    set_id = await repo.record_suggestion(db, SuggestionRecord(
        request_id=request_id, feature=AIFeature.CODING_SUGGESTION, patient_id=chart.patient_id,
        encounter_id=encounter_id, target_resource_type=SET,
        content={"insufficientEvidence": insufficient},
        confidence=AIConfidence.LOW.value if insufficient else AIConfidence.MEDIUM.value,
        rationale=rationale, unknowns=()))
    for code in codes:
        await repo.record_suggestion(db, SuggestionRecord(
            request_id=request_id, feature=AIFeature.CODING_SUGGESTION,
            patient_id=chart.patient_id, encounter_id=encounter_id, target_resource_type=CODE,
            content=code,
            confidence=code["confidence"], rationale=code["rationale"], unknowns=()))
    return set_id


def _may_code(user: CurrentUser) -> None:
    if not user.can(DIAGNOSES):
        raise Forbidden("Only clinicians who diagnose may code a visit", code="permission-denied")


async def create(db: AsyncSession, repo: AIRepository, model: Any, read: CodingReader,
                 lookup: CodeLookup, user: CurrentUser, body: CodingSuggestionCreate,
                 name_patients: Callable[[list[UUID]], None]) -> Operation:
    """createCodingSuggestion: the diagnosing permission (403), the switch (409), the visit as
    the user may read it (404, 403 D37), then the suggestion as a finished operation."""
    _may_code(user)
    await ensure_enabled(db, repo, AIFeature.CHART_SUMMARY)
    found = await read(db, user, body.encounter_id)
    name_patients([found.chart.patient_id])
    return await calls.as_operation(
        db, KIND, "coding-suggestion",
        lambda: suggest(db, repo, model, lookup, body.encounter_id, found))


async def _own_set(db: AsyncSession, repo: AIRepository, check: ChartCheck, user: CurrentUser,
                   set_id: UUID) -> SuggestionHead:
    found = await repo.suggestion(db, set_id)
    if found is None or found.target_resource_type != SET or found.patient_id is None \
            or found.encounter_id is None or found.requested_by != user.id:
        raise NotFound()
    await check(db, user, found.patient_id)
    return found


async def _codes(db: AsyncSession, repo: AIRepository, set_id: UUID,
                 only: UUID | None = None) -> list[SuggestedCode]:
    heads = [h for h in await repo.siblings(db, set_id, CODE) if only is None or h.id == only]
    views = await repo.suggestion_views(db, [h.id for h in heads])
    out = []
    for h in heads:
        view = views.get(h.id)
        c = h.content
        out.append(SuggestedCode(
            id=h.id, sequence=c["sequence"], code=c["code"], display=c["display"],
            rationale=c["rationale"], confidence="medium" if c["confidence"] == "medium" else "low",
            sources=[AiSourceLink.model_validate(link) for link in c["sources"]],
            decision="accepted" if h.decision == AIDecision.ACCEPTED.value
            else "rejected" if h.decision == AIDecision.REJECTED.value else "pending",
            decided_at=view.decided_at if view else None,
            decided_by=view.decided_by if view else None,
            rejection_reason=view.rejection_reason if view else None,
            diagnosis_id=h.target_id if h.decision == AIDecision.ACCEPTED.value else None))
    return out


async def get(db: AsyncSession, repo: AIRepository, check: ChartCheck, user: CurrentUser,
              set_id: UUID) -> CodingSuggestion:
    """getCodingSuggestion: its requester only (404 for anyone else), after the chart check."""
    found = await _own_set(db, repo, check, user, set_id)
    made = await repo.generation(db, set_id)
    if made is None or found.patient_id is None or found.encounter_id is None:
        raise NotFound()
    return CodingSuggestion(
        id=set_id, patient_id=found.patient_id, encounter_id=found.encounter_id,
        codes=await _codes(db, repo, set_id),
        insufficient_evidence=bool(found.content.get("insufficientEvidence", True)),
        ai_generated=True, generated_by=made[0], created_at=made[1])


def _decision_body(body: SuggestedCodeDecision) -> None:
    if body.decision == "rejected" and body.reason is None:
        raise ValidationFailed(errors=[field_error("body", "/reason", "required")])
    if body.decision != "rejected" and body.reason is not None:
        raise ValidationFailed(errors=[field_error("body", "/reason", "not-allowed-value")])


async def decide(db: AsyncSession, repo: AIRepository, check: ChartCheck, add: AddDiagnosis,
                 user: CurrentUser, set_id: UUID, code_id: UUID, body: SuggestedCodeDecision,
                 name_patient: Callable[[UUID], None]) -> SuggestedCode:
    """decideSuggestedCode: the diagnosing permission (403), the body (422), the requester's own
    suggestion and code (404, 403 D37), still pending (409); then the decision, and for
    ``accepted`` the diagnosis, committed together."""
    _may_code(user)
    _decision_body(body)
    found = await _own_set(db, repo, check, user, set_id)
    if found.encounter_id is None or found.patient_id is None or code_id not in {
            h.id for h in await repo.siblings(db, set_id, CODE)}:
        raise NotFound()
    locked = await repo.suggestion(db, code_id, lock=True)
    if locked is None:
        raise NotFound()
    if locked.decision != AIDecision.PENDING.value:
        raise Conflict(code="invalid-state-transition", currentState=locked.decision)
    await repo.decide(db, code_id, AIDecision(body.decision), rejection_reason=body.reason)
    if body.decision == "accepted":
        # The diagnosis service applies addEncounterDiagnosis' rules, names the patient and
        # commits the decision with the diagnosis; a refusal rolls both back.
        diagnosis_id = await add(db, user, found.encounter_id, locked.content["code"],
                                 locked.content["display"], name_patient)
        await repo.set_suggestion_target(db, code_id, diagnosis_id)
    else:
        name_patient(found.patient_id)
    await db.commit()
    return (await _codes(db, repo, set_id, only=code_id))[0]
