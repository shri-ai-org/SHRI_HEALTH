"""In-memory stand-ins for the diagnoses and notes reads, their write helpers and the note
templates, on top of fakes.py's World, so the API tests need no database (test_notes_live.py
covers the real ones). Like the real pieces where the API depends on it: every write moves the
version, a signed note is frozen, and an addendum makes it amended. Synthetic data only."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.fhir_store import (
    UNSET,
    AddendumWritten,
    DiagnosisIn,
    DiagnosisWritten,
    InvalidTransition,
    NoteChanges,
    NoteIn,
    Reason,
    ResourceNotFound,
    StaleVersion,
    Written,
)

from .. import notes_schemas as nschemas
from .. import schemas
from ..diagnoses_repository import Concept, LiveDiagnosis
from ..notes_repository import NoteCounts, NoteHead, SectionHead
from ..notes_service import TemplateIn
from ..repository import Versioned
from .fakes import DOCTOR, NOW, FakeStore, World

ICD10CM = "http://hl7.org/fhir/sid/icd-10-cm"
TEMPLATE = UUID("1d2e3f4a-5b6c-4d7e-8f8a-9b0c1d2e3f4a")
CONCEPTS = {"I10": Concept("I10", "Essential (primary) hypertension", True),
            "E11": Concept("E11", "Type 2 diabetes mellitus", False)}
#: Dev users linked to a practitioner (the md dev user is the doctor).
LINKED = {"MD": DOCTOR}


@dataclass
class FakeDiagnosis:
    id: UUID
    encounter_id: UUID
    code: str
    display: str
    rank: int | None
    status: str = "confirmed"
    version: int = 1


@dataclass
class FakeSection:
    id: UUID
    code: str
    title: str
    required: bool
    text: str = ""


@dataclass
class FakeNote:
    id: UUID
    encounter_id: UUID
    patient_id: UUID
    title: str
    type_code: str
    author: UUID
    sections: list[FakeSection]
    template_id: UUID | None
    status: str = "preliminary"
    version: int = 1
    addenda: list[str] = field(default_factory=list)
    versions: list[str] = field(default_factory=list)
    cosign_status: str = "not-required"
    cosigner: UUID | None = None  # the co-signer's practitioner, named when it was signed
    cosign_comment: str | None = None


@dataclass
class NotesWorld:
    base: World
    diagnoses: dict[UUID, FakeDiagnosis] = field(default_factory=dict)
    notes: dict[UUID, FakeNote] = field(default_factory=dict)
    practitioners: dict[UUID, UUID] = field(default_factory=dict)  # user -> practitioner
    published: list[tuple[str, str]] = field(default_factory=list)  # (type, subject)

    async def template(self, db: AsyncSession, template_id: UUID) -> TemplateIn | None:
        if template_id != TEMPLATE:
            return None
        return TemplateIn(id=TEMPLATE, name="Follow-up visit", note_type_loinc="11506-3",
                          active=True, owner_user_id=None,
                          sections=((1, "10154-3", "Chief complaint", None),
                                    (2, "69730-0", "Patient instructions", "Rest.")))


class FakeDiagnosisRepository:
    def __init__(self, world: NotesWorld) -> None:
        self.world = world

    async def icd10cm(self, db: Any, code: str) -> Concept | None:
        return CONCEPTS.get(code)

    async def encounter_signed(self, db: Any, encounter_id: UUID) -> bool:
        return any(n.encounter_id == encounter_id and n.status in ("final", "amended")
                   for n in self.world.notes.values())

    async def live(self, db: Any, encounter_id: UUID) -> list[LiveDiagnosis]:
        return sorted((LiveDiagnosis(d.id, ICD10CM, d.code, d.rank)
                       for d in self.world.diagnoses.values()
                       if d.encounter_id == encounter_id and d.rank is not None),
                      key=lambda d: d.rank)

    async def get(self, db: Any, encounter_id: UUID, diagnosis_id: UUID
                  ) -> Versioned[schemas.EncounterDiagnosis] | None:
        d = self.world.diagnoses.get(diagnosis_id)
        if d is None or d.encounter_id != encounter_id:
            return None
        return Versioned(schemas.EncounterDiagnosis(
            id=d.id, encounter_id=d.encounter_id, rank=d.rank,
            code=schemas.Coding(system=ICD10CM, code=d.code, display=d.display),
            verification_status=d.status, entry_source="clinician", recorded_at=NOW),
            d.version)


class FakeNoteRepository:
    def __init__(self, world: NotesWorld) -> None:
        self.world = world

    def _head(self, n: FakeNote) -> NoteHead:
        return NoteHead(n.id, n.encounter_id, n.patient_id, n.status, n.version, n.type_code,
                        n.author, n.template_id, n.cosign_status, n.cosigner)

    async def head(self, db: Any, note_id: UUID, *, lock: bool = False) -> NoteHead | None:
        n = self.world.notes.get(note_id)
        if n is None or self.world.base.encounters[n.encounter_id].clinic != db.tenant_id:
            return None
        return self._head(n)

    async def get(self, db: Any, note_id: UUID) -> Versioned[nschemas.Note]:
        n = self.world.notes[note_id]
        author = schemas.ClinicianRef(id=n.author, display_name="Dr. Test")
        cosigner = (schemas.ClinicianRef(id=n.cosigner, display_name="Dr. Supervisor")
                    if n.cosigner else None)
        cosigned = n.cosign_status == "cosigned"
        return Versioned(nschemas.Note(
            id=n.id, encounter_id=n.encounter_id, patient_id=n.patient_id,
            note_type=schemas.CodeableConcept(codings=[schemas.Coding(
                system="http://loinc.org", code=n.type_code)]),
            title=n.title, status=n.status, cosign_status=n.cosign_status, cosigner=cosigner,
            template_id=n.template_id, author=author, ai_assisted=False,
            sections=[nschemas.NoteSection(id=s.id, code=s.code, title=s.title, sequence=i,
                                           required=s.required, text=s.text,
                                           entry_source="clinician")
                      for i, s in enumerate(n.sections, start=1)],
            addenda=[nschemas.NoteAddendum(id=uuid.uuid4(), text=t, author=author,
                                           signed_at=NOW) for t in n.addenda],
            signed_at=NOW if n.status != "preliminary" else None,
            cosigned_at=NOW if cosigned else None, cosigned_by=cosigner if cosigned else None,
            cosign_return=nschemas.CosignReturn(comment=n.cosign_comment, returned_at=NOW,
                                                returned_by=cosigner)
            if n.cosign_status == "returned" and n.cosign_comment and cosigner else None,
            created_at=NOW, updated_at=NOW), n.version)

    async def sections(self, db: Any, note: NoteHead) -> list[SectionHead]:
        return [SectionHead(s.id, i, s.required, s.text, None)
                for i, s in enumerate(self.world.notes[note.id].sections, start=1)]

    async def for_encounter(self, db: Any, encounter_id: UUID, *, status: str | None,
                            signed_only: bool, limit: int, offset: int
                            ) -> list[schemas.NoteSummary]:
        found = [n for n in self.world.notes.values() if n.encounter_id == encounter_id
                 and (status is None or n.status == status)
                 and (not signed_only or n.status in ("final", "amended"))]
        return [schemas.NoteSummary(
            id=n.id, note_type=schemas.CodeableConcept(text=n.type_code), title=n.title,
            status=n.status, cosign_status="not-required",
            author=schemas.ClinicianRef(id=n.author, display_name="Dr. Test"),
            ai_assisted=False, updated_at=NOW) for n in found][offset:offset + limit]

    async def versions(self, db: Any, note_id: UUID, *, signed_only: bool, limit: int,
                       offset: int) -> list[nschemas.NoteVersion]:
        n = self.world.notes[note_id]
        out = [nschemas.NoteVersion(version_id=i, recorded_at=NOW, status=status,
                                    cosign_status="not-required", title=n.title, sections=[])
               for i, status in enumerate(n.versions, start=1)
               if not signed_only or status != "preliminary"]
        return list(reversed(out))[offset:offset + limit]

    async def counts(self, db: Any, encounter_id: UUID) -> NoteCounts:
        notes = [n for n in self.world.notes.values() if n.encounter_id == encounter_id]
        return NoteCounts(sum(n.status in ("final", "amended") for n in notes),
                          sum(n.status == "preliminary" for n in notes))

    async def user_practitioner(self, db: Any, user_id: UUID) -> UUID | None:
        return self.world.practitioners.get(user_id)

    async def cosigner(self, db: Any, author_id: UUID, facility_id: UUID | None
                       ) -> UUID | None:
        return None


class FakeClinicalStore(FakeStore):
    """FakeStore plus the diagnosis, note and encounter-status helpers."""

    def __init__(self, world: NotesWorld) -> None:
        super().__init__(world.base)
        self.notes_world = world

    def _note(self, note_id: UUID, if_version: int | None) -> FakeNote:
        n = self.notes_world.notes.get(note_id)
        if n is None:
            raise ResourceNotFound
        if if_version is not None and n.version != if_version:
            raise StaleVersion(n.version)
        return n

    def _bump(self, n: FakeNote) -> Written:
        n.version += 1
        n.versions.append(n.status)
        return Written(n.id, n.version, NOW)

    async def set_encounter_status(self, db: Any, encounter_id: UUID, status: str,
                                   **kw: Any) -> Written:
        e = self.world.encounters[encounter_id]
        e.status, e.version = status, e.version + 1
        return Written(encounter_id, e.version, NOW)

    async def add_encounter_diagnosis(self, db: Any, encounter_id: UUID, data: DiagnosisIn
                                      ) -> DiagnosisWritten:
        live = [d for d in self.notes_world.diagnoses.values()
                if d.encounter_id == encounter_id and d.rank is not None]
        rank = data.rank or len(live) + 1
        for d in live:
            if d.rank is not None and d.rank >= rank:
                d.rank += 1
        d = FakeDiagnosis(uuid.uuid4(), encounter_id, data.code.code or "",
                          data.code.display or "", rank)
        self.notes_world.diagnoses[d.id] = d
        e = self.world.encounters[encounter_id]
        return DiagnosisWritten(Written(d.id, 1, NOW), Written(encounter_id, e.version, NOW),
                                rank)

    async def remove_encounter_diagnosis(self, db: Any, encounter_id: UUID,
                                         condition_id: UUID, reason: Reason) -> Written:
        d = self.notes_world.diagnoses[condition_id]
        removed, d.rank, d.status, d.version = d.rank, None, "entered-in-error", d.version + 1
        for other in self.notes_world.diagnoses.values():
            if other.encounter_id == encounter_id and other.rank and removed \
                    and other.rank > removed:
                other.rank -= 1
        return Written(encounter_id, 1, NOW)

    async def create_note(self, db: Any, data: NoteIn) -> Written:
        e = self.world.encounters[data.encounter_id]
        n = FakeNote(uuid.uuid4(), data.encounter_id, e.patient_id, data.title,
                     data.note_type.code or "", DOCTOR,
                     [FakeSection(uuid.uuid4(), s.code, s.title, data.template_id is None
                                  or s.code == "10154-3", s.text) for s in data.sections],
                     data.template_id, versions=["preliminary"])
        self.notes_world.notes[n.id] = n
        return Written(n.id, n.version, NOW)

    async def update_note(self, db: Any, note_id: UUID, changes: NoteChanges, *,
                          if_version: int) -> Written:
        n = self._note(note_id, if_version)
        if n.status != "preliminary":
            raise InvalidTransition(n.status)
        if changes.title is not UNSET:
            n.title = str(changes.title)
        texts = {s.id: s.text for s in changes.sections}
        for s in n.sections:
            s.text = texts.get(s.id, s.text)
        return self._bump(n)

    async def sign_note(self, db: Any, note_id: UUID, *, if_version: int,
                        cosigner_practitioner_id: UUID | None = None) -> Written:
        n = self._note(note_id, if_version)
        n.status = "final"
        return self._bump(n)

    async def add_note_addendum(self, db: Any, note_id: UUID, text: str, *,
                                if_version: int) -> AddendumWritten:
        n = self._note(note_id, if_version)
        n.status = "amended"
        n.addenda.append(text)
        if n.cosign_status == "returned":  # the author's answer: waiting again (D73)
            n.cosign_status, n.cosign_comment = "pending", None
        return AddendumWritten(Written(uuid.uuid4(), 1, NOW), self._bump(n))

    def _pending(self, note_id: UUID, if_version: int) -> FakeNote:
        """As the helper: signed and waiting for its co-signature (the real one also checks
        that the current user is the named co-signer, which the fakes leave to the service)."""
        n = self._note(note_id, if_version)
        if n.status not in ("final", "amended"):
            raise InvalidTransition(n.status)
        if n.cosign_status != "pending":
            raise InvalidTransition(n.cosign_status)
        return n

    async def cosign_note(self, db: Any, note_id: UUID, *, if_version: int) -> Written:
        n = self._pending(note_id, if_version)
        n.cosign_status = "cosigned"
        return self._bump(n)

    async def return_note_to_author(self, db: Any, note_id: UUID, comment: str, *,
                                    if_version: int) -> Written:
        n = self._pending(note_id, if_version)
        n.cosign_status, n.cosign_comment = "returned", comment
        return self._bump(n)
