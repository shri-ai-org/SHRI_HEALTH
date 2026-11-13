"""AI API, batch 7 (contracts/openapi/modules/ai.yaml): AI-01's note drafts, the decision on an AI
suggestion, transcripts and the clinic's AI settings. Each route's operation_id is the contract's
operationId; the permission (``require``) is the first dependency. Routes that touch a chart run
the facility and restricted-chart checks (D37) and name the patient for core's audit (x-audit
patient ``result``): category ``ai`` for the draft and the decision, ``phi-read`` for the
transcript, ``admin`` for the settings.

Not mounted yet (see the module's report): createEncounterAudio and createTranscription (no
speech service, no upload rule for ``encounter-audio`` and no server-generated file purpose for
transcripts). createChartSummary and getChartSummary (AI-02) read the chart within the
caller's own request, through each module's service (no delegated token while AI runs inside
the API; #255, Thulasi on #85).

The pieces from other owners are FastAPI dependencies, so the tests can replace them: the model
(config.py), the file service's store and crypto (Anand's), core's chart check and audit hook,
and the note template (practice setup's repository, Anand's).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime
from typing import Annotated, Any
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core import audit as core_audit
from app.core.deps import CurrentUser, require, tenant_db
from app.core.long_running import accepted
from app.modules.encounters import notes_service
from app.modules.encounters import service as encounters_service
from app.modules.encounters.ai_drafts import EncounterNoteDrafts
from app.modules.encounters.notes_repository import SqlNoteRepository
from app.modules.encounters.repository import EncounterHead, SqlEncounterRepository
from app.modules.encounters.service import readable
from app.modules.files.crypto import FileCrypto, file_crypto
from app.modules.files.storage import FileStore, file_store
from app.modules.history import service as history_service
from app.modules.history.repository import SqlAllergyRepository, SqlHistoryRepository
from app.modules.medications import service as medications_service
from app.modules.medications.repository import SqlMedicationRepository
from app.modules.practice_setup.repository import SqlSetupRepository
from app.modules.scheduling import service as scheduling_service
from app.modules.scheduling.reference import reference as scheduling_reference

from . import chart_answers as answers
from . import chart_context as chart_lines
from . import chart_summaries as summaries
from . import differentials as ddx
from . import drafts as rules
from . import morning_briefs as briefs
from . import settings as ai_settings
from . import summary as summary_lines
from .config import configured_model
from .model_client import ModelClient
from .repository import AIRepository, SqlAIRepository
from .schemas import (
    AiSettings,
    AiSettingsUpdate,
    AiSuggestion,
    AiSuggestionDecision,
    ChartAnswer,
    ChartQuestionCreate,
    ChartSummary,
    ChartSummaryCreate,
    Differential,
    DifferentialCreate,
    MorningBrief,
    MorningBriefCreate,
    NoteDraftCreate,
    PageType,
    SourceRef,
    SuggestedQuestionList,
    TemplateSection,
    Transcription,
)
from .service import Gateway
from .transcripts import FileTranscripts, Transcripts

router = APIRouter(tags=["ai"])


def repository() -> AIRepository:
    return SqlAIRepository()


def model(request: Request) -> ModelClient:
    """The configured model, with core's settings: the Claude API key from OpenBao
    (``claude_api_key``, #257), its only source, and the environment the API runs in."""
    settings = request.app.state.settings
    secret = getattr(settings, "claude_api_key", None)
    return configured_model(api_key=secret.get_secret_value() if secret else None,
                            environment=getattr(settings, "environment", None))


def note_drafts() -> rules.Drafts:
    return EncounterNoteDrafts()


def transcripts(store: Annotated[FileStore, Depends(file_store)],
                crypto: Annotated[FileCrypto, Depends(file_crypto)]) -> Transcripts:
    return FileTranscripts(store, crypto)


def chart_check() -> rules.ChartCheck:
    """Core's restricted-chart check (D37; 404 unknown patient, 403 break-glass-required)."""
    return core_access.ensure_chart_access


def audit_patients() -> Any:
    """Core's hook naming the patients of an operation whose x-audit patient is "result"."""
    return core_audit.audit_patients


def template_reader() -> rules.Template:
    """A note template through practice setup's repository (Anand's read; RLS keeps it to the
    clinic)."""
    setup = SqlSetupRepository()

    async def read(db: AsyncSession, template_id: UUID) -> rules.TemplateView | None:
        found = await setup.get_note_template(db, template_id)
        if found is None:
            return None
        return rules.TemplateView(
            id=found.id, name=found.name, note_type_loinc=found.note_type_loinc,
            active=found.active, owner_user_id=found.owner_user_id,
            sections=tuple(TemplateSection(s.section_code, s.title, s.required)
                           for s in sorted(found.sections, key=lambda s: s.sequence)))

    return read


async def _readable(db: AsyncSession, check: rules.ChartCheck, user: CurrentUser,
                    encounter_id: UUID) -> EncounterHead:
    return await readable(db, SqlEncounterRepository(), check, user, encounter_id)


def encounters() -> rules.Encounters:
    return _readable


def chart_reader(check: Annotated[rules.ChartCheck, Depends(chart_check)]
                 ) -> chart_lines.ChartReader:
    """What a draft may know of the chart, read through each module's own service as the
    clinician (chart_context.py): a part is read only with its read permission."""
    async def read(db: AsyncSession, user: CurrentUser, patient_id: UUID, encounter_id: UUID
                   ) -> chart_lines.ChartContext:
        allergies: tuple[list[str], list[Any]] = ([], [])
        medications: tuple[list[str], list[Any]] = ([], [])
        diagnoses: tuple[list[str], list[Any]] = ([], [])
        if user.can("allergies:read"):
            found, _ = await history_service.list_allergies(
                db, SqlAllergyRepository(), check, user, patient_id,
                include_entered_in_error=False, limit=chart_lines.LIMIT, cursor=None)
            allergies = chart_lines.allergy_lines(found)
        if user.can("medications:read"):
            listed = await medications_service.list_medications(
                db, SqlMedicationRepository(), check, user, patient_id, status="active",
                limit=chart_lines.LIMIT, cursor=None)
            medications = chart_lines.medication_lines(listed.items)
        if user.can("encounters:read"):
            visit = await encounters_service.get(db, SqlEncounterRepository(), check, user,
                                                 encounter_id)
            diagnoses = chart_lines.diagnosis_lines(visit.value.diagnoses)
        return chart_lines.ChartContext(
            allergies=tuple(allergies[0]), medications=tuple(medications[0]),
            diagnoses=tuple(diagnoses[0]),
            sources=tuple(allergies[1] + medications[1] + diagnoses[1]))

    return read


DB = Annotated[AsyncSession, Depends(tenant_db)]
Repo = Annotated[AIRepository, Depends(repository)]
Model = Annotated[ModelClient, Depends(model)]
Drafts = Annotated[rules.Drafts, Depends(note_drafts)]
Texts = Annotated[Transcripts, Depends(transcripts)]
Check = Annotated[rules.ChartCheck, Depends(chart_check)]
Audit = Annotated[Any, Depends(audit_patients)]
Templates = Annotated[rules.Template, Depends(template_reader)]
Readable = Annotated[rules.Encounters, Depends(encounters)]
Chart = Annotated[chart_lines.ChartReader, Depends(chart_reader)]


def _day(moment: datetime | None, time_zone: str | None) -> str:
    """The visit's day in its facility's time zone (D40), not UTC's: an evening visit in San Jose
    is still that day there."""
    if moment is None:
        return "date unknown"
    return (moment.astimezone(ZoneInfo(time_zone)) if time_zone else moment).date().isoformat()


def summary_reader(check: Annotated[rules.ChartCheck, Depends(chart_check)]
                   ) -> summaries.SummaryReader:
    """The chart a summary may use, read as the clinician through each module's own service
    (summary.py): the recent visits and their diagnoses, active allergies and medications,
    each only with its read permission, and the problem list (#280). Results have no service yet."""
    async def read(db: AsyncSession, user: CurrentUser, patient_id: UUID
                   ) -> summary_lines.SummaryChart:
        lines: list[summary_lines.ChartLine] = []
        unavailable = ["results (not in this build)"]
        if user.can("problems:read"):
            problems, _ = await history_service.page(
                db, check, user, patient_id, SqlHistoryRepository().problems,
                include_entered_in_error=False, limit=chart_lines.LIMIT, cursor=None)
            names, sources = chart_lines.problem_lines(problems)
            lines += [summary_lines.ChartLine(f"Problem list: {name}", source, "Problem list entry")
                      for name, source in zip(names, sources, strict=True)]
        else:
            unavailable.append("the problem list (no permission)")
        if user.can("encounters:read"):
            visits, _ = await encounters_service.list_for_patient(
                db, SqlEncounterRepository(), check, user, patient_id, status=None,
                date_from=None, date_to=None, limit=10, cursor=None)
            for v in visits:
                kind = next((chart_lines.label(c) for c in v.types or []
                             if chart_lines.label(c)), "visit")
                with_whom = (f", with {v.rendering_provider.display_name}"
                             if v.rendering_provider else "")
                found = await encounters_service.get(db, SqlEncounterRepository(), check, user,
                                                     v.id)
                day = _day(v.started_at, found.value.time_zone)
                lines.append(summary_lines.ChartLine(
                    f"Visit: {day}, {kind}, {v.status}{with_whom}",
                    SourceRef("Encounter", v.id), f"Visit of {day}"))
                names, sources = chart_lines.diagnosis_lines(found.value.diagnoses)
                lines += [summary_lines.ChartLine(
                    f"Diagnosis: {name}, at the visit of {day}", source,
                    "Visit diagnosis") for name, source in zip(names, sources, strict=True)]
        else:
            unavailable.append("visits and diagnoses (no permission)")
        if user.can("allergies:read"):
            found_allergies, _ = await history_service.list_allergies(
                db, SqlAllergyRepository(), check, user, patient_id,
                include_entered_in_error=False, limit=chart_lines.LIMIT, cursor=None)
            names, sources = chart_lines.allergy_lines(found_allergies)
            lines += [summary_lines.ChartLine(f"Allergy: {name}", source, "Allergy")
                      for name, source in zip(names, sources, strict=True)]
        else:
            unavailable.append("allergies (no permission)")
        if user.can("medications:read"):
            listed = await medications_service.list_medications(
                db, SqlMedicationRepository(), check, user, patient_id, status="active",
                limit=chart_lines.LIMIT, cursor=None)
            names, sources = chart_lines.medication_lines(listed.items)
            lines += [summary_lines.ChartLine(f"Medication: {name}", source, "Medication list")
                      for name, source in zip(names, sources, strict=True)]
        else:
            unavailable.append("medications (no permission)")
        return summary_lines.SummaryChart(lines=tuple(lines), unavailable=tuple(unavailable))

    return read


def day_reader(repo: Annotated[AIRepository, Depends(repository)]) -> briefs.DayReader:
    """The signed-in user's own appointments on a day, through the scheduling service (their
    facility scope): the provider their account is linked to; none without one."""
    async def read(db: AsyncSession, user: CurrentUser, day: date) -> list[briefs.Visit]:
        if not user.can("appointments:read"):
            return []
        provider = await repo.practitioner_of_user(db, user.id)
        if provider is None:
            return []
        found, _, _ = await scheduling_service.list_view(
            db, scheduling_reference(), user, days=(day, day), facility_id=None,
            provider_id=provider, patient_id=None, statuses=briefs.STATUSES,
            limit=briefs.MAX_APPOINTMENTS, offset=0)
        return sorted((briefs.Visit(a.id, a.patient.id, a.start_at, a.appointment_type.name)
                       for a in found), key=lambda v: v.start_at)

    return read


def _vital(v: Any) -> str | None:
    if v.blood_pressure is not None:
        bp = v.blood_pressure
        return f"{bp.systolic.value:g}/{bp.diastolic.value:g} {bp.systolic.unit}"
    if v.value is not None:
        return f"{v.value.value:g} {v.value.unit}"
    return None


def differential_reader(check: Annotated[rules.ChartCheck, Depends(chart_check)],
                        chart: Annotated[summaries.SummaryReader, Depends(summary_reader)]
                        ) -> ddx.VisitReader:
    """The visit a differential may use, read as the clinician (differentials.py): its reasons,
    diagnoses, vital signs and reviewed note sections, each only with its read permission; then
    the chart lines a summary uses. An AI section nobody reviewed yet is left out."""
    async def read(db: AsyncSession, user: CurrentUser, encounter_id: UUID) -> ddx.VisitChart:
        found = await encounters_service.get(db, SqlEncounterRepository(), check, user,
                                             encounter_id)
        visit = found.value
        here = SourceRef("Encounter", visit.id)
        lines = [summary_lines.ChartLine(f"Reason for visit: {r}", here, "Reason for visit")
                 for r in (chart_lines.label(c) for c in visit.reasons or []) if r]
        names, sources = chart_lines.diagnosis_lines(visit.diagnoses)
        lines += [summary_lines.ChartLine(f"Diagnosis at this visit: {name}", source,
                                          "Visit diagnosis")
                  for name, source in zip(names, sources, strict=True)]
        if user.can("vitals:read"):
            vitals, _ = await encounters_service.list_vitals(
                db, SqlEncounterRepository(), check, user, visit.patient_id, vital_type=None,
                date_from=None, date_to=None, include_entered_in_error=False, limit=50,
                cursor=None)
            for v in vitals:
                shown = _vital(v)
                if v.encounter_id == visit.id and shown:
                    lines.append(summary_lines.ChartLine(
                        f"Vital sign at this visit: {v.type} {shown}",
                        SourceRef("Observation", v.id), "Vital sign"))
        if user.can("notes:read"):
            _, notes, _ = await notes_service.list_for_encounter(
                db, SqlEncounterRepository(), SqlNoteRepository(), check, user, visit.id,
                status=None, limit=3, cursor=None)
            for summary in notes:
                if summary.status == "entered-in-error":
                    continue
                note = (await notes_service.get(db, SqlEncounterRepository(),
                                                SqlNoteRepository(), check, user,
                                                summary.id)).value
                for section in note.sections:
                    text = " ".join(section.text.split())
                    if not text or section.ai_decision == "pending":
                        continue
                    lines.append(summary_lines.ChartLine(
                        f"Note, {section.title}: {text[:1500]}",
                        SourceRef("Composition", note.id), f"{note.title}, {section.title}"))
        return ddx.VisitChart(patient_id=visit.patient_id, visit=tuple(lines),
                              chart=await chart(db, user, visit.patient_id))

    return read


def visit_of(check: Annotated[rules.ChartCheck, Depends(chart_check)]) -> summaries.VisitOf:
    """The encounter's patient and reason for visit, as the user may read it (facility, D37)."""
    async def read(db: AsyncSession, user: CurrentUser, encounter_id: UUID
                   ) -> tuple[UUID, str | None]:
        found = await encounters_service.get(db, SqlEncounterRepository(), check, user,
                                             encounter_id)
        reasons = [chart_lines.label(r) for r in found.value.reasons or []]
        return found.value.patient_id, "; ".join(r for r in reasons if r) or None

    return read


def schedule_reader() -> summaries.SummaryReader:
    """The front desk's chart for a question: the patient's appointments only, through the
    scheduling service (facility scope, D37), never a reason for visit or a clinical record."""
    async def read(db: AsyncSession, user: CurrentUser, patient_id: UUID
                   ) -> summary_lines.SummaryChart:
        if not user.can("appointments:read"):
            return summary_lines.SummaryChart(unavailable=("appointments (no permission)",))
        found, _, _ = await scheduling_service.patient_history(
            db, scheduling_reference(), user, patient_id, date_from=None, date_to=None,
            limit=20, offset=0)
        return summary_lines.SummaryChart(lines=tuple(answers.schedule_lines(found)),
                                          unavailable=("clinical records (scheduling only)",))

    return read


def visit_patient(visits: Annotated[summaries.VisitOf, Depends(visit_of)]) -> Any:
    async def patient(db: AsyncSession, user: CurrentUser, encounter_id: UUID) -> UUID:
        found, _ = await visits(db, user, encounter_id)
        return found

    return patient


SummaryChartReader = Annotated[summaries.SummaryReader, Depends(summary_reader)]
ScheduleReader = Annotated[summaries.SummaryReader, Depends(schedule_reader)]
VisitPatient = Annotated[Any, Depends(visit_patient)]
VisitReader = Annotated[summaries.VisitOf, Depends(visit_of)]
IfMatch = Annotated[str | None, Header(alias="If-Match", max_length=128)]
DayReader = Annotated[briefs.DayReader, Depends(day_reader)]
DifferentialReader = Annotated[ddx.VisitReader, Depends(differential_reader)]


def _named(request: Request, audit: Any) -> rules.NamePatient:
    def name(patient_id: UUID) -> None:
        audit(request, [patient_id])
    return name


def _audit(request: Request, audit: Any, patients: Iterable[UUID]) -> None:
    audit(request, list(patients))


@router.post("/ai/note-drafts", operation_id="createNoteDraft", status_code=202,
             responses={202: {"description": "The operation (core's Operation)."}})
async def create_note_draft(
    user: Annotated[CurrentUser, Depends(require("note-drafts:create"))],
    body: NoteDraftCreate, request: Request, db: DB, repo: Repo, ai_model: Model,
    drafts: Drafts, texts: Texts, check: Check, audit: Audit, templates: Templates,
    chart: Chart,
) -> JSONResponse:
    """Idempotency-Key is optional (x-idempotency: supported): core claims and replays it."""
    gateway = Gateway(repo=repo, model=ai_model, drafts=drafts)
    operation = await rules.create_note_draft(db, gateway, drafts, texts, check, templates,
                                              chart, user, body, _named(request, audit))
    return accepted(operation)


@router.post("/ai/chart-summaries", operation_id="createChartSummary", status_code=202,
             responses={202: {"description": "The operation (core's Operation)."}})
async def create_chart_summary(
    user: Annotated[CurrentUser, Depends(require("chart-summaries:create"))],
    body: ChartSummaryCreate, request: Request, db: DB, repo: Repo, ai_model: Model,
    check: Check, audit: Audit, visits: VisitReader, chart: SummaryChartReader,
) -> JSONResponse:
    """Idempotency-Key is optional (x-idempotency: supported): core claims and replays it."""
    _audit(request, audit, [body.patient_id])
    operation = await summaries.create(db, repo, ai_model, check, visits, chart, user, body)
    return accepted(operation)


@router.get("/ai/chart-summaries/{chartSummaryId}", operation_id="getChartSummary",
            response_model=ChartSummary, response_model_exclude_none=True)
async def get_chart_summary(
    user: Annotated[CurrentUser, Depends(require("chart-summaries:read"))],
    summary_id: Annotated[UUID, Path(alias="chartSummaryId")], request: Request, db: DB,
    repo: Repo, check: Check, audit: Audit,
) -> ChartSummary:
    found = await summaries.get(db, repo, check, user, summary_id)
    _audit(request, audit, [found.patient_id])
    return found


@router.post("/ai/chart-questions", operation_id="createChartQuestion", status_code=202,
             responses={202: {"description": "The operation (core's Operation)."}})
async def create_chart_question(
    user: Annotated[CurrentUser, Depends(require("chart-questions:create"))],
    body: ChartQuestionCreate, request: Request, db: DB, repo: Repo, ai_model: Model,
    check: Check, audit: Audit, visit: VisitPatient, chart: SummaryChartReader,
    schedule: ScheduleReader,
) -> JSONResponse:
    """The question is never logged (chart_answers.py)."""
    _audit(request, audit, [body.patient_id])
    operation = await answers.create(db, repo, ai_model, check, visit, chart, schedule, user,
                                     body)
    return accepted(operation)


@router.get("/ai/chart-answers/{chartAnswerId}", operation_id="getChartAnswer",
            response_model=ChartAnswer, response_model_exclude_none=True)
async def get_chart_answer(
    user: Annotated[CurrentUser, Depends(require("chart-questions:create"))],
    answer_id: Annotated[UUID, Path(alias="chartAnswerId")], request: Request, db: DB,
    repo: Repo, check: Check, audit: Audit,
) -> ChartAnswer:
    found = await answers.get(db, repo, check, user, answer_id)
    _audit(request, audit, [found.patient_id])
    return found


@router.get("/ai/suggested-questions", operation_id="listSuggestedQuestions",
            response_model=SuggestedQuestionList)
async def list_suggested_questions(
    user: Annotated[CurrentUser, Depends(require("chart-questions:create"))],
    page_type: Annotated[PageType, Query(alias="pageType")],
) -> SuggestedQuestionList:
    """A fixed rule table (chart_answers.SUGGESTED): no model call, no patient data."""
    return answers.suggested(user, page_type)


@router.post("/ai/morning-briefs", operation_id="createMorningBrief", status_code=202,
             responses={202: {"description": "The operation (core's Operation)."}})
async def create_morning_brief(
    user: Annotated[CurrentUser, Depends(require("chart-summaries:create"))],
    body: MorningBriefCreate, request: Request, db: DB, repo: Repo, ai_model: Model,
    check: Check, audit: Audit, day: DayReader, chart: SummaryChartReader,
) -> JSONResponse:
    """Every chart read is audited; a restricted one the user may not open is never read."""
    operation = await briefs.create(db, repo, ai_model, check, day, chart, user, body,
                                    lambda ids: _audit(request, audit, ids))
    return accepted(operation)


@router.get("/ai/morning-briefs/{morningBriefId}", operation_id="getMorningBrief",
            response_model=MorningBrief, response_model_exclude_none=True)
async def get_morning_brief(
    user: Annotated[CurrentUser, Depends(require("chart-summaries:read"))],
    brief_id: Annotated[UUID, Path(alias="morningBriefId")], request: Request, db: DB,
    repo: Repo, check: Check, audit: Audit,
) -> MorningBrief:
    found = await briefs.get(db, repo, check, user, brief_id)
    _audit(request, audit, briefs.readable_patients(found))
    return found


@router.post("/ai/differentials", operation_id="createDifferential", status_code=202,
             responses={202: {"description": "The operation (core's Operation)."}})
async def create_differential(
    user: Annotated[CurrentUser, Depends(require("chart-summaries:create"))],
    body: DifferentialCreate, request: Request, db: DB, repo: Repo, ai_model: Model,
    audit: Audit, visit: DifferentialReader,
) -> JSONResponse:
    operation = await ddx.create(db, repo, ai_model, visit, user, body,
                                 lambda ids: _audit(request, audit, ids))
    return accepted(operation)


@router.get("/ai/differentials/{differentialId}", operation_id="getDifferential",
            response_model=Differential, response_model_exclude_none=True)
async def get_differential(
    user: Annotated[CurrentUser, Depends(require("chart-summaries:read"))],
    differential_id: Annotated[UUID, Path(alias="differentialId")], request: Request,
    db: DB, repo: Repo, check: Check, audit: Audit,
) -> Differential:
    found = await ddx.get(db, repo, check, user, differential_id)
    _audit(request, audit, [found.patient_id])
    return found


@router.post("/ai/suggestions/{suggestionId}/decision", operation_id="decideAiSuggestion",
             response_model=AiSuggestion, response_model_exclude_none=True)
async def decide_ai_suggestion(
    user: Annotated[CurrentUser, Depends(require("ai-suggestions:decision"))],
    suggestion_id: Annotated[UUID, Path(alias="suggestionId")], body: AiSuggestionDecision,
    request: Request, db: DB, repo: Repo, drafts: Drafts, check: Check, audit: Audit,
) -> AiSuggestion:
    return await rules.decide(db, repo, drafts, check, user, suggestion_id, body,
                              _named(request, audit))


@router.get("/ai/transcriptions/{transcriptionId}", operation_id="getTranscription",
            response_model=Transcription, response_model_exclude_none=True)
async def get_transcription(
    user: Annotated[CurrentUser, Depends(require("transcriptions:read"))],
    transcription_id: Annotated[UUID, Path(alias="transcriptionId")], request: Request,
    db: DB, texts: Texts, encounter: Readable, check: Check, audit: Audit,
) -> Transcription:
    found = await rules.get_transcription(db, texts, encounter, check, user, transcription_id)
    _audit(request, audit, [found.patient_id])
    return found


@router.get("/ai-settings", operation_id="getAiSettings", response_model=AiSettings,
            response_model_exclude_none=True)
async def get_ai_settings(
    user: Annotated[CurrentUser, Depends(require("ai-settings:read"))],
    response: Response, db: DB, repo: Repo,
) -> AiSettings:
    found, tag = await ai_settings.get(db, repo)
    response.headers["ETag"] = tag
    return found


@router.put("/ai-settings", operation_id="replaceAiSettings", response_model=AiSettings,
            response_model_exclude_none=True)
async def replace_ai_settings(
    user: Annotated[CurrentUser, Depends(require("ai-settings:update"))],
    body: AiSettingsUpdate, response: Response, db: DB, repo: Repo, if_match: IfMatch = None,
) -> AiSettings:
    saved, tag = await ai_settings.replace(db, repo, body, if_match)
    response.headers["ETag"] = tag
    return saved
