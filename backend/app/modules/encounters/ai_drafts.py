"""AI-01 drafts as notes (D70): the encounters side of the AI module (``app.modules.ai``).

**Before the model is called** (``ready``): the encounter is readable by the user (facility,
restricted chart, D37), the user writes notes (linked to a practitioner; RN nursing notes only,
T42) and the visit is ``arrived``, ``triaged`` or ``in-progress`` (createNoteDraft); otherwise
``404``, ``403`` or ``409 invalid-state-transition`` with ``currentState``, synchronously.

**The draft** (``create_ai_draft``, the gateway's ``NoteDrafts`` port): an unsigned note
(``preliminary``) written through Anand's note helper, in the request's transaction, with the
template's sections; each section the model filled is linked to its own AI suggestion, which
marks it ``ai-generated`` on read. The author is the requesting clinician's practitioner, as for
any note. Like the notes service's first note, the draft moves an ``arrived`` or ``triaged``
visit to ``in-progress`` and publishes ``encounter.status-changed``. Nothing here signs: signing
stays the author's act through the notes service, and the database refuses it until each AI
section's suggestion is decided.

**A decision on a section** (``section_for_decision``): the AI module's decideAiSuggestion asks
for the section's current text, after the same checks as editing the note: readable (D37), the
note's author only (``403``), and the note still a draft (``409 record-locked`` once signed).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import Conflict, Forbidden, NotFound
from app.core.events import publish
from app.db.fhir_store import (
    Coded,
    FhirStore,
    InvalidTransition,
    NoteIn,
    ResourceNotFound,
    SectionIn,
    SqlFhirStore,
)
from app.db.models import systems
from app.modules.ai.schemas import AIDraftIn, DraftWritten

from . import repository
from .notes_repository import NURSE_NOTE, NoteRepository, SqlNoteRepository
from .repository import EncounterHead, EncounterRepository, SqlEncounterRepository
from .service import readable, signed_notes_only

#: A draft is made only while the visit is open and not yet finished (createNoteDraft).
DRAFTABLE = ("arrived", "triaged", "in-progress")
ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[object]]


@dataclass(frozen=True)
class SectionForDecision:
    note_id: UUID
    patient_id: UUID
    encounter_id: UUID
    code: str
    text: str


_SECTION = text("SELECT composition_id, code_code FROM clinical.composition_section "
                "WHERE id = :id")


def _state(current: str) -> Conflict:
    return Conflict(code="invalid-state-transition", currentState=current)


@dataclass
class EncounterNoteDrafts:
    store: FhirStore = field(default_factory=SqlFhirStore)
    repo: EncounterRepository = field(default_factory=SqlEncounterRepository)
    notes: NoteRepository = field(default_factory=SqlNoteRepository)

    async def ready(self, db: AsyncSession, check: ChartCheck, user: CurrentUser,
                    encounter_id: UUID, note_type_loinc: str) -> EncounterHead:
        """The synchronous checks of createNoteDraft, before any model call."""
        head = await readable(db, self.repo, check, user, encounter_id)
        if await self.notes.user_practitioner(db, user.id) is None:
            raise Forbidden("Only a clinician linked to a practitioner record writes notes",
                            code="permission-denied")
        if ("RN" in user.roles and not user.roles & {"MD", "APP"}
                and note_type_loinc != NURSE_NOTE):
            raise Forbidden("Nurses write nursing notes only", code="permission-denied")
        if head.status not in DRAFTABLE:
            raise _state(head.status)
        return head

    async def create_ai_draft(self, db: AsyncSession, draft: AIDraftIn) -> DraftWritten:
        head = await self.repo.head(db, draft.encounter_id, lock=True)   # 404 if not visible
        if head.status not in DRAFTABLE:
            raise _state(head.status)
        if head.status in ("arrived", "triaged"):   # the first note starts the visit (§5.2)
            await self.store.set_encounter_status(db, draft.encounter_id, "in-progress")
            await publish(db, "encounter.status-changed", f"encounter/{draft.encounter_id}",
                          {"status": "in-progress"}, facility_id=head.facility_id,
                          patient_id=head.patient_id)
        try:
            written = await self.store.create_note(db, NoteIn(
                encounter_id=draft.encounter_id,
                note_type=Coded(system=systems.LOINC, code=draft.note_type_loinc),
                title=draft.title, template_id=draft.template_id,
                sections=tuple(SectionIn(code=s.code, title=s.title, text=s.text)
                               for s in draft.sections)))
        except ResourceNotFound as gone:
            raise NotFound() from gone
        except InvalidTransition as done:
            raise _state(done.current_state) from done
        sections = await repository.mark_ai_drafted(db, written.id, draft.suggestions)
        return DraftWritten(note_id=written.id, version=written.version,
                            sections=tuple(sections.items()))

    async def section_for_decision(self, db: AsyncSession, check: ChartCheck,
                                   user: CurrentUser, section_id: UUID) -> SectionForDecision:
        row = (await db.execute(_SECTION, {"id": section_id})).mappings().first()
        note = await self.notes.head(db, row["composition_id"]) if row else None
        if row is None or note is None or (note.status == "preliminary"
                                           and signed_notes_only(user)):
            raise NotFound()
        await readable(db, self.repo, check, user, note.encounter_id)
        practitioner = await self.notes.user_practitioner(db, user.id)
        if practitioner is None or practitioner != note.author_id:
            raise Forbidden("Only the note's author decides its AI sections",
                            code="permission-denied")
        locked = await self.notes.head(db, note.id, lock=True)
        if locked is None:
            raise NotFound()
        if locked.status in ("final", "amended"):
            raise Conflict("The note is signed: changes go in an addendum", code="record-locked")
        if locked.status != "preliminary":
            raise _state(locked.status)
        found = next((s for s in await self.notes.sections(db, locked) if s.id == section_id),
                     None)
        if found is None:
            raise NotFound()
        return SectionForDecision(note_id=locked.id, patient_id=locked.patient_id,
                                  encounter_id=locked.encounter_id,
                                  code=row["code_code"] or "", text=found.text)
