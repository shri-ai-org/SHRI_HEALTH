"""Patients and insurance API (batch 1, contracts/openapi/modules/patients.yaml). Routes are added
PR by PR, following contracts/docs/IMPL_BATCH1_PLAN.md; each route's operation_id is the
contract's operationId.

PR-1: search, register, read, update, summaries, restrict and unrestrict, identifiers and related
persons. Every route that touches one chart runs the restricted-chart check first (D37), and patient
data never reaches a response without it. Operations whose x-audit names the patient from the result
or the body hand those patients to core's audit hook (#79) before they commit or return.
The permission (`require`) is the first dependency, so a caller without it gets 401 or 403 before
anything else is resolved.
"""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, require, tenant_db

from . import schemas, service
from .access import AuditHooks, ChartCheck, audit_hooks, chart_check, fhir_store
from .repository import PatientRepository, SqlPatientRepository, Versioned
from .store import FhirStore

router = APIRouter(tags=["patients"])

PATIENT = "/patients/{patientId}"


def repository() -> PatientRepository:
    return SqlPatientRepository()


Repo = Annotated[PatientRepository, Depends(repository)]
Store = Annotated[FhirStore, Depends(fhir_store)]
Check = Annotated[ChartCheck, Depends(chart_check)]
DB = Annotated[AsyncSession, Depends(tenant_db)]
PatientId = Annotated[UUID, Path(alias="patientId")]
RelatedPersonId = Annotated[UUID, Path(alias="relatedPersonId")]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]
IfMatch = Annotated[str | None, Header(alias="If-Match")]
Audit = Annotated[AuditHooks, Depends(audit_hooks)]


async def _chart(db: AsyncSession, repo: PatientRepository, check: ChartCheck, user: CurrentUser,
                 patient_id: UUID) -> Versioned[schemas.Patient]:
    """404 for a patient the clinic can't see, then 403 break-glass-required for a restricted
    chart without a grant or care-team membership."""
    found = await service.readable_patient(db, repo, patient_id)
    await check(db, user, patient_id)
    return found


@router.post("/patients/search", operation_id="searchPatients",
             response_model=schemas.PatientSummaryList, response_model_exclude_none=True)
async def search_patients(
    user: Annotated[CurrentUser, Depends(require("patients:search"))],
    body: schemas.PatientSearchRequest, request: Request, db: DB, repo: Repo, audit: Audit,
) -> schemas.PatientSummaryList:
    service.check_search_criteria(body.criteria)
    offset = service.decode_cursor(body.cursor)
    found = await repo.search(db, body.criteria, limit=body.limit + 1, offset=offset)
    items, next_cursor = service.page(found, body.limit, offset)
    audit.patients(request, [i.id for i in items])  # x-audit patient "result"
    return schemas.PatientSummaryList(items=items, next_cursor=next_cursor)


@router.post("/patients", operation_id="registerPatient", status_code=status.HTTP_201_CREATED,
             response_model=schemas.Patient, response_model_exclude_none=True)
async def register_patient(
    user: Annotated[CurrentUser, Depends(require("patients:create"))],
    body: schemas.PatientCreate, request: Request, response: Response, db: DB, repo: Repo,
    store: Store, audit: Audit,
) -> schemas.Patient:
    if body.duplicate_check == "override" and body.duplicate_override_reason:
        audit.detail(request, "create", body.duplicate_override_reason)  # the override's reason
    created = await service.register(
        db, repo, store, body, today=datetime.now(UTC).date(),
        name_patient=lambda patient_id: audit.patients(request, [patient_id]))
    response.headers["ETag"] = service.etag(created.version)
    response.headers["Location"] = f"/api/v1/patients/{created.value.id}"
    return created.value


@router.get(PATIENT, operation_id="getPatient", response_model=schemas.Patient,
            response_model_exclude_none=True)
async def get_patient(
    user: Annotated[CurrentUser, Depends(require("patients:read"))],
    patient_id: PatientId, response: Response, db: DB, repo: Repo, check: Check,
) -> schemas.Patient:
    found = await _chart(db, repo, check, user, patient_id)
    response.headers["ETag"] = service.etag(found.version)
    return found.value


@router.patch(PATIENT, operation_id="updatePatient", response_model=schemas.Patient,
              response_model_exclude_none=True)
async def update_patient(
    user: Annotated[CurrentUser, Depends(require("patients:update"))],
    patient_id: PatientId, body: schemas.PatientPatch, response: Response, db: DB, repo: Repo,
    store: Store, check: Check, if_match: IfMatch = None,
) -> schemas.Patient:
    current = await _chart(db, repo, check, user, patient_id)
    updated = await service.update_patient(db, repo, store, current.value, body, if_match)
    response.headers["ETag"] = service.etag(updated.version)
    return updated.value


@router.post("/patients/summaries", operation_id="getPatientSummaries",
             response_model=schemas.PatientSummaryBatch, response_model_exclude_none=True)
async def get_patient_summaries(
    user: Annotated[CurrentUser, Depends(require("patients:read"))],
    body: schemas.PatientSummariesRequest, request: Request, db: DB, repo: Repo, audit: Audit,
) -> schemas.PatientSummaryBatch:
    items = await service.summaries(db, repo, body.patient_ids)
    audit.patients(request, [i.id for i in items])  # x-audit patient "body:/patientIds"
    return schemas.PatientSummaryBatch(items=items)


