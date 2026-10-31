"""Note reads, under the request's session (row-level security: another clinic's note is simply
not found). Writes go through Anand's note helpers (``create_note``, ``update_note``,
``sign_note``, ``add_note_addendum``, ``cosign_note``, ``return_note_to_author``).

How the contract's Note is read from the Composition tables (``db/CLAUDE.md``):
- an addendum is its own signed Composition that ``appends`` to the note, so it is never listed
  or read as a note of its own, only in its note's ``addenda``;
- a section's ``required`` is its template section's ``is_required`` (the note keeps its
  template's ID); the one free-text section of a note started without a template is required;
- a section with an AI suggestion is ``ai-generated`` (the database stores ``clinician`` until
  the suggestion is decided), with the suggestion's decision;
- ``signedAt``/``signedBy`` are the legal attester, ``cosignedAt``/``cosignedBy`` the
  professional one;
- versions are the note's ``fhir_resource_history`` snapshots.

Two reads are of other owners' admin tables, read-only: the user's practitioner
(``admin.app_user``) and the co-sign rule that names a co-signer (``admin.cosign_rule``, Anand's
practice setup; its own read service would replace this query).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.fhir_store import section_text

from . import notes_schemas as nschemas
from . import schemas
from .repository import Versioned


@dataclass(frozen=True)
class NoteHead:
    """What the rules need before they read or write a note."""
    id: UUID
    encounter_id: UUID
    patient_id: UUID
    status: str
    version: int
    type_code: str | None
    author_id: UUID | None  # the author's Practitioner
    template_id: UUID | None
    cosign_status: str = "not-required"
    cosigner_id: UUID | None = None  # the Practitioner the co-sign rule named when it was signed


@dataclass(frozen=True)
class SectionHead:
    id: UUID
    sequence: int
    required: bool
    text: str
    ai_decision: str | None


@dataclass(frozen=True)
class NoteCounts:
    signed: int
    drafts: int


class NoteRepository(Protocol):
    async def head(self, db: AsyncSession, note_id: UUID, *, lock: bool = False
                   ) -> NoteHead | None: ...

    async def get(self, db: AsyncSession, note_id: UUID) -> Versioned[nschemas.Note]: ...

    async def sections(self, db: AsyncSession, note: NoteHead) -> list[SectionHead]: ...

    async def for_encounter(self, db: AsyncSession, encounter_id: UUID, *, status: str | None,
                   signed_only: bool, limit: int, offset: int) -> list[schemas.NoteSummary]: ...

    async def versions(self, db: AsyncSession, note_id: UUID, *, signed_only: bool, limit: int,
                       offset: int) -> list[nschemas.NoteVersion]: ...

    async def counts(self, db: AsyncSession, encounter_id: UUID) -> NoteCounts: ...

    async def user_practitioner(self, db: AsyncSession, user_id: UUID) -> UUID | None: ...

    async def cosigner(self, db: AsyncSession, author_id: UUID, facility_id: UUID | None
                       ) -> UUID | None: ...


# A note, never an addendum (a Composition that appends to another).
_HEAD = text("""
SELECT c.id, c.encounter_id, c.subject_patient_id, c.status, c.meta_version_id, c.type_code,
       c.ext_template_id, c.ext_cosign_status, c.ext_cosigner_practitioner_id,
       (SELECT x.practitioner_id FROM clinical.composition_author x
         WHERE x.composition_id = c.id AND x.practitioner_id IS NOT NULL
         ORDER BY x.created_at LIMIT 1) AS author_id
FROM clinical.composition c
WHERE c.id = :id AND c.encounter_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM clinical.composition_relates_to r
                   WHERE r.composition_id = c.id AND r.code = 'appends')
""")
_HEAD_LOCKED = text("""
SELECT c.id, c.encounter_id, c.subject_patient_id, c.status, c.meta_version_id, c.type_code,
       c.ext_template_id, c.ext_cosign_status, c.ext_cosigner_practitioner_id,
       (SELECT x.practitioner_id FROM clinical.composition_author x
         WHERE x.composition_id = c.id AND x.practitioner_id IS NOT NULL
         ORDER BY x.created_at LIMIT 1) AS author_id
FROM clinical.composition c
WHERE c.id = :id AND c.encounter_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM clinical.composition_relates_to r
                   WHERE r.composition_id = c.id AND r.code = 'appends')
FOR UPDATE OF c
""")
_NOTE = text("""
SELECT c.id, c.encounter_id, c.subject_patient_id, c.type_system, c.type_code, c.type_display,
       c.type_text, c.title, c.status, c.ext_cosign_status, c.ext_cosigner_practitioner_id,
       c.ext_template_id, c.ext_is_ai_assisted, c.ext_cosign_return_comment,
       c.ext_cosign_returned_at, c.created_at, c.meta_last_updated, c.meta_version_id,
       (SELECT x.practitioner_id FROM clinical.composition_author x
         WHERE x.composition_id = c.id AND x.practitioner_id IS NOT NULL
         ORDER BY x.created_at LIMIT 1) AS author_id
