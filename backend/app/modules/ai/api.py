"""AI API, batch 7 (contracts/openapi/modules/ai.yaml): AI-01's note drafts, the decision on an AI
suggestion, transcripts and the clinic's AI settings. Each route's operation_id is the contract's
operationId; the permission (``require``) is the first dependency. Routes that touch a chart run
the facility and restricted-chart checks (D37) and name the patient for core's audit (x-audit
patient ``result``): category ``ai`` for the draft and the decision, ``phi-read`` for the
transcript, ``admin`` for the settings.

Not mounted yet (see the module's report): createEncounterAudio and createTranscription (no
speech service, no upload rule for ``encounter-audio`` and no server-generated file purpose for
transcripts), createChartSummary and getChartSummary (AI-02: the delegated token is core's).

The pieces from other owners are FastAPI dependencies, so the tests can replace them: the model
(config.py), the file service's store and crypto (Anand's), core's chart check and audit hook,
and the note template (practice setup's repository, Anand's).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Path, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core import audit as core_audit
from app.core.deps import CurrentUser, require, tenant_db
from app.core.long_running import accepted
from app.modules.encounters import service as encounters_service
from app.modules.encounters.ai_drafts import EncounterNoteDrafts
from app.modules.encounters.repository import EncounterHead, SqlEncounterRepository
from app.modules.encounters.service import readable
from app.modules.files.crypto import FileCrypto, file_crypto
from app.modules.files.storage import FileStore, file_store
from app.modules.history import service as history_service
from app.modules.history.repository import SqlAllergyRepository
from app.modules.medications import service as medications_service
from app.modules.medications.repository import SqlMedicationRepository
from app.modules.practice_setup.repository import SqlSetupRepository

from . import chart_context as chart_lines
from . import drafts as rules
from . import settings as ai_settings
from .config import configured_model
from .model_client import ModelClient
from .repository import AIRepository, SqlAIRepository
from .schemas import (
    AiSettings,
    AiSettingsUpdate,
    AiSuggestion,
    AiSuggestionDecision,
    NoteDraftCreate,
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
IfMatch = Annotated[str | None, Header(alias="If-Match", max_length=128)]


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
