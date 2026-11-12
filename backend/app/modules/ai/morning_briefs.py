"""The morning brief (contracts/openapi/modules/ai.yaml: createMorningBrief, getMorningBrief;
D116).

**Whose day.** The signed-in user's own appointments on the day: the provider their account is
linked to (``admin.app_user.practitioner_id``), read through the scheduling service with their
facility scope; cancelled, no-show, entered-in-error, proposed and waitlist appointments are
left out; at most 30, in time order. A user linked to no provider gets an empty brief, with no
model call.

**What the model sees.** For each patient, the same numbered chart lines as a summary
(summary.py: recent visits and their diagnoses, active allergies and medications), read as the
user through each module's own service with their permissions and the restricted-chart check
(D37). **A restricted chart the user may not open is never read**: the check comes first, and
its item says ``restricted`` with no statements. A chart with nothing recorded is not sent.
Lines carry per-patient handles ("P2-S3"), so every statement cites lines of its own patient.

**What comes back.** Up to five statements per patient, each citing its own patient's lines; a
statement citing none of them is dropped. One model call for the whole day.

**Where it is kept.** One ``ai_suggestion`` (target type morning brief, no patient: it spans
several) whose ID is the brief's; readable by its requester only, and each chart is checked
again on every read. Nothing of it is logged.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import date
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
from .schemas import (
    AiSourceLink,
    ChartAnswerStatement,
    MorningBrief,
    MorningBriefCreate,
    MorningBriefItem,
)
from .service import OutputRejected, ensure_enabled
from .summary import ChartLine, SummaryChart

BRIEF = "MorningBrief"
KIND = "ai.morning-brief"
PROMPT_CODE = "morning-brief"
MAX_APPOINTMENTS = 30
MAX_LINES = 40          # per patient
MAX_STATEMENTS = 5      # per patient
MAX_OUTPUT_TOKENS = 6000
#: The statuses of an appointment that is still happening that day.
STATUSES = ("booked", "arrived", "checked-in", "fulfilled", "pending")
_HANDLE = re.compile(r"^P([0-9]{1,2})-S([0-9]{1,3})$")

BRIEF_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["patients"],
    "properties": {"patients": {"type": "array", "maxItems": MAX_APPOINTMENTS, "items": {
        "type": "object", "additionalProperties": False, "required": ["patient", "statements"],
        "properties": {
            "patient": {"type": "string", "pattern": "^P[0-9]{1,2}$"},
            "statements": {"type": "array", "maxItems": MAX_STATEMENTS, "items": {
                "type": "object", "additionalProperties": False,
                "required": ["text", "sources"],
                "properties": {
                    "text": {"type": "string", "minLength": 1, "maxLength": 600},
                    "sources": {"type": "array", "maxItems": 10, "items": {
                        "type": "string", "pattern": "^P[0-9]{1,2}-S[0-9]{1,3}$"}}}}}}}}},
}

BRIEF_V1 = "\n".join((
    "You prepare a clinician's morning brief: for each patient they see today, what to know "
    "before the visit. Each patient's chart is given as numbered lines (P1-S1, P1-S2, ...). "
    "Use only those lines.",
    "Return only a JSON object, with no other text:",
    '{"patients": [{"patient": "P1", "statements": [{"text": "<statement>", '
    '"sources": ["P1-S2"]}]}]}',
    "Rules:",
    f"- At most {MAX_STATEMENTS} short statements per patient, the most useful first: active "
    "problems, recent visits and their diagnoses, allergies, medications.",
    "- Every statement cites the lines it rests on, and only lines of its own patient. Use only "
    "facts the cited lines state; never add anything from general knowledge, never guess, "
    "never recommend treatment.",
    "- Plain English; no Markdown; no line numbers in the text itself.",
))


# ----------------------------------------------------------------------------- the brief
@dataclass(frozen=True)
class Visit:
    """One appointment of the day, as the scheduling service lists it."""
    appointment_id: UUID
    patient_id: UUID
    start_at: Any
    type_name: str


@dataclass(frozen=True)
class Chart:
    visit: Visit
    status: str                     # summarized | nothing-recorded | restricted
    lines: tuple[ChartLine, ...] = ()
    context: str | None = None


DayReader = Callable[[AsyncSession, CurrentUser, date], Awaitable[Sequence[Visit]]]
ChartReader = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[SummaryChart]]
ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[Any]]


async def charts(db: AsyncSession, repo: AIRepository, check: ChartCheck, read: ChartReader,
                 user: CurrentUser, visits: Sequence[Visit]) -> list[Chart]:
    """Each visit's chart: the restricted-chart check first, so a chart the user may not open
    is never read; each patient read once."""
    read_once: dict[UUID, Chart] = {}
    out = []
    for visit in visits[:MAX_APPOINTMENTS]:
        known = read_once.get(visit.patient_id)
        if known is None:
            try:
                await check(db, user, visit.patient_id)
            except (Forbidden, NotFound):
                known = Chart(visit, "restricted")
            else:
                chart = await read(db, user, visit.patient_id)
                lines = chart.lines[:MAX_LINES]
                known = Chart(visit, "summarized" if lines else "nothing-recorded", lines,
                              await repo.patient_context(db, visit.patient_id))
            read_once[visit.patient_id] = known
        out.append(Chart(visit, known.status, known.lines, known.context))
    return out


def render(day: date, sent: Sequence[Chart]) -> list[dict[str, str]]:
    blocks = []
    for p, chart in enumerate(sent, 1):
        head = (f"Patient P{p}: {chart.visit.start_at.strftime('%H:%M UTC')}, "
                f"{chart.visit.type_name}" + (f", {chart.context}" if chart.context else ""))
        blocks.append("\n".join([head] + [f"P{p}-S{i}: {line.text}"
                                          for i, line in enumerate(chart.lines, 1)]))
    return [{"role": "system", "content": BRIEF_V1},
            {"role": "user", "content": f"Day: {day.isoformat()}.\n\n" + "\n\n".join(blocks)}]


def keep(raw: Any, sent: Sequence[Chart]) -> dict[int, list[dict[str, Any]]] | None:
    """Statements by patient number, each citing lines of its own patient; None when the reply
    doesn't fit the schema at all."""
    kept, _ = prune(raw, BRIEF_SCHEMA)
    if kept is DROP or not isinstance(kept, dict):
        return None
    out: dict[int, list[dict[str, Any]]] = {}
    for entry in kept.get("patients", []):
        p = int(entry["patient"][1:])
        if not 1 <= p <= len(sent) or p in out:
            continue
        lines = sent[p - 1].lines
        statements: list[dict[str, Any]] = []
        for statement in entry["statements"]:
            links = []
            for handle in dict.fromkeys(statement["sources"]):
                m = _HANDLE.match(handle)
                if m and int(m[1]) == p and 1 <= int(m[2]) <= len(lines):
                    line = lines[int(m[2]) - 1]
                    links.append({"resourceType": line.source.resource_type,
                                  "resourceId": str(line.source.resource_id),
                                  "label": line.label})
            if links:
                statements.append({"sequence": len(statements) + 1,
                                   "text": statement["text"].strip(), "sources": links})
        out[p] = statements
    return out


