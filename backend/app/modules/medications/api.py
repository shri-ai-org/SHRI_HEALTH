"""Medication list and prescriptions API (contracts/openapi/modules/medications.yaml; D28, D97,
D99). Built by Vimal under D97, reviewed by Thulasi as the medications owner. Each route's
operation_id is the contract's operationId, and the permission (`require`) is the first
dependency, so a caller without it gets 401 or 403 before anything else runs.

- ``listMedications``, ``recordMedication``: the list (reported at rooming, or prescribed here).
- ``createPrescription``, ``getPrescription``, ``updatePrescription`` (If-Match),
  ``markPrescriptionEnteredInError``: drafts.
- ``checkPrescriptionSafety``, ``overrideAlert``: the fixed rules (D99) and their overrides.
- ``signAndSendPrescription`` (If-Match and the required Idempotency-Key, which core's tenant_db
  claims): the signature and the NewRx in the outbox, in one transaction.

Every route runs the restricted-chart check (D37) before it shows or changes anything, and names
the patient for core's audit where x-audit takes it from the result or the body. The repository,
the chart check, the audit hook and the partner (outbox and events) are dependencies the tests
replace. Not built: listPharmacies (batch 1, Thulasi's, D50), discontinue, reconciliation, cancel,
change, refills and outside history (after the demo; not in this contract yet, or Q13).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core import audit as core_audit
from app.core.deps import CurrentUser, require, tenant_db

from . import schemas, service
from .partner import Partner, partner
from .repository import MedicationRepository, PrescriptionRow, SqlMedicationRepository

router = APIRouter(tags=["medications"])

AuditPatients = Callable[[Request, Iterable[UUID]], None]
API = "/api/v1"
PRESCRIPTION = "/prescriptions/{prescriptionId}"


def repository() -> MedicationRepository:
    return SqlMedicationRepository()


def chart_check() -> service.ChartCheck:
    """FastAPI dependency: core's restricted-chart check (404, or 403 break-glass-required)."""
    return core_access.ensure_chart_access


def audit_hook() -> AuditPatients:
    """FastAPI dependency: core's audit hook naming the patients (x-audit patient "result" or
    "body:/patientId")."""
    return core_audit.audit_patients


DB = Annotated[AsyncSession, Depends(tenant_db)]
Repo = Annotated[MedicationRepository, Depends(repository)]
Check = Annotated[service.ChartCheck, Depends(chart_check)]
Audit = Annotated[AuditPatients, Depends(audit_hook)]
Outbox = Annotated[Partner, Depends(partner)]
PatientId = Annotated[UUID, Path(alias="patientId")]
PrescriptionId = Annotated[UUID, Path(alias="prescriptionId")]
AlertId = Annotated[UUID, Path(alias="alertId")]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]
IfMatch = Annotated[str | None, Header(alias="If-Match")]


def _prescription(response: Response, row: PrescriptionRow) -> schemas.Prescription:
    response.headers["ETag"] = service.etag(row.version)
    return service.to_prescription(row)


# ------------------------------------------------------------------------------ the list
@router.get("/patients/{patientId}/medications", operation_id="listMedications",
            response_model=schemas.MedicationList, response_model_exclude_none=True)
async def list_medications(
    user: Annotated[CurrentUser, Depends(require("medications:read"))],
    patient_id: PatientId, db: DB, repo: Repo, check: Check,
    status: Literal["active", "completed", "stopped"] | None = None,
    limit: Limit = 25, cursor: Cursor = None,
) -> schemas.MedicationList:
    return await service.list_medications(db, repo, check, user, patient_id, status=status,
                                          limit=limit, cursor=cursor)


@router.post("/patients/{patientId}/medications", operation_id="recordMedication",
             status_code=status.HTTP_201_CREATED, response_model=schemas.Medication,
             response_model_exclude_none=True)
async def record_medication(
    user: Annotated[CurrentUser, Depends(require("medications:create"))],
    patient_id: PatientId, body: schemas.MedicationCreate, response: Response, db: DB,
    repo: Repo, check: Check,
) -> schemas.Medication:
    created = await service.record_medication(db, repo, check, user, patient_id, body)
    await db.commit()
    # The contract has no URL for one list entry; Location names the list it was added to.
    response.headers["Location"] = f"{API}/patients/{patient_id}/medications"
    return created


# --------------------------------------------------------------------------- drafts
@router.post("/prescriptions", operation_id="createPrescription",
             status_code=status.HTTP_201_CREATED, response_model=schemas.Prescription,
             response_model_exclude_none=True)
