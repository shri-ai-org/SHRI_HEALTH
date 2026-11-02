"""Encounter diagnoses API (inventory #71-72; contracts/openapi/modules/encounters.yaml). Each
route's operation_id is the contract's operationId; the permission (`require`) is the first
dependency. Every route runs the facility and restricted-chart checks first (D37), and names the
patient for core's audit (x-audit patient "result") before the commit.

markDiagnosisEnteredInError (#73) is not built yet: see diagnoses_service.py.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Request, Response, status

from app.core.deps import CurrentUser, require

from . import diagnoses_schemas as dschemas
from . import diagnoses_service as dservice
from . import schemas, service
from .api import DB, Audit, Check, EncounterId, Repo, Store
from .diagnoses_repository import DiagnosisRepository, SqlDiagnosisRepository

router: APIRouter = APIRouter(tags=["encounters"])

DIAGNOSES = "/encounters/{encounterId}/diagnoses"
DIAGNOSIS = DIAGNOSES + "/{diagnosisId}"


def diagnosis_repository() -> DiagnosisRepository:
    return SqlDiagnosisRepository()


DRepo = Annotated[DiagnosisRepository, Depends(diagnosis_repository)]
DiagnosisId = Annotated[UUID, Path(alias="diagnosisId")]


@router.post(DIAGNOSES, operation_id="addEncounterDiagnosis",
             status_code=status.HTTP_201_CREATED, response_model=schemas.EncounterDiagnosis,
             response_model_exclude_none=True)
async def add_encounter_diagnosis(
    user: Annotated[CurrentUser, Depends(require("diagnoses:create"))],
    encounter_id: EncounterId, body: dschemas.DiagnosisCreate, request: Request,
    response: Response, db: DB, repo: Repo, drepo: DRepo, store: Store, check: Check,
    audit: Audit,
) -> schemas.EncounterDiagnosis:
    """Idempotency-Key is optional (x-idempotency: supported): core claims and replays it."""
    added = await dservice.add(db, repo, drepo, store, check, user, encounter_id, body,
                               lambda patient_id: audit(request, [patient_id]))
    response.headers["ETag"] = service.etag(added.version)
    response.headers["Location"] = (
        f"/api/v1/encounters/{encounter_id}/diagnoses/{added.value.id}")
    return added.value


@router.post(DIAGNOSIS + "/remove", operation_id="removeEncounterDiagnosis",
             response_model=schemas.EncounterDiagnosis, response_model_exclude_none=True)
async def remove_encounter_diagnosis(
    user: Annotated[CurrentUser, Depends(require("diagnoses:remove"))],
    encounter_id: EncounterId, diagnosis_id: DiagnosisId, body: dschemas.DiagnosisRemove,
    request: Request, response: Response, db: DB, repo: Repo, drepo: DRepo, store: Store,
    check: Check, audit: Audit,
) -> schemas.EncounterDiagnosis:
    removed = await dservice.remove(db, repo, drepo, store, check, user, encounter_id,
                                    diagnosis_id, body.reason,
                                    lambda patient_id: audit(request, [patient_id]))
    response.headers["ETag"] = service.etag(removed.version)
    return removed.value
