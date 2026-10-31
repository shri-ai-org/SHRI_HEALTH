"""Encounters and vitals API (batch 2, contracts/openapi/modules/encounters.yaml). Each route's
operation_id is the contract's operationId; the permission (`require`) is the first dependency.

Rooming (demo step 7, IMPL_BATCH1_PLAN §8.3 PR-5): the workspace read and its edit (the reason for
visit, with If-Match), recording vitals and the patient's vitals list. Check-in uses this module's
service only (D16). Every route that touches a chart runs the restricted-chart check first (D37).
Operations whose x-audit takes the patient from the result hand it to core's audit hook.

The pieces from other owners are FastAPI dependencies, so the tests can replace them: the
repository, Anand's write helpers, core's chart check and audit hook, and the facility's rooms
(practice setup, read through scheduling's seam until Anand's read service lands).
"""

from collections.abc import Awaitable, Callable, Iterable
from datetime import UTC, date, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core import audit as core_audit
from app.core.deps import CurrentUser, require, tenant_db
from app.db.fhir_store import FhirStore, SqlFhirStore

from ..scheduling.reference import reference
from . import schemas, service
from .repository import EncounterRepository, SqlEncounterRepository

router = APIRouter(tags=["encounters"])

ENCOUNTER = "/encounters/{encounterId}"
AuditPatients = Callable[[Request, Iterable[UUID]], None]


def repository() -> EncounterRepository:
    return SqlEncounterRepository()


def fhir_store() -> FhirStore:
    return SqlFhirStore()


def chart_check() -> service.ChartCheck:
    """Core's restricted-chart check (D37; 404 unknown patient, 403 break-glass-required)."""
    return core_access.ensure_chart_access


def audit_patients() -> AuditPatients:
    """Core's hook naming the patients of an operation whose x-audit patient is "result"."""
    return core_audit.audit_patients


def facility_rooms() -> service.Rooms:
    """The rooms and other locations of a facility (practice setup)."""
    ref = reference()

    async def rooms(db: AsyncSession, facility_id: UUID) -> set[UUID]:
        return {loc.id for loc in await ref.locations(db, [facility_id])}

    return rooms


DB = Annotated[AsyncSession, Depends(tenant_db)]
Repo = Annotated[EncounterRepository, Depends(repository)]
Store = Annotated[FhirStore, Depends(fhir_store)]
Check = Annotated[service.ChartCheck, Depends(chart_check)]
Audit = Annotated[AuditPatients, Depends(audit_patients)]
Rooms = Annotated[Callable[[AsyncSession, UUID], Awaitable[set[UUID]]], Depends(facility_rooms)]
EncounterId = Annotated[UUID, Path(alias="encounterId")]
PatientId = Annotated[UUID, Path(alias="patientId")]
IfMatch = Annotated[str | None, Header(alias="If-Match", max_length=128)]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


def _now() -> datetime:
    return datetime.now(UTC)


@router.get(ENCOUNTER, operation_id="getEncounter", response_model=schemas.Encounter,
            response_model_exclude_none=True)
async def get_encounter(
    user: Annotated[CurrentUser, Depends(require("encounters:read"))],
    encounter_id: EncounterId, request: Request, response: Response, db: DB, repo: Repo,
    check: Check, audit: Audit,
) -> schemas.Encounter:
    found = await service.get(db, repo, check, user, encounter_id)
    audit(request, [found.value.patient_id])  # x-audit patient "result"
    response.headers["ETag"] = service.etag(found.version)
    return found.value


@router.patch(ENCOUNTER, operation_id="updateEncounter", response_model=schemas.Encounter,
              response_model_exclude_none=True)
async def update_encounter(
    user: Annotated[CurrentUser, Depends(require("encounters:update"))],
    encounter_id: EncounterId, body: schemas.EncounterPatch, request: Request,
    response: Response, db: DB, repo: Repo, check: Check, audit: Audit, rooms: Rooms,
    if_match: IfMatch = None,
) -> schemas.Encounter:
    updated = await service.update(  # x-audit patient "result": named before the commit
        db, repo, check, rooms, user, encounter_id, body, if_match,
        lambda patient_id: audit(request, [patient_id]))
    response.headers["ETag"] = service.etag(updated.version)
    return updated.value


@router.post(ENCOUNTER + "/vitals", operation_id="recordVitals",
             status_code=status.HTTP_201_CREATED, response_model=schemas.VitalsRecorded,
             response_model_exclude_none=True)
async def record_vitals(
    user: Annotated[CurrentUser, Depends(require("vitals:create"))],
    encounter_id: EncounterId, body: schemas.VitalsCreate, request: Request, db: DB,
    repo: Repo, store: Store, check: Check, audit: Audit,
) -> schemas.VitalsRecorded:
    """Idempotency-Key is optional (x-idempotency: supported): core claims and replays it."""
    vitals = await service.record_vitals(  # x-audit patient "result": named before the commit
        db, repo, store, check, user, encounter_id, body, _now(),
        lambda patient_id: audit(request, [patient_id]))
    return schemas.VitalsRecorded(vitals=vitals)


@router.get("/patients/{patientId}/vitals", operation_id="listPatientVitals",
            response_model=schemas.VitalList, response_model_exclude_none=True)
async def list_patient_vitals(
    user: Annotated[CurrentUser, Depends(require("vitals:read"))],
    patient_id: PatientId, db: DB, repo: Repo, check: Check,
    vital_type: Annotated[schemas.VitalType | None, Query(alias="type")] = None,
    date_from: Annotated[date | None, Query(alias="dateFrom")] = None,
    date_to: Annotated[date | None, Query(alias="dateTo")] = None,
    include_entered_in_error: Annotated[bool, Query(alias="includeEnteredInError")] = False,
    limit: Limit = 25, cursor: Cursor = None,
) -> schemas.VitalList:
    items, next_cursor = await service.list_vitals(
        db, repo, check, user, patient_id, vital_type=vital_type, date_from=date_from,
        date_to=date_to, include_entered_in_error=include_entered_in_error, limit=limit,
        cursor=cursor)
    return schemas.VitalList(items=items, next_cursor=next_cursor)


# Diagnoses live in their own files (diagnoses_api.py).
from . import diagnoses_api  # noqa: E402

router.include_router(diagnoses_api.router)