async def brief(db: AsyncSession, repo: AIRepository, model: Any, day: date,
                found: Sequence[Chart]) -> UUID:
    """The model call (only when a chart has something to send), the request record and the
    stored brief."""
    sent = [c for c in found if c.status == "summarized"]
    by_patient: dict[int, list[dict[str, Any]]] = {}
    sources = [line.source for c in sent for line in c.lines]
    call = calls.Call(feature=AIFeature.CHART_SUMMARY, name=PROMPT_CODE,
                      messages=render(day, sent), schema=BRIEF_SCHEMA,
                      max_tokens=MAX_OUTPUT_TOKENS, sources=sources)
    if sent:
        reply, record = await calls.complete(db, repo, model, call)
        kept = keep(reply.raw, sent)
        if kept is None:
            raise OutputRejected(await record(AIRequestStatus.FAILED, reply.reply,
                                              "output-rejected: nothing matched the schema"))
        by_patient = kept
        request_id = await record(AIRequestStatus.COMPLETED, reply.reply, None)
    else:
        # Nothing to send: no model call, and a record that says so (no tokens).
        request_id = await calls.Recorder(db, repo, model, call)(
            AIRequestStatus.COMPLETED, None, "no-call: no chart to brief on")
    number = {id(c): i for i, c in enumerate(sent, 1)}
    items = []
    for c in found:
        statements = by_patient.get(number[id(c)], []) if c.status == "summarized" else []
        items.append({"appointmentId": str(c.visit.appointment_id),
                      "patientId": str(c.visit.patient_id),
                      "startAt": c.visit.start_at.isoformat(), "chartStatus": c.status,
                      "statements": statements})
    return await repo.record_suggestion(db, SuggestionRecord(
        request_id=request_id, feature=AIFeature.CHART_SUMMARY, patient_id=None,
        encounter_id=None, target_resource_type=BRIEF,
        content={"date": day.isoformat(), "appointments": items},
        confidence=AIConfidence.LOW.value if any(
            c.status == "summarized" and not by_patient.get(number[id(c)]) for c in found)
        else AIConfidence.MEDIUM.value,
        rationale="Briefed by AI from the chart records cited; check them before acting.",
        unknowns=()))


