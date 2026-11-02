"""AI-01 drafts as notes (D70): the encounters side of the AI gateway's ``NoteDrafts`` port
(``app.modules.ai.service``).

The gateway hands over the template's sections, the AI text for some of them, and the AI
suggestion they came from. This writes an unsigned note (``preliminary``) through Anand's note
helper, in the request's transaction, and links the AI sections to the suggestion, which marks
them ``ai-generated`` on read. The author is the requesting clinician's practitioner, as for any
note. Nothing here signs: signing stays the author's act through the notes service, and the
database refuses it until each AI section's suggestion is accepted or edited.

Only an open visit takes a draft (the notes service's rule, ``notes_service.CLOSED`` in #165):
a finished, cancelled or entered-in-error encounter is ``409 invalid-state-transition``.
When #165 lands, the encounter's first note moving it to ``in-progress`` belongs here too.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
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
from .repository import EncounterRepository, SqlEncounterRepository

#: A note is started only while the visit is open.
CLOSED = ("finished", "cancelled", "entered-in-error")


@dataclass
class EncounterNoteDrafts:
    store: FhirStore = field(default_factory=SqlFhirStore)
    repo: EncounterRepository = field(default_factory=SqlEncounterRepository)

    async def create_ai_draft(self, db: AsyncSession, draft: AIDraftIn) -> DraftWritten:
        head = await self.repo.head(db, draft.encounter_id, lock=True)   # 404 if not visible
        if head.status in CLOSED:
            raise Conflict(code="invalid-state-transition", currentState=head.status)
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
            raise Conflict(code="invalid-state-transition",
                           currentState=done.current_state) from done
        await repository.mark_ai_drafted(db, written.id, draft.suggestion_id,
                                         [s.code for s in draft.sections if s.text.strip()])
        return DraftWritten(note_id=written.id, version=written.version)
