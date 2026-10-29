"""Online pre-registration routes (D96, #89): the public form and the front desk's queue.

``api.py`` mounts this router only once the contract's operations are in the operations map and
core has the ``pre-registrations:*`` permissions (T47); before that ``create_app`` would refuse the
routes, and ``require()`` an unknown permission. The rules are in pre_registration_service.py.
"""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, public_db, require, tenant_db
from app.core.request_id import current_request_id

from . import pre_registration_service as rules
from . import schemas
from .access import AuditHooks, ChartCheck, audit_hooks, chart_check, fhir_store
from .api import repository as patient_repository
from .pre_registration_repository import PreRegistrationRepository, SqlPreRegistrationRepository
from .public_form import FieldCipher, PublicFormGuards, field_cipher, public_form_guards
from .repository import PatientRepository
from .store import FhirStore

router = APIRouter(tags=["patients"])

OPERATIONS = frozenset({"submitPreRegistration", "listPreRegistrations", "getPreRegistration",
                        "acceptPreRegistration", "rejectPreRegistration"})
PERMISSIONS = frozenset({"pre-registrations:read", "pre-registrations:accept",
                         "pre-registrations:reject"})
ITEM = "/pre-registrations/{preRegistrationId}"


def pre_registrations() -> PreRegistrationRepository:
    return SqlPreRegistrationRepository()


Repo = Annotated[PreRegistrationRepository, Depends(pre_registrations)]
Patients = Annotated[PatientRepository, Depends(patient_repository)]
Store = Annotated[FhirStore, Depends(fhir_store)]
Check = Annotated[ChartCheck, Depends(chart_check)]
Audit = Annotated[AuditHooks, Depends(audit_hooks)]
Guards = Annotated[PublicFormGuards, Depends(public_form_guards)]
Cipher = Annotated[FieldCipher, Depends(field_cipher)]
DB = Annotated[AsyncSession, Depends(tenant_db)]
PreRegistrationId = Annotated[UUID, Path(alias="preRegistrationId")]
PracticeLinkId = Annotated[str, Path(alias="practiceLinkId", min_length=16, max_length=64,
                                     pattern=r"^[A-Za-z0-9_-]{16,64}$")]
IdempotencyKey = Annotated[str, Header(
    alias="Idempotency-Key", max_length=38,
    pattern=r'^"?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"?$')]


async def portal_origin_only(request: Request, guards: Guards) -> None:
    """Before anything else, the body included: a request from anywhere but the portal is 403,
    and each IP's requests are counted (429)."""
    rules.check_origin(guards, request.headers.get("origin"))
    await rules.check_ip_limit(guards, request.client.host if request.client else None)


async def bot_check_first(request: Request, guards: Guards) -> None:
    """Then the ALTCHA answer, before the body's fields are validated (the contract's order:
    Origin, rate limit, bot check, body). FastAPI has already refused a body that isn't JSON."""
    try:
        body = await request.json()
    except ValueError:
        body = None
    payload = body.get("botCheck") if isinstance(body, dict) else None
    await rules.check_bot(guards, payload, request.headers.get("idempotency-key"))


@router.post("/portal/practices/{practiceLinkId}/pre-registrations",
             operation_id="submitPreRegistration", status_code=status.HTTP_204_NO_CONTENT,
             response_class=Response,
             dependencies=[Depends(portal_origin_only), Depends(bot_check_first)])
async def submit_pre_registration(
    practice_link_id: PracticeLinkId, idempotency_key: IdempotencyKey,
    body: schemas.PreRegistrationCreate, request: Request,
    db: Annotated[AsyncSession, Depends(public_db)], repo: Repo, guards: Guards, cipher: Cipher,
) -> Response:
    await rules.submit(
        db, repo, guards, cipher, body, practice_code=practice_link_id,
        idempotency_key=rules.parse_idempotency_key(idempotency_key),
        source_ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"), correlation_id=current_request_id())
    return Response(status_code=status.HTTP_204_NO_CONTENT)  # the same answer every time


@router.get("/pre-registrations", operation_id="listPreRegistrations",
            response_model=schemas.PreRegistrationList, response_model_exclude_none=True)
async def list_pre_registrations(
    user: Annotated[CurrentUser, Depends(require("pre-registrations:read"))],
    db: DB, repo: Repo, cipher: Cipher,
    status_filter: Annotated[schemas.PreRegistrationStatus, Query(alias="status")] = "pending",
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    cursor: Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")] = None,
) -> schemas.PreRegistrationList:
    return await rules.listing(db, repo, cipher, status_filter, limit, cursor)


@router.get(ITEM, operation_id="getPreRegistration", response_model=schemas.PreRegistration,
            response_model_exclude_none=True)
async def get_pre_registration(
    user: Annotated[CurrentUser, Depends(require("pre-registrations:read"))],
    pre_registration_id: PreRegistrationId, db: DB, repo: Repo, cipher: Cipher,
) -> schemas.PreRegistration:
    return await rules.read(db, repo, cipher, pre_registration_id)


@router.post(f"{ITEM}/accept", operation_id="acceptPreRegistration",
             response_model=schemas.PreRegistration, response_model_exclude_none=True)
async def accept_pre_registration(
    user: Annotated[CurrentUser, Depends(require("pre-registrations:accept"))],
    pre_registration_id: PreRegistrationId, body: schemas.PreRegistrationAccept,
    request: Request, db: DB, repo: Repo, patients: Patients, store: Store, check: Check,
    cipher: Cipher, audit: Audit,
) -> schemas.PreRegistration:
    if body.duplicate_check == "override" and body.duplicate_override_reason:
        audit.detail(request, "create", body.duplicate_override_reason)  # the override's reason
    patient_id = await rules.accept(db, repo, patients, store, check, cipher, user,
                                    pre_registration_id, body, today=datetime.now(UTC).date())
    audit.patients(request, [patient_id])  # x-audit patient "result"; commits with the decision
    await db.commit()
    return await rules.read(db, repo, cipher, pre_registration_id)


@router.post(f"{ITEM}/reject", operation_id="rejectPreRegistration",
             response_model=schemas.PreRegistration, response_model_exclude_none=True)
async def reject_pre_registration(
    user: Annotated[CurrentUser, Depends(require("pre-registrations:reject"))],
    pre_registration_id: PreRegistrationId, body: schemas.PreRegistrationReject, db: DB,
    repo: Repo, cipher: Cipher,
) -> schemas.PreRegistration:
    await rules.reject(db, repo, user, pre_registration_id, body)
    return await rules.read(db, repo, cipher, pre_registration_id)