async def create_prescription(
    user: Annotated[CurrentUser, Depends(require("prescriptions:create"))],
    body: schemas.PrescriptionCreate, request: Request, response: Response, db: DB, repo: Repo,
    check: Check, audit: Audit,
) -> schemas.Prescription:
    row, patient_id = await service.create_prescription(db, repo, check, user, body)
    audit(request, [patient_id])  # x-audit patient "body:/patientId"
    await db.commit()
    response.headers["Location"] = f"{API}/prescriptions/{row.id}"
    return _prescription(response, row)


@router.get(PRESCRIPTION, operation_id="getPrescription", response_model=schemas.Prescription,
            response_model_exclude_none=True)
async def get_prescription(
    user: Annotated[CurrentUser, Depends(require("prescriptions:read"))],
    prescription_id: PrescriptionId, request: Request, response: Response, db: DB, repo: Repo,
    check: Check, audit: Audit,
) -> schemas.Prescription:
    row = await service.readable(db, repo, check, user, prescription_id)
    audit(request, [row.patient_id])  # x-audit patient "result"
    return _prescription(response, row)


@router.patch(PRESCRIPTION, operation_id="updatePrescription",
              response_model=schemas.Prescription, response_model_exclude_none=True)
async def update_prescription(
    user: Annotated[CurrentUser, Depends(require("prescriptions:update"))],
    prescription_id: PrescriptionId, body: schemas.PrescriptionPatch, request: Request,
    response: Response, db: DB, repo: Repo, check: Check, audit: Audit,
    if_match: IfMatch = None,
) -> schemas.Prescription:
    current = await service.readable(db, repo, check, user, prescription_id)
    if not body.model_fields_set:
        raise service.invalid("", "required")  # minProperties: 1
    row = await service.update_prescription(db, repo, current, body, if_match)
    audit(request, [row.patient_id])
    await db.commit()
    return _prescription(response, row)


@router.post(f"{PRESCRIPTION}/entered-in-error", operation_id="markPrescriptionEnteredInError",
             response_model=schemas.Prescription, response_model_exclude_none=True)
async def mark_prescription_entered_in_error(
    user: Annotated[CurrentUser, Depends(require("prescriptions:entered-in-error"))],
    prescription_id: PrescriptionId, body: schemas.PrescriptionEnteredInError,
    request: Request, response: Response, db: DB, repo: Repo, check: Check, audit: Audit,
) -> schemas.Prescription:
    current = await service.readable(db, repo, check, user, prescription_id)
    row = await service.enter_in_error(db, repo, current, body.reason)
    audit(request, [row.patient_id])
    await db.commit()
    return _prescription(response, row)


# ------------------------------------------------------------- safety check, override
@router.post(f"{PRESCRIPTION}/safety-check", operation_id="checkPrescriptionSafety",
             response_model=schemas.SafetyCheckResult, response_model_exclude_none=True)
async def check_prescription_safety(
    user: Annotated[CurrentUser, Depends(require("prescriptions:safety-check"))],
    prescription_id: PrescriptionId, request: Request, db: DB, repo: Repo, check: Check,
    audit: Audit,
) -> schemas.SafetyCheckResult:
    current = await service.readable(db, repo, check, user, prescription_id)
    result, row = await service.check_safety(db, repo, current)
    audit(request, [row.patient_id])
    await db.commit()
    return result


@router.post("/alerts/{alertId}/override", operation_id="overrideAlert",
             response_model=schemas.SafetyAlert, response_model_exclude_none=True)
async def override_alert(
    user: Annotated[CurrentUser, Depends(require("alerts:override"))],
    alert_id: AlertId, body: schemas.AlertOverride, request: Request, db: DB, repo: Repo,
    check: Check, audit: Audit,
) -> schemas.SafetyAlert:
    alert, patient_id = await service.override(db, repo, check, user, alert_id, body.reason)
    audit(request, [patient_id])
    await db.commit()
    return alert


# ------------------------------------------------------------------------ sign and send
@router.post(f"{PRESCRIPTION}/sign-and-send", operation_id="signAndSendPrescription",
             response_model=schemas.Prescription, response_model_exclude_none=True)
async def sign_and_send_prescription(
    user: Annotated[CurrentUser, Depends(require("prescriptions:sign-and-send"))],
    prescription_id: PrescriptionId, request: Request, response: Response, db: DB, repo: Repo,
    check: Check, audit: Audit, outbox: Outbox, if_match: IfMatch = None,
) -> schemas.Prescription:
    current = await service.readable(db, repo, check, user, prescription_id)
    row = await service.sign_and_send(db, repo, outbox, user, current, if_match)
    audit(request, [row.patient_id])
    await db.commit()  # signed, Provenance, on the list and NewRx queued: together or not at all
    return _prescription(response, row)