@router.post(f"{PATIENT}/restrict", operation_id="restrictPatient",
             response_model=schemas.PatientRestriction, response_model_exclude_none=True)
async def restrict_patient(
    user: Annotated[CurrentUser, Depends(require("patients:restrict"))],
    patient_id: PatientId, body: schemas.RestrictRequest, request: Request, db: DB, repo: Repo,
    store: Store, audit: Audit,
) -> schemas.PatientRestriction:
    patient = await service.readable_patient(db, repo, patient_id)
    audit.detail(request, "update", body.reason)  # the reason lives in the audit trail only
    return await service.set_restriction(db, store, patient.value, body.category)


@router.post(f"{PATIENT}/unrestrict", operation_id="unrestrictPatient",
             response_model=schemas.PatientRestriction, response_model_exclude_none=True)
async def unrestrict_patient(
    user: Annotated[CurrentUser, Depends(require("patients:restrict"))],
    patient_id: PatientId, body: schemas.UnrestrictRequest, request: Request, db: DB, repo: Repo,
    store: Store, audit: Audit,
) -> schemas.PatientRestriction:
    patient = await service.readable_patient(db, repo, patient_id)
    audit.detail(request, "update", body.reason)
    return await service.set_restriction(db, store, patient.value, None)


@router.get(f"{PATIENT}/identifiers", operation_id="listPatientIdentifiers",
            response_model=schemas.PatientIdentifierList, response_model_exclude_none=True)
async def list_patient_identifiers(
    user: Annotated[CurrentUser, Depends(require("patients:read"))],
    patient_id: PatientId, db: DB, repo: Repo, check: Check, limit: Limit = 50,
    cursor: Cursor = None,
) -> schemas.PatientIdentifierList:
    await _chart(db, repo, check, user, patient_id)
    offset = service.decode_cursor(cursor)
    found = await repo.list_identifiers(db, patient_id, limit=limit + 1, offset=offset)
    items, next_cursor = service.page(found, limit, offset)
    return schemas.PatientIdentifierList(items=items, next_cursor=next_cursor)


@router.post(f"{PATIENT}/identifiers", operation_id="addPatientIdentifier",
             status_code=status.HTTP_201_CREATED, response_model=schemas.PatientIdentifier,
             response_model_exclude_none=True)
async def add_patient_identifier(
    user: Annotated[CurrentUser, Depends(require("patients:update"))],
    patient_id: PatientId, body: schemas.PatientIdentifierCreate, response: Response, db: DB,
    repo: Repo, store: Store, check: Check,
) -> schemas.PatientIdentifier:
    patient = await _chart(db, repo, check, user, patient_id)
    added = await service.add_identifier(db, repo, store, patient.value, body)
    response.headers["Location"] = f"/api/v1/patients/{patient_id}/identifiers"
    return added


@router.get(f"{PATIENT}/related-persons", operation_id="listRelatedPersons",
            response_model=schemas.RelatedPersonList, response_model_exclude_none=True)
async def list_related_persons(
    user: Annotated[CurrentUser, Depends(require("patients:read"))],
    patient_id: PatientId, db: DB, repo: Repo, check: Check, limit: Limit = 50,
    cursor: Cursor = None,
) -> schemas.RelatedPersonList:
    await _chart(db, repo, check, user, patient_id)
    offset = service.decode_cursor(cursor)
    found = await repo.list_related(db, patient_id, limit=limit + 1, offset=offset)
    items, next_cursor = service.page(found, limit, offset)
    return schemas.RelatedPersonList(items=items, next_cursor=next_cursor)


@router.post(f"{PATIENT}/related-persons", operation_id="addRelatedPerson",
             status_code=status.HTTP_201_CREATED, response_model=schemas.RelatedPerson,
             response_model_exclude_none=True)
async def add_related_person(
    user: Annotated[CurrentUser, Depends(require("patients:update"))],
    patient_id: PatientId, body: schemas.RelatedPersonCreate, response: Response, db: DB,
    repo: Repo, store: Store, check: Check,
) -> schemas.RelatedPerson:
    patient = await _chart(db, repo, check, user, patient_id)
    created = await service.add_related(db, repo, store, patient.value, body)
    response.headers["ETag"] = service.etag(created.version)
    response.headers["Location"] = (
        f"/api/v1/patients/{patient_id}/related-persons/{created.value.id}")
    return created.value


@router.patch(f"{PATIENT}/related-persons/{{relatedPersonId}}",
              operation_id="updateRelatedPerson", response_model=schemas.RelatedPerson,
              response_model_exclude_none=True)
async def update_related_person(
    user: Annotated[CurrentUser, Depends(require("patients:update"))],
    patient_id: PatientId, related_person_id: RelatedPersonId, body: schemas.RelatedPersonPatch,
    response: Response, db: DB, repo: Repo, store: Store, check: Check, if_match: IfMatch = None,
) -> schemas.RelatedPerson:
    patient = await _chart(db, repo, check, user, patient_id)
    updated = await service.update_related(db, repo, store, patient.value, related_person_id,
                                           body, if_match)
    response.headers["ETag"] = service.etag(updated.version)
    return updated.value
