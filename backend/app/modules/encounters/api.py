"""Encounters and vitals API (batch 2, contracts/openapi/modules/encounters.yaml). Each route's
operation_id is the contract's operationId; the permission (`require`) is the first dependency.

Rooming (demo step 7, IMPL_BATCH1_PLAN §8.3 PR-5): the workspace read and its edit (the reason for
visit, with If-Match), recording vitals and the patient's vitals list. Check-in uses this module's
service only (D16). Every route that touches a chart runs the restricted-chart check first (D37),
except the front desk's decline of a follow-up, which needs no break-glass (D107).
Operations whose x-audit takes the patient from the result hand it to core's audit hook.

The follow-up request (D98, demo step 10): the clinician sets it and may withdraw it; the front
desk declines it at check-out. The after-visit summary (#86, D98): generated from a signed note
(``202``, core's operation) and its download link for the front desk; the PDF and its document
are Anand's (draft #157), reached through ``after_visit_summary``'s seam, which answers ``503``
until it is wired.

**Waiting for core (T50):** ``follow-ups:decline`` and ``after-visit-summaries:read`` are not in
core's permission catalogue yet, and ``require()`` refuses an unknown name at import, so
``declineFollowUpRequest`` and ``getAfterVisitSummaryDownloadUrl`` are mounted by
``mount_pending_routes`` only once core knows their permission (the tests mount them with T50's
grants). Nothing stands in for the missing permission.

The pieces from other owners are FastAPI dependencies, so the tests can replace them: the
repository, Anand's write helpers, core's chart check, audit hook and operations, the facility's
rooms (practice setup, read through scheduling's seam until Anand's read service lands), and the
after-visit summary's store, file store and links.
"""

from collections.abc import Awaitable, Callable, Iterable
from datetime import UTC, date, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, Path, Query, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core import audit as core_audit
from app.core.deps import CurrentUser, require, tenant_db
from app.core.long_running import accepted
from app.core.permissions import is_known_permission
from app.db.fhir_store import FhirStore, SqlFhirStore
from app.modules.files.storage import file_store

from ..scheduling.reference import reference
from . import after_visit_summary as avs
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


def chart_openable() -> service.ChartOpen:
    """Whether the user may open a chart, refusing nothing (core's chart_access): the front
    desk's decline works on a restricted chart and only leaves out its clinical text (D107)."""
    async def openable(db: AsyncSession, user: CurrentUser, patient_id: UUID) -> bool:
        return (await core_access.chart_access(db, user, patient_id)).allowed

    return openable


def audit_patients() -> AuditPatients:
    """Core's hook naming the patients of an operation whose x-audit patient is "result"."""
    return core_audit.audit_patients


def facility_rooms() -> service.Rooms:
    """The rooms and other locations of a facility (practice setup)."""
    ref = reference()

    async def rooms(db: AsyncSession, facility_id: UUID) -> set[UUID]:
        return {loc.id for loc in await ref.locations(db, [facility_id])}

    return rooms


def summary_operations() -> avs.SummaryOperations:
    """Core's long-running work (create_operation, finish_operation)."""
    return avs.CoreSummaryOperations()


def summary_store() -> avs.SummaryStore:
    """Anand's after-visit summary (#157): 503 until it is wired (after_visit_summary.py)."""
    return avs.UnwiredSummaryStore()


def summary_links() -> avs.SummaryLinks:
    """The file service's download link: 503 until it is wired (after_visit_summary.py)."""
    return avs.UnwiredSummaryLinks()


def summary_files(request: Request) -> avs.FileStoreSource:
    """Anand's file store, resolved only when the summary is stored."""
    return lambda: file_store(request)


DB = Annotated[AsyncSession, Depends(tenant_db)]
Repo = Annotated[EncounterRepository, Depends(repository)]
Store = Annotated[FhirStore, Depends(fhir_store)]
Check = Annotated[service.ChartCheck, Depends(chart_check)]
Openable = Annotated[service.ChartOpen, Depends(chart_openable)]
Audit = Annotated[AuditPatients, Depends(audit_patients)]
Rooms = Annotated[Callable[[AsyncSession, UUID], Awaitable[set[UUID]]], Depends(facility_rooms)]
EncounterId = Annotated[UUID, Path(alias="encounterId")]
PatientId = Annotated[UUID, Path(alias="patientId")]
Operations = Annotated[avs.SummaryOperations, Depends(summary_operations)]
Summaries = Annotated[avs.SummaryStore, Depends(summary_store)]
Links = Annotated[avs.SummaryLinks, Depends(summary_links)]
Files = Annotated[avs.FileStoreSource, Depends(summary_files)]
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


# ------------------------------------------------------------------ follow-up request (D98)
@router.put(ENCOUNTER + "/follow-up", operation_id="setFollowUpRequest",
            response_model=schemas.FollowUpRequest, response_model_exclude_none=True)
async def set_follow_up_request(
    user: Annotated[CurrentUser, Depends(require("encounters:update"))],
    encounter_id: EncounterId, body: schemas.FollowUpRequestPut, request: Request,
    response: Response, db: DB, repo: Repo, check: Check, audit: Audit,
    if_match: IfMatch = None,
) -> schemas.FollowUpRequest:
    done = await service.set_follow_up(  # x-audit patient "result": named before the commit
        db, repo, check, user, encounter_id, body, if_match,
        lambda patient_id: audit(request, [patient_id]))
    response.headers["ETag"] = service.etag(done.version)  # the encounter's
    return done.value


