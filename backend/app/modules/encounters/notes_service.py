"""Note rules (inventory #75-80, #82; D8, D73; DATA_OWNERSHIP §5.3) and closing the visit (#66;
§5.2). Notes are Compositions written through Anand's note helpers in the request's transaction.

- **Start** (``createNote``): from a template, whose sections and default text are copied in, or
  from a LOINC note type with one free-text section. The author is the user's practitioner. The
  first note moves an ``arrived`` or ``triaged`` encounter to ``in-progress`` (§5.2).
- **Autosave** (``updateNoteDraft``): the author only, with ``If-Match``; every committed save is
  a version (D73). A signed note is ``409 record-locked``.
- **Sign**: the author only, with ``If-Match``. The batch 2 default of DECISIONS Q22 (D73): every
  required section has text, and every AI-drafted section has a decision; each refusal is named
  in ``errors``. Signing locks the note and writes its Provenance in the same transaction (D8).
  A co-sign rule for the author names the co-signer (``cosignStatus: pending``).
- **Addendum**: a new signed Composition that appends to a signed note, in one transaction.
- **Co-sign** (``cosignNote``, D73): only the co-signer the co-sign rule named when the note was
  signed, never the author, while ``cosignStatus`` is ``pending``. ``cosign`` adds the
  professional attester and its Provenance (``cosigned``, ``note.cosigned``); ``return`` keeps
  the note signed and frozen with the comment (``returned``, ``note.cosign-returned``), and the
  author answers with an addendum, which makes it ``pending`` again.
- **Close**: ``in-progress`` to ``finished`` with the Q22 default: a signed note, no open draft,
  and a diagnosis for a billable visit; publishes ``encounter.closed`` in the same transaction.

RN writes nursing notes only (LOINC 34746-8; T42). BIL reads signed notes only: a draft is
``404`` for BIL (SECURITY_MODEL §4.3).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import Conflict, Forbidden, NotFound, PreconditionFailed, field_error
from app.core.events import publish
from app.db.fhir_store import (
    UNSET,
    Coded,
    FhirStore,
    InvalidInput,
    InvalidTransition,
    NoteChanges,
    NoteIn,
    ResourceNotFound,
    SectionIn,
    SectionText,
    StaleVersion,
)
from app.db.models import systems

from . import notes_schemas as nschemas
from . import schemas
from .diagnoses_repository import DiagnosisRepository
from .notes_repository import NURSE_NOTE, NoteHead, NoteRepository
from .repository import EncounterHead, EncounterRepository, Versioned
from .service import (
    ChartCheck,
    business_rule,
    decode_cursor,
    etag,
    if_match_version,
    page,
    readable,
    signed_notes_only,
)

#: A note is started only while the visit is open.
CLOSED = ("finished", "cancelled", "entered-in-error")
#: The note types the free-text title defaults to, when the type gives no display.
NOTE_TYPE_NAMES = {"11506-3": "Progress note", "34746-8": "Nurse note",
                   "34748-4": "Telephone encounter note", "34117-2": "History and physical note"}


@dataclass(frozen=True)
class TemplateIn:
    """A note template as createNote uses it (practice setup's NoteTemplate)."""
    id: UUID
    name: str
    note_type_loinc: str
    active: bool
    owner_user_id: UUID | None
    sections: tuple[tuple[int, str, str, str | None], ...]  # sequence, code, title, default


#: The template a note starts from (practice setup), or None for one the session can't see.
Template = Callable[[AsyncSession, UUID], Awaitable[TemplateIn | None]]
NamePatient = Callable[[UUID], None]


def _state(current: str) -> Conflict:
    return Conflict(code="invalid-state-transition", currentState=current)


def _record_locked() -> Conflict:
    return Conflict("The note is signed: changes go in an addendum", code="record-locked")


def _nurse_only(user: CurrentUser, type_code: str | None) -> None:
    """RN writes, signs and adds to nursing notes only (T42)."""
    if "RN" in user.roles and not user.roles & {"MD", "APP"} and type_code != NURSE_NOTE:
        raise Forbidden("Nurses write nursing notes only", code="permission-denied")


async def _note(db: AsyncSession, nrepo: NoteRepository, repo: EncounterRepository,
                check: ChartCheck, user: CurrentUser, note_id: UUID
                ) -> tuple[NoteHead, EncounterHead]:
    """The note and its encounter: 404 for a note the clinic can't see, at a facility not the
    user's, or a draft for BIL; then the restricted-chart check (D37)."""
    note = await nrepo.head(db, note_id)
    if note is None or (note.status == "preliminary" and signed_notes_only(user)):
        raise NotFound()
    encounter = await readable(db, repo, check, user, note.encounter_id)
    return note, encounter


async def _author(db: AsyncSession, nrepo: NoteRepository, user: CurrentUser,
                  note: NoteHead) -> UUID:
    practitioner = await nrepo.user_practitioner(db, user.id)
    if practitioner is None or practitioner != note.author_id:
        raise Forbidden("Only the note's author may do this", code="permission-denied")
    return practitioner


async def _locked_version(db: AsyncSession, nrepo: NoteRepository, note_id: UUID,
                          version: int) -> NoteHead:
    locked = await nrepo.head(db, note_id, lock=True)
    if locked is None:
        raise NotFound()
    if locked.version != version:
        raise PreconditionFailed(headers={"ETag": etag(locked.version)})
    return locked


# --------------------------------------------------------------------------------------- start
async def create(db: AsyncSession, repo: EncounterRepository, nrepo: NoteRepository,
                 store: FhirStore, check: ChartCheck, template_of: Template, user: CurrentUser,
                 encounter_id: UUID, body: nschemas.NoteCreate, name_patient: NamePatient
                 ) -> Versioned[nschemas.Note]:
    head = await readable(db, repo, check, user, encounter_id)
    if await nrepo.user_practitioner(db, user.id) is None:
        raise Forbidden("Only a clinician linked to a practitioner record writes notes",
                        code="permission-denied")
    sections: tuple[SectionIn, ...]
    if body.template_id is not None:
        template = await template_of(db, body.template_id)
        if template is None or not template.active or (
                template.owner_user_id is not None and template.owner_user_id != user.id):
            raise business_rule([field_error("body", "/templateId", "invalid-reference")])
        note_type = Coded(system=systems.LOINC, code=template.note_type_loinc,
                          display=NOTE_TYPE_NAMES.get(template.note_type_loinc))
        title = body.title or template.name
        sections = tuple(SectionIn(code=code, title=title_, text=default or "")
                         for _, code, title_, default in sorted(template.sections))
        if not sections:
            raise business_rule([field_error("body", "/templateId", "invalid-reference")])
    elif body.note_type is not None:
        loinc = [c for c in body.note_type.codings if c.system == systems.LOINC]
        if not loinc:
            raise business_rule([field_error("body", "/noteType/codings", "required")])
        coding = loinc[0]
        name = (coding.display or body.note_type.text or NOTE_TYPE_NAMES.get(coding.code)
                or "Note")
        note_type = Coded(system=systems.LOINC, code=coding.code, display=coding.display,
                          text=body.note_type.text)
        title = body.title or name
        # One free-text section, coded with the note's own type (no section code fits all).
        sections = (SectionIn(code=coding.code, title=name, text=""),)
    else:
        raise business_rule([field_error("body", "/templateId", "required")])
    if not title.strip():
        raise business_rule([field_error("body", "/title", "required")])
    _nurse_only(user, note_type.code)
    locked = await repo.head(db, encounter_id, lock=True)
    if locked.status in CLOSED:
        raise _state(locked.status)
    if locked.status in ("arrived", "triaged"):  # the first note starts the visit (§5.2)
        await store.set_encounter_status(db, encounter_id, "in-progress")
        await publish(db, "encounter.status-changed", f"encounter/{encounter_id}",
                      {"status": "in-progress"}, facility_id=head.facility_id,
                      patient_id=head.patient_id)
    try:
        written = await store.create_note(db, NoteIn(
            encounter_id=encounter_id, note_type=note_type, title=title, sections=sections,
            template_id=body.template_id))
    except ResourceNotFound as gone:
        raise NotFound() from gone
    except InvalidTransition as done:
        raise _state(done.current_state) from done
    except InvalidInput as refused:
        raise business_rule([field_error("body", "/title", "required")]) from refused
    name_patient(head.patient_id)
    await db.commit()
    return await nrepo.get(db, written.id)


# ---------------------------------------------------------------------------------------- read
async def get(db: AsyncSession, repo: EncounterRepository, nrepo: NoteRepository,
              check: ChartCheck, user: CurrentUser, note_id: UUID) -> Versioned[nschemas.Note]:
    await _note(db, nrepo, repo, check, user, note_id)
    return await nrepo.get(db, note_id)


async def list_for_encounter(db: AsyncSession, repo: EncounterRepository, nrepo: NoteRepository,
                             check: ChartCheck, user: CurrentUser, encounter_id: UUID, *,
                             status: str | None, limit: int, cursor: str | None
                             ) -> tuple[UUID, list[schemas.NoteSummary], str | None]:
    """The encounter's notes, newest first, and its patient (for the audit)."""
    offset = decode_cursor(cursor)
    head = await readable(db, repo, check, user, encounter_id)
    found = await nrepo.for_encounter(db, encounter_id, status=status,
                                      signed_only=signed_notes_only(user), limit=limit + 1,
                                      offset=offset)
    items, next_cursor = page(found, limit, offset)
    return head.patient_id, items, next_cursor


async def versions(db: AsyncSession, repo: EncounterRepository, nrepo: NoteRepository,
                   check: ChartCheck, user: CurrentUser, note_id: UUID, *, limit: int,
                   cursor: str | None) -> tuple[UUID, list[nschemas.NoteVersion], str | None]:
    offset = decode_cursor(cursor)
    note, _ = await _note(db, nrepo, repo, check, user, note_id)
    found = await nrepo.versions(db, note_id, signed_only=signed_notes_only(user),
                                 limit=limit + 1, offset=offset)
    items, next_cursor = page(found, limit, offset)
    return note.patient_id, items, next_cursor


# ------------------------------------------------------------------------------------ autosave
async def update(db: AsyncSession, repo: EncounterRepository, nrepo: NoteRepository,
                 store: FhirStore, check: ChartCheck, user: CurrentUser, note_id: UUID,
                 patch: nschemas.NotePatch, if_match: str | None, name_patient: NamePatient
                 ) -> Versioned[nschemas.Note]:
    version = if_match_version(if_match)
    note, _ = await _note(db, nrepo, repo, check, user, note_id)
    await _author(db, nrepo, user, note)
    _nurse_only(user, note.type_code)
    sent = patch.model_fields_set
    if "title" in sent and (patch.title is None or not patch.title.strip()):
        raise business_rule([field_error("body", "/title", "required")])
    if "sections" in sent and patch.sections is None:
        raise business_rule([field_error("body", "/sections", "invalid-type")])
    locked = await _locked_version(db, nrepo, note_id, version)
    if locked.status in ("final", "amended"):
        raise _record_locked()
    if locked.status != "preliminary":
        raise _state(locked.status)
    known = {s.id for s in await nrepo.sections(db, locked)}
    changes = patch.sections or []
    errors = [field_error("body", f"/sections/{i}/id", "invalid-reference")
              for i, s in enumerate(changes) if s.id not in known]
    if errors:
        raise business_rule(errors)
    try:
        await store.update_note(db, note_id, NoteChanges(
            title=patch.title if "title" in sent and patch.title is not None else UNSET,
            sections=tuple(SectionText(id=s.id, text=s.text) for s in changes)),
            if_version=version)
    except StaleVersion as stale:
        raise PreconditionFailed(headers={"ETag": etag(stale.current_version)}) from stale
    except InvalidTransition as done:
        raise _record_locked() from done
    name_patient(note.patient_id)
    await db.commit()
    return await nrepo.get(db, note_id)


# ---------------------------------------------------------------------------------------- sign
async def sign(db: AsyncSession, repo: EncounterRepository, nrepo: NoteRepository,
               store: FhirStore, check: ChartCheck, user: CurrentUser, note_id: UUID,
               if_match: str | None, name_patient: NamePatient) -> Versioned[nschemas.Note]:
    version = if_match_version(if_match)
    note, encounter = await _note(db, nrepo, repo, check, user, note_id)
    author = await _author(db, nrepo, user, note)
    _nurse_only(user, note.type_code)
    locked = await _locked_version(db, nrepo, note_id, version)
    if locked.status != "preliminary":
        raise _state(locked.status)
    errors = []
    for i, s in enumerate(await nrepo.sections(db, locked)):
        if s.required and not s.text.strip():
            errors.append(field_error("body", f"/sections/{i}/text", "required"))
        if s.ai_decision is not None and s.ai_decision not in ("accepted", "edited", "rejected"):
            errors.append(field_error("body", f"/sections/{i}/aiDecision", "required"))
    if errors:
        raise business_rule(errors)
    cosigner = await nrepo.cosigner(db, author, encounter.facility_id)
    try:
        await store.sign_note(db, note_id, if_version=version,
                              cosigner_practitioner_id=cosigner)
    except StaleVersion as stale:
        raise PreconditionFailed(headers={"ETag": etag(stale.current_version)}) from stale
    except InvalidTransition as done:
        raise _state(done.current_state) from done
    await publish(db, "note.signed", f"note/{note_id}",
                  {"encounterId": str(note.encounter_id),
                   "cosignStatus": "pending" if cosigner else "not-required"},
                  facility_id=encounter.facility_id, patient_id=note.patient_id)
    name_patient(note.patient_id)
    await db.commit()
    return await nrepo.get(db, note_id)


# ------------------------------------------------------------------------------------ addendum
async def add_addendum(db: AsyncSession, repo: EncounterRepository, nrepo: NoteRepository,
                       store: FhirStore, check: ChartCheck, user: CurrentUser, note_id: UUID,
                       text: str, if_match: str | None, name_patient: NamePatient
                       ) -> Versioned[nschemas.Note]:
    version = if_match_version(if_match)
    note, encounter = await _note(db, nrepo, repo, check, user, note_id)
    _nurse_only(user, note.type_code)
    if await nrepo.user_practitioner(db, user.id) is None:
        raise Forbidden("Only a clinician linked to a practitioner record adds addenda",
                        code="permission-denied")
    if not text.strip():
        raise business_rule([field_error("body", "/text", "required")])
    locked = await _locked_version(db, nrepo, note_id, version)
    if locked.status not in ("final", "amended"):
        raise _state(locked.status)
    try:
        await store.add_note_addendum(db, note_id, text, if_version=version)
    except StaleVersion as stale:
        raise PreconditionFailed(headers={"ETag": etag(stale.current_version)}) from stale
    except InvalidTransition as done:
        raise _state(done.current_state) from done
    await publish(db, "note.amended", f"note/{note_id}", {"encounterId": str(note.encounter_id)},
                  facility_id=encounter.facility_id, patient_id=note.patient_id)
    name_patient(note.patient_id)
    await db.commit()
    return await nrepo.get(db, note_id)


# --------------------------------------------------------------------------------------- close
async def close(db: AsyncSession, repo: EncounterRepository, nrepo: NoteRepository,
                drepo: DiagnosisRepository, store: FhirStore, check: ChartCheck,
                user: CurrentUser, encounter_id: UUID, name_patient: NamePatient
                ) -> Versioned[schemas.Encounter]:
    """closeEncounter with the Q22 default (D73). A visit opened at check-in (it has an
    appointment) is billable and needs a diagnosis; an unscheduled one (telephone,
    documentation-only, D16) does not. A pending co-signature never blocks (A29)."""
    head = await readable(db, repo, check, user, encounter_id)
    locked = await repo.head(db, encounter_id, lock=True)
    if locked.status != "in-progress":
        raise _state(locked.status)
    counts = await nrepo.counts(db, encounter_id)
    errors = []
    if counts.signed == 0:
        errors.append(field_error("body", "/notes", "required"))
    if counts.drafts > 0:
        errors.append(field_error("body", "/notes", "not-allowed-value"))
    if locked.appointment_id is not None and not await drepo.live(db, encounter_id):
        errors.append(field_error("body", "/diagnoses", "required"))
    if errors:
        raise business_rule(errors)
    try:
        await store.set_encounter_status(db, encounter_id, "finished")
    except InvalidTransition as done:
        raise _state(done.current_state) from done
    subject = f"encounter/{encounter_id}"
    await publish(db, "encounter.closed", subject, {"patientId": str(head.patient_id)},
                  facility_id=head.facility_id, patient_id=head.patient_id)
    await publish(db, "encounter.status-changed", subject, {"status": "finished"},
                  facility_id=head.facility_id, patient_id=head.patient_id)
    name_patient(head.patient_id)
    await db.commit()
    return await repo.get(db, encounter_id, signed_notes_only=signed_notes_only(user))



# ------------------------------------------------------------------------------------- co-sign
def _not_the_cosigner() -> Forbidden:
    return Forbidden("Only the co-signer the co-sign rule names may decide",
                     code="permission-denied")


async def cosign(db: AsyncSession, repo: EncounterRepository, nrepo: NoteRepository,
                 store: FhirStore, check: ChartCheck, user: CurrentUser, note_id: UUID,
                 body: nschemas.CosignDecision, if_match: str | None,
                 name_patient: NamePatient) -> Versioned[nschemas.Note]:
    """cosignNote (#81, D73). In order: ``If-Match`` (428), the note (404) and the chart (D37),
    a ``return`` without a comment (422), a note not waiting for its co-signature (409 with
    ``currentState``), a user who is not the co-signer the rule named, or is the author (403),
    then the version (412). The helper decides again under the row lock."""
    version = if_match_version(if_match)
    note, encounter = await _note(db, nrepo, repo, check, user, note_id)
    comment = (body.comment or "").strip()
    if body.decision == "return" and not comment:
        raise business_rule([field_error("body", "/comment", "required")])
    if note.status not in ("final", "amended"):
        raise _state(note.status)
    if note.cosign_status != "pending":
        raise _state(note.cosign_status)
    practitioner = await nrepo.user_practitioner(db, user.id)
    if practitioner is None or practitioner != note.cosigner_id \
            or practitioner == note.author_id:
        raise _not_the_cosigner()
    locked = await _locked_version(db, nrepo, note_id, version)
    if locked.cosign_status != "pending":
        raise _state(locked.cosign_status)
    try:
        if body.decision == "cosign":
            await store.cosign_note(db, note_id, if_version=version)
        else:
            await store.return_note_to_author(db, note_id, comment, if_version=version)
    except StaleVersion as stale:
        raise PreconditionFailed(headers={"ETag": etag(stale.current_version)}) from stale
    except InvalidTransition as done:
        raise _state(done.current_state) from done
    except InvalidInput as refused:  # not the named co-signer, seen under the lock
        raise _not_the_cosigner() from refused
    event = "note.cosigned" if body.decision == "cosign" else "note.cosign-returned"
    await publish(db, event, f"note/{note_id}", {"encounterId": str(note.encounter_id)},
                  facility_id=encounter.facility_id, patient_id=note.patient_id)
    name_patient(note.patient_id)
    await db.commit()
    return await nrepo.get(db, note_id)
