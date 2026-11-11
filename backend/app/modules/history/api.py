"""Patient history API (batch 2, contracts/openapi/modules/history.yaml). Each route's operation_id
is the contract's operationId; the permission (`require`) is the first dependency.

Built so far: the allergies (inventory #94-97, #250), which MA and RN record at rooming (demo step
7), and the reads of problems, family, social and surgical history (#90, #249, #98, #101, #104),
which the doctor's record screen shows (demo steps 7-9). Every route runs the restricted-chart
check first (D37). Their x-audit takes the patient from the path, so core names it without help
from the endpoint.

The pieces from other owners are FastAPI dependencies, so the tests can replace them: the
repository, Anand's write helpers, core's chart check, and the patients module's merged-chart
check.
"""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Path, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core.deps import CurrentUser, require, tenant_db
from app.db.fhir_store import FhirStore, SqlFhirStore

from ..patients import service as patients
from . import schemas, service
from .repository import (
    AllergyRepository,
    HistoryRepository,
    SqlAllergyRepository,
    SqlHistoryRepository,
)

router = APIRouter(tags=["history"])

ALLERGIES = "/patients/{patientId}/allergies"
ALLERGY = ALLERGIES + "/{allergyId}"


def repository() -> AllergyRepository:
    return SqlAllergyRepository()


def history_repository() -> HistoryRepository:
    return SqlHistoryRepository()


def fhir_store() -> FhirStore:
    return SqlFhirStore()


def chart_check() -> service.ChartCheck:
    """Core's restricted-chart check (D37; 404 unknown patient, 403 break-glass-required)."""
    return core_access.ensure_chart_access


def writable_patient() -> service.WritablePatient:
    """The patients module's check for a new record: 409 patient-merged (D103)."""
    return patients.ensure_writable


DB = Annotated[AsyncSession, Depends(tenant_db)]
Repo = Annotated[AllergyRepository, Depends(repository)]
History = Annotated[HistoryRepository, Depends(history_repository)]
Store = Annotated[FhirStore, Depends(fhir_store)]
Check = Annotated[service.ChartCheck, Depends(chart_check)]
Writable = Annotated[service.WritablePatient, Depends(writable_patient)]
PatientId = Annotated[UUID, Path(alias="patientId")]
AllergyId = Annotated[UUID, Path(alias="allergyId")]
ProblemId = Annotated[UUID, Path(alias="problemId")]
IncludeEnteredInError = Annotated[bool, Query(alias="includeEnteredInError")]
IfMatch = Annotated[str | None, Header(alias="If-Match", max_length=128)]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


def _today() -> datetime:
    return datetime.now(UTC)


@router.get(ALLERGIES, operation_id="listAllergies", response_model=schemas.AllergyList,
            response_model_exclude_none=True)
async def list_allergies(
    user: Annotated[CurrentUser, Depends(require("allergies:read"))],
    patient_id: PatientId, db: DB, repo: Repo, check: Check,
    include_entered_in_error: Annotated[bool, Query(alias="includeEnteredInError")] = False,
    limit: Limit = 25, cursor: Cursor = None,
) -> schemas.AllergyList:
    items, next_cursor = await service.list_allergies(
        db, repo, check, user, patient_id, include_entered_in_error=include_entered_in_error,
        limit=limit, cursor=cursor)
    return schemas.AllergyList(items=items, next_cursor=next_cursor)


@router.post(ALLERGIES, operation_id="addAllergy", status_code=status.HTTP_201_CREATED,
             response_model=schemas.Allergy, response_model_exclude_none=True)
async def add_allergy(
    user: Annotated[CurrentUser, Depends(require("allergies:create"))],
    patient_id: PatientId, body: schemas.AllergyCreate, response: Response, db: DB,
    repo: Repo, store: Store, check: Check, writable: Writable,
) -> schemas.Allergy:
    """Idempotency-Key is optional (x-idempotency: supported): core claims and replays it."""
    created = await service.add_allergy(db, repo, store, check, writable, user, patient_id,
                                        body, _today().date())
    response.headers["ETag"] = service.etag(created.version)
    response.headers["Location"] = f"/api/v1/patients/{patient_id}/allergies/{created.value.id}"
    return created.value


@router.get(ALLERGY, operation_id="getAllergy", response_model=schemas.Allergy,
            response_model_exclude_none=True)
async def get_allergy(
    user: Annotated[CurrentUser, Depends(require("allergies:read"))],
    patient_id: PatientId, allergy_id: AllergyId, response: Response, db: DB, repo: Repo,
    check: Check,
) -> schemas.Allergy:
    found = await service.get_allergy(db, repo, check, user, patient_id, allergy_id)
    response.headers["ETag"] = service.etag(found.version)
    return found.value


@router.patch(ALLERGY, operation_id="updateAllergy", response_model=schemas.Allergy,
              response_model_exclude_none=True)