@router.post(ENCOUNTER + "/follow-up/withdraw", operation_id="withdrawFollowUpRequest",
             response_model=schemas.FollowUpRequest, response_model_exclude_none=True)
async def withdraw_follow_up_request(
    user: Annotated[CurrentUser, Depends(require("encounters:update"))],
    encounter_id: EncounterId, body: schemas.FollowUpWithdraw, request: Request,
    response: Response, db: DB, repo: Repo, check: Check, audit: Audit,
    if_match: IfMatch = None,
) -> schemas.FollowUpRequest:
    done = await service.withdraw_follow_up(
        db, repo, check, user, encounter_id, body, if_match,
        lambda patient_id: audit(request, [patient_id]))
    response.headers["ETag"] = service.etag(done.version)
    return done.value


# ----------------------------------------------------------------- after-visit summary (#86)
@router.post(ENCOUNTER + "/after-visit-summary", operation_id="createAfterVisitSummary",
             status_code=status.HTTP_202_ACCEPTED, response_class=JSONResponse)
async def create_after_visit_summary(
    user: Annotated[CurrentUser, Depends(require("after-visit-summaries:create"))],
    encounter_id: EncounterId, request: Request, db: DB, repo: Repo, check: Check,
    audit: Audit, operations: Operations, summaries: Summaries, files: Files,
    body: Annotated[schemas.AfterVisitSummaryRequest | None, Body()] = None,
) -> JSONResponse:
    """The body is optional (the latest signed note). Idempotency-Key is optional
    (x-idempotency: supported): core claims and replays it."""
    finished = await service.create_summary(
        db, repo, check, operations, summaries, files, user, encounter_id,
        body or schemas.AfterVisitSummaryRequest(),
        lambda patient_id: audit(request, [patient_id]))
    return accepted(finished)  # 202, Location and Retry-After, as core answers


# ------------------------------------------------- routes waiting for core's permissions (T50)
#: The permission each waiting route needs (NOTE_FOR_THULASI T50; SECURITY_MODEL §4.2).
PENDING_PERMISSIONS = {
    "declineFollowUpRequest": "follow-ups:decline",
    "getAfterVisitSummaryDownloadUrl": "after-visit-summaries:read",
}


def _ready(operation_id: str, exclude: frozenset[str]) -> bool:
    return operation_id not in exclude and is_known_permission(PENDING_PERMISSIONS[operation_id])


def mount_pending_routes(target: APIRouter, exclude: frozenset[str] = frozenset()
                         ) -> frozenset[str]:
    """Adds each waiting route whose permission core now knows (except those in ``exclude``,
    already mounted); returns their operationIds. ``require()`` is called only here, after that
    check, so an unknown name never reaches it."""
    mounted: set[str] = set()
    if _ready("declineFollowUpRequest", exclude):
        @target.post(ENCOUNTER + "/follow-up/decline", operation_id="declineFollowUpRequest",
                     response_model=schemas.FollowUpRequest, response_model_exclude_none=True)
        async def decline_follow_up_request(
            user: Annotated[CurrentUser, Depends(require("follow-ups:decline"))],
            encounter_id: EncounterId, body: schemas.FollowUpDecline, request: Request,
            response: Response, db: DB, repo: Repo, openable: Openable, audit: Audit,
            if_match: IfMatch = None,
        ) -> schemas.FollowUpRequest:
            """Idempotency-Key is optional (x-idempotency: supported): core claims and replays
            it. No break-glass (D107): the service leaves out the note instead."""
            done = await service.decline_follow_up(
                db, repo, openable, user, encounter_id, body, if_match,
                lambda patient_id: audit(request, [patient_id]))
            response.headers["ETag"] = service.etag(done.version)
            return done.value

        mounted.add("declineFollowUpRequest")
    if _ready("getAfterVisitSummaryDownloadUrl", exclude):
        @target.get(ENCOUNTER + "/after-visit-summary/download-url",
                    operation_id="getAfterVisitSummaryDownloadUrl",
                    response_model=schemas.AfterVisitSummaryLink,
                    response_model_exclude_none=True)
        async def get_after_visit_summary_download_url(
            user: Annotated[CurrentUser, Depends(require("after-visit-summaries:read"))],
            encounter_id: EncounterId, request: Request, db: DB, repo: Repo, check: Check,
            audit: Audit, summaries: Summaries, links: Links,
        ) -> schemas.AfterVisitSummaryLink:
            stored, link = await service.summary_link(  # x-audit: a chart read (phi-read)
                db, repo, check, summaries, links, user, encounter_id,
                lambda patient_id: audit(request, [patient_id]))
            return schemas.AfterVisitSummaryLink(
                document_id=stored.document_id, generated_at=stored.generated_at,
                url=link.url, expires_at=link.expires_at)

        mounted.add("getAfterVisitSummaryDownloadUrl")
    return frozenset(mounted)


#: The waiting routes this process serves: none until core has T50's permissions.
MOUNTED_PENDING = mount_pending_routes(router)