# ------------------------------------------------------------------------------- the rules
async def create(db: AsyncSession, repo: AIRepository, model: Any, check: ChartCheck,
                 day_reader: DayReader, read: ChartReader, user: CurrentUser,
                 body: MorningBriefCreate, name_patients: Callable[[list[UUID]], None]
                 ) -> Operation:
    """createMorningBrief: the switch (409), the day's appointments, each chart (restricted
    ones never read), then the brief as a finished operation. Every chart read is audited."""
    await ensure_enabled(db, repo, AIFeature.CHART_SUMMARY)
    visits = await day_reader(db, user, body.date)
    found = await charts(db, repo, check, read, user, visits)
    name_patients([c.visit.patient_id for c in found if c.status != "restricted"])
    return await calls.as_operation(db, KIND, "morning-brief",
                                    lambda: brief(db, repo, model, body.date, found))


async def get(db: AsyncSession, repo: AIRepository, check: ChartCheck, user: CurrentUser,
              brief_id: UUID) -> MorningBrief:
    """getMorningBrief: its requester only (404 for anyone else); each chart checked again, and
    an item whose chart the user may no longer open comes back restricted, without text."""
    found = await repo.suggestion(db, brief_id)
    if found is None or found.target_resource_type != BRIEF or found.requested_by != user.id:
        raise NotFound()
    made = await repo.generation(db, brief_id)
    if made is None:
        raise NotFound()
    allowed: dict[str, bool] = {}
    items = []
    for item in found.content.get("appointments", []):
        patient = item["patientId"]
        if patient not in allowed:
            try:
                await check(db, user, UUID(patient))
                allowed[patient] = True
            except (Forbidden, NotFound):
                allowed[patient] = False
        status = item["chartStatus"] if allowed[patient] else "restricted"
        items.append(MorningBriefItem(
            appointment_id=UUID(item["appointmentId"]), patient_id=UUID(patient),
            start_at=item["startAt"], chart_status=status,
            statements=[ChartAnswerStatement(
                sequence=s["sequence"], text=s["text"],
                sources=[AiSourceLink.model_validate(link) for link in s["sources"]])
                for s in item["statements"]] if status == "summarized" else []))
    return MorningBrief(id=brief_id, date=found.content["date"], appointments=items,
                        ai_generated=True, generated_by=made[0], created_at=made[1])


def readable_patients(found: MorningBrief) -> list[UUID]:
    """The patients whose chart text this read returns (for the audit)."""
    return [i.patient_id for i in found.appointments if i.chart_status != "restricted"]