async def update_allergy(
    user: Annotated[CurrentUser, Depends(require("allergies:update"))],
    patient_id: PatientId, allergy_id: AllergyId, body: schemas.AllergyPatch,
    response: Response, db: DB, repo: Repo, store: Store, check: Check,
    if_match: IfMatch = None,
) -> schemas.Allergy:
    updated = await service.update_allergy(db, repo, store, check, user, patient_id,
                                           allergy_id, body, if_match, _today().date())
    response.headers["ETag"] = service.etag(updated.version)
    return updated.value


@router.post(ALLERGY + "/entered-in-error", operation_id="markAllergyEnteredInError",
             response_model=schemas.Allergy, response_model_exclude_none=True)
async def mark_allergy_entered_in_error(
    user: Annotated[CurrentUser, Depends(require("allergies:entered-in-error"))],
    patient_id: PatientId, allergy_id: AllergyId, body: schemas.EnteredInError,
    response: Response, db: DB, repo: Repo, store: Store, check: Check,
) -> schemas.Allergy:
    marked = await service.mark_entered_in_error(db, repo, store, check, user, patient_id,
                                                 allergy_id, body.reason)
    response.headers["ETag"] = service.etag(marked.version)
    return marked.value


# ------------------------------------------------------------------ problems and history (reads)
PROBLEMS = "/patients/{patientId}/problems"


@router.get(PROBLEMS, operation_id="listProblems", response_model=schemas.ProblemList,
            response_model_exclude_none=True)
async def list_problems(
    user: Annotated[CurrentUser, Depends(require("problems:read"))],
    patient_id: PatientId, db: DB, history: History, check: Check,
    include_entered_in_error: IncludeEnteredInError = False, limit: Limit = 25,
    cursor: Cursor = None,
) -> schemas.ProblemList:
    items, next_cursor = await service.page(
        db, check, user, patient_id, history.problems,
        include_entered_in_error=include_entered_in_error, limit=limit, cursor=cursor)
    return schemas.ProblemList(items=items, next_cursor=next_cursor)


@router.get(PROBLEMS + "/{problemId}", operation_id="getProblem", response_model=schemas.Problem,
            response_model_exclude_none=True)
async def get_problem(
    user: Annotated[CurrentUser, Depends(require("problems:read"))],
    patient_id: PatientId, problem_id: ProblemId, response: Response, db: DB, history: History,
    check: Check,
) -> schemas.Problem:
    found = await service.get_problem(db, history, check, user, patient_id, problem_id)
    response.headers["ETag"] = service.etag(found.version)
    return found.value


@router.get("/patients/{patientId}/family-history", operation_id="listFamilyHistory",
            response_model=schemas.FamilyHistoryList, response_model_exclude_none=True)
async def list_family_history(
    user: Annotated[CurrentUser, Depends(require("family-history:read"))],
    patient_id: PatientId, db: DB, history: History, check: Check,
    include_entered_in_error: IncludeEnteredInError = False, limit: Limit = 25,
    cursor: Cursor = None,
) -> schemas.FamilyHistoryList:
    items, next_cursor = await service.page(
        db, check, user, patient_id, history.family_history,
        include_entered_in_error=include_entered_in_error, limit=limit, cursor=cursor)
    return schemas.FamilyHistoryList(items=items, next_cursor=next_cursor)


@router.get("/patients/{patientId}/social-history", operation_id="listSocialHistory",
            response_model=schemas.SocialHistoryList, response_model_exclude_none=True)
async def list_social_history(
    user: Annotated[CurrentUser, Depends(require("social-history:read"))],
    patient_id: PatientId, db: DB, history: History, check: Check,
    include_entered_in_error: IncludeEnteredInError = False, limit: Limit = 25,
    cursor: Cursor = None,
) -> schemas.SocialHistoryList:
    items, next_cursor = await service.page(
        db, check, user, patient_id, history.social_history,
        include_entered_in_error=include_entered_in_error, limit=limit, cursor=cursor)
    return schemas.SocialHistoryList(items=items, next_cursor=next_cursor)


@router.get("/patients/{patientId}/surgical-history", operation_id="listSurgicalHistory",
            response_model=schemas.SurgicalHistoryList, response_model_exclude_none=True)
async def list_surgical_history(
    user: Annotated[CurrentUser, Depends(require("surgical-history:read"))],
    patient_id: PatientId, db: DB, history: History, check: Check,
    include_entered_in_error: IncludeEnteredInError = False, limit: Limit = 25,
    cursor: Cursor = None,
) -> schemas.SurgicalHistoryList:
    items, next_cursor = await service.page(
        db, check, user, patient_id, history.surgical_history,
        include_entered_in_error=include_entered_in_error, limit=limit, cursor=cursor)
    return schemas.SurgicalHistoryList(items=items, next_cursor=next_cursor)