FROM clinical.composition c WHERE c.id = :id
""")
_SECTIONS = text("""
SELECT s.id, s.code_code, s.title, s.sequence, s.text_div, s.entry_source, s.ai_suggestion_id,
       ai.decision AS ai_decision, ts.is_required
FROM clinical.composition_section s
LEFT JOIN admin.ai_suggestion ai ON ai.id = s.ai_suggestion_id
LEFT JOIN admin.note_template_section ts
       ON ts.template_id = CAST(:template AS uuid) AND ts.section_code = s.code_code
WHERE s.composition_id = :id AND s.parent_section_id IS NULL
ORDER BY s.sequence
""")
_ATTESTERS = text("""
SELECT mode, time, party_practitioner_id FROM clinical.composition_attester
WHERE composition_id = :id ORDER BY time, id
""")
_ADDENDA = text("""
SELECT a.id,
       (SELECT x.practitioner_id FROM clinical.composition_author x
         WHERE x.composition_id = a.id AND x.practitioner_id IS NOT NULL
         ORDER BY x.created_at LIMIT 1) AS author_id,
       (SELECT t.time FROM clinical.composition_attester t
         WHERE t.composition_id = a.id AND t.mode = 'legal' ORDER BY t.time LIMIT 1) AS signed_at,
       (SELECT s.text_div FROM clinical.composition_section s
         WHERE s.composition_id = a.id ORDER BY s.sequence LIMIT 1) AS text_div
FROM clinical.composition a
JOIN clinical.composition_relates_to r ON r.composition_id = a.id AND r.code = 'appends'
WHERE r.target_composition_id = :id AND a.status <> 'entered-in-error'
ORDER BY a.date, a.id
LIMIT 50
""")
_LIST = text("""
SELECT c.id, c.type_system, c.type_code, c.type_display, c.type_text, c.title, c.status,
       c.ext_cosign_status, c.ext_is_ai_assisted, c.meta_last_updated,
       (SELECT a.time FROM clinical.composition_attester a
         WHERE a.composition_id = c.id AND a.mode = 'legal' ORDER BY a.time LIMIT 1) AS signed_at,
       (SELECT x.practitioner_id FROM clinical.composition_author x
         WHERE x.composition_id = c.id AND x.practitioner_id IS NOT NULL
         ORDER BY x.created_at LIMIT 1) AS author_id
FROM clinical.composition c
WHERE c.encounter_id = :e
  AND NOT EXISTS (SELECT 1 FROM clinical.composition_relates_to r
                   WHERE r.composition_id = c.id AND r.code = 'appends')
  AND (CAST(:status AS text) IS NULL OR c.status = CAST(:status AS text))
  AND (NOT :signed_only OR c.status IN ('final', 'amended'))
ORDER BY c.created_at DESC, c.id
LIMIT :limit OFFSET :offset
""")
_VERSIONS = text("""
SELECT h.version_id, h.recorded_at, u.practitioner_id AS by_id, u.display_name AS by_user_name,
       h.snapshot ->> 'status' AS status, h.snapshot ->> 'ext_cosign_status' AS cosign_status,
       h.snapshot ->> 'title' AS title,
       h.snapshot -> '_children' -> 'composition_section' AS sections
FROM clinical.fhir_resource_history h
LEFT JOIN admin.app_user u ON u.id = h.recorded_by_user_id
WHERE h.resource_type = 'Composition' AND h.resource_id = :id
  AND (NOT :signed_only OR h.snapshot ->> 'status' <> 'preliminary')
ORDER BY h.version_id DESC
LIMIT :limit OFFSET :offset
""")
_COUNTS = text("""
SELECT count(*) FILTER (WHERE c.status IN ('final', 'amended')) AS signed,
       count(*) FILTER (WHERE c.status = 'preliminary') AS drafts
FROM clinical.composition c
WHERE c.encounter_id = :e
  AND NOT EXISTS (SELECT 1 FROM clinical.composition_relates_to r
                   WHERE r.composition_id = c.id AND r.code = 'appends')
""")
_NAMES = text("""
SELECT n.practitioner_id,
       concat_ws(' ', array_to_string(n.prefix, ' '), array_to_string(n.given, ' '), n.family,
                 array_to_string(n.suffix, ' ')) AS name
