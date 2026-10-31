"""Notes API (inventory #66, #75-80, #82; contracts/openapi/modules/encounters.yaml) and closing
the visit. Each route's operation_id is the contract's operationId; the permission (`require`) is
the first dependency. Every route runs the facility and restricted-chart checks first (D37), and
names the patient for core's audit (x-audit patient "result"): before the commit for writes,
before returning for reads.

Not built (D108, not on the demo path): cosignNote and markNoteEnteredInError.

The note templates are Anand's (practice setup, x-owner anand): createNote reads one through his
module's repository (``template_reader``), the seam the tests replace.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, require

from ..practice_setup.repository import SqlSetupRepository
from . import notes_schemas as nschemas
from . import notes_service as nservice
from . import schemas, service
from .api import DB, Audit, AuditPatients, Check, Cursor, EncounterId, IfMatch, Limit, Repo, Store
from .diagnoses_api import DRepo
from .notes_repository import NoteRepository, SqlNoteRepository

router: APIRouter = APIRouter(tags=["encounters"])

NOTE = "/notes/{noteId}"


def note_repository() -> NoteRepository:
    return SqlNoteRepository()


def template_reader() -> nservice.Template:
    """A note template through practice setup's repository (Anand's read; RLS keeps it to the
    clinic)."""
    setup = SqlSetupRepository()

    async def read(db: AsyncSession, template_id: UUID) -> nservice.TemplateIn | None:
        found = await setup.get_note_template(db, template_id)
        if found is None:
            return None
        return nservice.TemplateIn(
            id=found.id, name=found.name, note_type_loinc=found.note_type_loinc,
            active=found.active, owner_user_id=found.owner_user_id,
            sections=tuple((s.sequence, s.section_code, s.title, s.default_text)
                           for s in found.sections))

    return read


NRepo = Annotated[NoteRepository, Depends(note_repository)]
Templates = Annotated[nservice.Template, Depends(template_reader)]
NoteId = Annotated[UUID, Path(alias="noteId")]


def _named(request: Request, audit: AuditPatients) -> nservice.NamePatient:
    def name(patient_id: UUID) -> None:
        audit(request, [patient_id])
    return name


@router.get("/encounters/{encounterId}/notes", operation_id="listEncounterNotes",
            response_model=nschemas.NoteList, response_model_exclude_none=True)
async def list_encounter_notes(
    user: Annotated[CurrentUser, Depends(require("notes:read"))],
    encounter_id: EncounterId, request: Request, db: DB, repo: Repo, nrepo: NRepo,
    check: Check, audit: Audit,
    note_status: Annotated[nschemas.NoteStatus | None, Query(alias="status")] = None,
    limit: Limit = 25, cursor: Cursor = None,
) -> nschemas.NoteList:
    patient_id, items, next_cursor = await nservice.list_for_encounter(
        db, repo, nrepo, check, user, encounter_id, status=note_status, limit=limit,
        cursor=cursor)
    audit(request, [patient_id])
    return nschemas.NoteList(items=items, next_cursor=next_cursor)


@router.post("/encounters/{encounterId}/notes", operation_id="createNote",
             status_code=status.HTTP_201_CREATED, response_model=nschemas.Note,
             response_model_exclude_none=True)
async def create_note(
    user: Annotated[CurrentUser, Depends(require("notes:create"))],
    encounter_id: EncounterId, body: nschemas.NoteCreate, request: Request,
    response: Response, db: DB, repo: Repo, nrepo: NRepo, store: Store, check: Check,
    audit: Audit, templates: Templates,
) -> nschemas.Note:
    """Idempotency-Key is optional (x-idempotency: supported): core claims and replays it."""
    created = await nservice.create(db, repo, nrepo, store, check, templates, user,
                                    encounter_id, body, _named(request, audit))
    response.headers["ETag"] = service.etag(created.version)
    response.headers["Location"] = f"/api/v1/notes/{created.value.id}"
    return created.value


@router.get(NOTE, operation_id="getNote", response_model=nschemas.Note,
            response_model_exclude_none=True)
async def get_note(
    user: Annotated[CurrentUser, Depends(require("notes:read"))],
    note_id: NoteId, request: Request, response: Response, db: DB, repo: Repo, nrepo: NRepo,
    check: Check, audit: Audit,
) -> nschemas.Note:
    found = await nservice.get(db, repo, nrepo, check, user, note_id)
    audit(request, [found.value.patient_id])
    response.headers["ETag"] = service.etag(found.version)
    return found.value


@router.patch(NOTE, operation_id="updateNoteDraft", response_model=nschemas.Note,
              response_model_exclude_none=True)
async def update_note_draft(
    user: Annotated[CurrentUser, Depends(require("notes:update"))],
    note_id: NoteId, body: nschemas.NotePatch, request: Request, response: Response, db: DB,
    repo: Repo, nrepo: NRepo, store: Store, check: Check, audit: Audit,
    if_match: IfMatch = None,
) -> nschemas.Note:
    saved = await nservice.update(db, repo, nrepo, store, check, user, note_id, body, if_match,
                                  _named(request, audit))
    response.headers["ETag"] = service.etag(saved.version)
    return saved.value


@router.post(NOTE + "/sign", operation_id="signNote", response_model=nschemas.Note,
             response_model_exclude_none=True)
async def sign_note(
    user: Annotated[CurrentUser, Depends(require("notes:sign"))],
    note_id: NoteId, request: Request, response: Response, db: DB, repo: Repo, nrepo: NRepo,
    store: Store, check: Check, audit: Audit, if_match: IfMatch = None,
) -> nschemas.Note:
    signed = await nservice.sign(db, repo, nrepo, store, check, user, note_id, if_match,
                                 _named(request, audit))
    response.headers["ETag"] = service.etag(signed.version)
    return signed.value


@router.post(NOTE + "/addenda", operation_id="addNoteAddendum", response_model=nschemas.Note,
             response_model_exclude_none=True)
async def add_note_addendum(
    user: Annotated[CurrentUser, Depends(require("note-addenda:create"))],
    note_id: NoteId, body: nschemas.AddendumCreate, request: Request, response: Response,
    db: DB, repo: Repo, nrepo: NRepo, store: Store, check: Check, audit: Audit,
    if_match: IfMatch = None,
) -> nschemas.Note:
    """Idempotency-Key is optional (x-idempotency: supported): core claims and replays it."""
    amended = await nservice.add_addendum(db, repo, nrepo, store, check, user, note_id,
                                          body.text, if_match, _named(request, audit))
    response.headers["ETag"] = service.etag(amended.version)
    return amended.value


@router.get(NOTE + "/versions", operation_id="listNoteVersions",
            response_model=nschemas.NoteVersionList, response_model_exclude_none=True)
async def list_note_versions(
    user: Annotated[CurrentUser, Depends(require("notes:read"))],
    note_id: NoteId, request: Request, db: DB, repo: Repo, nrepo: NRepo, check: Check,
    audit: Audit, limit: Limit = 25, cursor: Cursor = None,
) -> nschemas.NoteVersionList:
    patient_id, items, next_cursor = await nservice.versions(
        db, repo, nrepo, check, user, note_id, limit=min(limit, 50), cursor=cursor)
    audit(request, [patient_id])
    return nschemas.NoteVersionList(items=items, next_cursor=next_cursor)


@router.post("/encounters/{encounterId}/close", operation_id="closeEncounter",
             response_model=schemas.Encounter, response_model_exclude_none=True)
async def close_encounter(
    user: Annotated[CurrentUser, Depends(require("encounters:close"))],
    encounter_id: EncounterId, request: Request, response: Response, db: DB, repo: Repo,
    nrepo: NRepo, drepo: DRepo, store: Store, check: Check, audit: Audit,
) -> schemas.Encounter:
    closed = await nservice.close(db, repo, nrepo, drepo, store, check, user, encounter_id,
                                  _named(request, audit))
    response.headers["ETag"] = service.etag(closed.version)
    return closed.value