FROM clinical.human_name n WHERE n.practitioner_id = ANY(:ids)
ORDER BY n.practitioner_id, (n.use = 'official') DESC, n.created_at
""")
_USER_PRACTITIONER = text("SELECT practitioner_id FROM admin.app_user WHERE id = :id")
# The co-sign rule for the author, in force today, for notes, with no state or the state of the
# facility's address (FRS FR-ENC-01); a rule for the state wins over one for every state.
_COSIGNER = text("""
SELECT r.supervising_practitioner_id FROM admin.cosign_rule r
WHERE r.supervisee_practitioner_id = :author AND r.applies_to_notes
  AND r.effective_from <= current_date
  AND (r.effective_to IS NULL OR r.effective_to >= current_date)
  AND (r.state IS NULL OR r.state IN (
        SELECT a.state FROM admin.facility f JOIN clinical.address a
            ON a.location_id = f.location_id
         WHERE f.id = CAST(:facility AS uuid)))
ORDER BY (r.state IS NULL), r.effective_from DESC, r.id
LIMIT 1
""")

NURSE_NOTE = "34746-8"


def _text(div: str | None) -> str:
    return section_text(div)


async def _names(db: AsyncSession, ids: Iterable[UUID | None]) -> dict[UUID, str]:
    wanted = sorted({i for i in ids if i is not None}, key=str)
    if not wanted:
        return {}
    names: dict[UUID, str] = {}
    for practitioner_id, name in (await db.execute(_NAMES, {"ids": wanted})).all():
        names.setdefault(practitioner_id, " ".join((name or "").split()))
    return names


def _ref(names: dict[UUID, str], practitioner_id: UUID | None, fallback: str | None = None
         ) -> schemas.ClinicianRef | None:
    if practitioner_id is None:
        return None
    name = names.get(practitioner_id) or " ".join((fallback or "").split())
    return schemas.ClinicianRef(id=practitioner_id, display_name=name or "Unnamed clinician")


def _coded(system: str | None, code: str | None, display: str | None, txt: str | None
           ) -> schemas.CodeableConcept:
    codings = [schemas.Coding(system=system, code=code, display=display)] if (
        system and code) else []
    return schemas.CodeableConcept(codings=codings, text=txt)


def _head(r: Any) -> NoteHead:
    return NoteHead(r["id"], r["encounter_id"], r["subject_patient_id"], r["status"],
                    r["meta_version_id"], r["type_code"], r["author_id"], r["ext_template_id"],
                    r["ext_cosign_status"] or "not-required", r["ext_cosigner_practitioner_id"])


def _entry_source(source: str | None, ai_suggestion_id: UUID | None) -> str:
    if ai_suggestion_id is not None:
        return "ai-generated"
    return source if source in ("clinician", "ai-generated", "imported") else "clinician"


class SqlNoteRepository:
    async def head(self, db: AsyncSession, note_id: UUID, *, lock: bool = False
                   ) -> NoteHead | None:
        r = (await db.execute(_HEAD_LOCKED if lock else _HEAD, {"id": note_id})
             ).mappings().first()
        return _head(r) if r else None

    async def _section_rows(self, db: AsyncSession, note_id: UUID, template_id: UUID | None
                            ) -> list[Any]:
        return list((await db.execute(_SECTIONS, {"id": note_id, "template": template_id})
                     ).mappings())

    async def sections(self, db: AsyncSession, note: NoteHead) -> list[SectionHead]:
        return [SectionHead(r["id"], r["sequence"],
                            bool(r["is_required"]) if note.template_id else True,
                            _text(r["text_div"]),
                            r["ai_decision"] if r["ai_suggestion_id"] else None)
                for r in await self._section_rows(db, note.id, note.template_id)]

    async def get(self, db: AsyncSession, note_id: UUID) -> Versioned[nschemas.Note]:
        n = (await db.execute(_NOTE, {"id": note_id})).mappings().one()
        sections = await self._section_rows(db, note_id, n["ext_template_id"])
        attesters = (await db.execute(_ATTESTERS, {"id": note_id})).mappings().all()
        addenda = (await db.execute(_ADDENDA, {"id": note_id})).mappings().all()
        legal = next((a for a in attesters if a["mode"] == "legal"), None)
        professional = next((a for a in attesters if a["mode"] == "professional"), None)
        names = await _names(db, [n["author_id"], n["ext_cosigner_practitioner_id"],
                                  legal["party_practitioner_id"] if legal else None,
                                  professional["party_practitioner_id"] if professional else None,
                                  *(a["author_id"] for a in addenda)])
        cosigner = _ref(names, n["ext_cosigner_practitioner_id"])
        author = _ref(names, n["author_id"])
        if author is None:  # the note helpers always name a practitioner author
            raise RuntimeError("a note without a practitioner author")
        cosign_return = None
        if n["ext_cosign_status"] == "returned" and cosigner is not None:
            cosign_return = nschemas.CosignReturn(comment=n["ext_cosign_return_comment"],
                                                  returned_at=n["ext_cosign_returned_at"],
                                                  returned_by=cosigner)
        note = nschemas.Note(
            id=n["id"], encounter_id=n["encounter_id"], patient_id=n["subject_patient_id"],
            note_type=_coded(n["type_system"], n["type_code"], n["type_display"],
                             n["type_text"]),
            title=n["title"], status=n["status"], cosign_status=n["ext_cosign_status"],
            cosigner=cosigner, template_id=n["ext_template_id"], author=author,
            ai_assisted=bool(n["ext_is_ai_assisted"]),
            sections=[nschemas.NoteSection(
                id=s["id"], code=s["code_code"] or "", title=s["title"] or "",
                sequence=s["sequence"],
                required=bool(s["is_required"]) if n["ext_template_id"] else True,
                text=_text(s["text_div"]),
                entry_source=_entry_source(s["entry_source"], s["ai_suggestion_id"]),
                ai_suggestion_id=s["ai_suggestion_id"],
                ai_decision=s["ai_decision"] if s["ai_suggestion_id"] else None)
                for s in sections],
            addenda=[nschemas.NoteAddendum(
                id=a["id"], text=_text(a["text_div"]),
                author=_ref(names, a["author_id"]) or author, signed_at=a["signed_at"])
                for a in addenda if a["signed_at"] is not None],
            signed_at=legal["time"] if legal else None,
            signed_by=_ref(names, legal["party_practitioner_id"]) if legal else None,
            cosigned_at=professional["time"] if professional else None,
            cosigned_by=(_ref(names, professional["party_practitioner_id"])
                         if professional else None),
            cosign_return=cosign_return, created_at=n["created_at"],
            updated_at=n["meta_last_updated"])
        return Versioned(note, n["meta_version_id"])

    async def for_encounter(self, db: AsyncSession, encounter_id: UUID, *, status: str | None,
                   signed_only: bool, limit: int, offset: int) -> list[schemas.NoteSummary]:
        rows = (await db.execute(_LIST, {"e": encounter_id, "status": status,
                                         "signed_only": signed_only, "limit": limit,
                                         "offset": offset})).mappings().all()
        names = await _names(db, (r["author_id"] for r in rows))
        out = []
        for r in rows:
            author = _ref(names, r["author_id"])
            if author is None:
                continue  # a note always has a practitioner author (the notes helpers)
            out.append(schemas.NoteSummary(
                id=r["id"], note_type=_coded(r["type_system"], r["type_code"],
                                             r["type_display"], r["type_text"]),
                title=r["title"], status=r["status"], cosign_status=r["ext_cosign_status"],
                author=author, ai_assisted=bool(r["ext_is_ai_assisted"]),
                signed_at=r["signed_at"], updated_at=r["meta_last_updated"]))
        return out

    async def versions(self, db: AsyncSession, note_id: UUID, *, signed_only: bool, limit: int,
                       offset: int) -> list[nschemas.NoteVersion]:
        rows = (await db.execute(_VERSIONS, {"id": note_id, "signed_only": signed_only,
                                             "limit": limit, "offset": offset})).mappings().all()
        names = await _names(db, (r["by_id"] for r in rows))
        return [nschemas.NoteVersion(
            version_id=r["version_id"], recorded_at=r["recorded_at"],
            recorded_by=_ref(names, r["by_id"], r["by_user_name"]), status=r["status"],
            cosign_status=r["cosign_status"] or "not-required", title=r["title"] or "",
            sections=_version_sections(r["sections"] or []))
            for r in rows]

    async def counts(self, db: AsyncSession, encounter_id: UUID) -> NoteCounts:
        r = (await db.execute(_COUNTS, {"e": encounter_id})).one()
        return NoteCounts(r[0], r[1])

    async def user_practitioner(self, db: AsyncSession, user_id: UUID) -> UUID | None:
        found: UUID | None = (await db.execute(_USER_PRACTITIONER, {"id": user_id})
                              ).scalar_one_or_none()
        return found

    async def cosigner(self, db: AsyncSession, author_id: UUID, facility_id: UUID | None
                       ) -> UUID | None:
        found: UUID | None = (await db.execute(_COSIGNER, {"author": author_id,
                                                           "facility": facility_id})
                              ).scalar_one_or_none()
        return found


def _version_sections(raw: Sequence[dict[str, Any]]) -> list[nschemas.NoteVersionSection]:
    top = [s for s in raw if not s.get("parent_section_id")]
    return [nschemas.NoteVersionSection(code=s.get("code_code") or "", title=s.get("title") or "",
                                        text=_text(s.get("text_div")))
            for s in sorted(top, key=lambda s: s.get("sequence") or 0)]
