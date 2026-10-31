"""The after-visit summary (inventory #86; FRS FR-ENC-06; D98): the PDF and its document.

The encounters service (Vimal's ``createAfterVisitSummary``) gathers the visit from a signed
note and hands it over as ``AfterVisitSummaryDetails``; this module makes the PDF, stores it
through the file service (purpose ``after-visit-summary``, clean from the start) and records it
as a DocumentReference, in the caller's transaction. ``latest()`` is what the front desk's
download link reads (``getAfterVisitSummaryDownloadUrl``).

**The document** (proposed on #85, for Vimal's OK): status ``current``, type LOINC ``34133-9``
(Summary of episode note, the visit summary's code), US Core category ``clinical-note``,
origin ``generated``, the patient, the encounter, the signed note it came from
(``ext_composition_id``), the author (the practitioner who generated it) and one content row
pointing at the stored PDF. Generating again makes a new document; ``latest()`` gives the
newest current one.

The PDF shows only what the patient needs: the practice, the patient's name, the visit's date
in the facility's time zone (D40), the clinician, the reason for the visit, the diagnoses, the
medications with their instructions, the orders, the patient instructions (LOINC 69730-0, D73)
and the follow-up. Synthetic data only in tests.
"""

from __future__ import annotations

import textwrap
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MAPPERS, systems
from app.modules.files.storage import FileStore, store_generated

from . import pdf

PURPOSE = "after-visit-summary"
TYPE_CODE = ("34133-9", "Summary of episode note")
CATEGORY_CODE = ("clinical-note", "Clinical Note")
_WRAP = 85  # characters per line at 11 pt

M = MAPPERS


@dataclass(frozen=True)
class Medication:
    name: str
    instructions: str | None = None


@dataclass(frozen=True)
class AfterVisitSummaryDetails:
    practice_name: str
    patient_name: str
    visit_start: datetime  # aware
    time_zone: str  # the facility's IANA zone (D40)
    clinician_name: str
    facility_name: str | None = None
    reason_for_visit: str | None = None
    diagnoses: tuple[str, ...] = ()
    medications: tuple[Medication, ...] = ()
    orders: tuple[str, ...] = ()
    instructions: str | None = None  # the note's patient instructions section
    follow_up: str | None = None


def format_visit_date(moment: datetime, time_zone: str) -> str:
    """``November 3, 2026`` in the facility's zone (UTC if the zone is unknown)."""
    try:
        local = moment.astimezone(ZoneInfo(time_zone))
    except (ZoneInfoNotFoundError, ValueError):
        local = moment
    return f"{local:%B} {local.day}, {local.year}"


def _wrapped(value: str, indent: str = "") -> list[pdf.Line]:
    width = _WRAP - len(indent)
    paragraphs = [" ".join(p.split()) for p in value.splitlines()]
    out: list[pdf.Line] = []
    for paragraph in paragraphs:
        for row in textwrap.wrap(paragraph, width) or [""]:
            out.append(("F1", 11, indent + row))
    return out


def _section(title: str, rows: list[pdf.Line]) -> list[pdf.Line]:
    if not rows:
        return []
    return [("F1", 11, ""), ("F2", 12, title), *rows]


def lines(details: AfterVisitSummaryDetails) -> list[pdf.Line]:
    """The summary's lines, top to bottom. A section with nothing in it is left out."""
    out: list[pdf.Line] = [
        ("F2", 18, details.practice_name),
        ("F1", 14, "After-visit summary"),
        ("F1", 11, ""),
        ("F1", 11, f"Patient: {details.patient_name}"),
        ("F1", 11, f"Visit date: {format_visit_date(details.visit_start, details.time_zone)}"),
        ("F1", 11, f"Seen by: {details.clinician_name}"),
    ]
    if details.facility_name:
        out.append(("F1", 11, f"Location: {details.facility_name}"))
    if details.reason_for_visit:
        out += _section("Reason for your visit", _wrapped(details.reason_for_visit))
    out += _section("Diagnoses", [r for d in details.diagnoses for r in _wrapped(f"- {d}")])
    medications: list[pdf.Line] = []
    for med in details.medications:
        medications += _wrapped(f"- {med.name}")
        if med.instructions:
            medications += _wrapped(med.instructions, indent="    ")
    out += _section("Your medications", medications)
    out += _section("Orders", [r for o in details.orders for r in _wrapped(f"- {o}")])
    if details.instructions:
        out += _section("Instructions", _wrapped(details.instructions))
    if details.follow_up:
        out += _section("Follow-up", _wrapped(details.follow_up))
    out += [("F1", 11, ""),
            ("F1", 9, "If you have questions about this summary, please call the practice.")]
    return out


def render(details: AfterVisitSummaryDetails) -> bytes:
    """The summary as PDF bytes. The same details always give the same bytes."""
    return pdf.render(lines(details))


@dataclass(frozen=True)
class StoredSummary:
    document_id: UUID
    file_id: UUID
    generated_at: datetime


async def store(db: AsyncSession, file_store: FileStore, *, patient_id: UUID,
                encounter_id: UUID, note_id: UUID, author_practitioner_id: UUID,
                details: AfterVisitSummaryDetails) -> StoredSummary:
    """Render, store and record the summary in the caller's transaction; never commits."""
    data = render(details)
    file_id = await store_generated(db, file_store, purpose=PURPOSE,
                                    content_type=pdf.CONTENT_TYPE, data=data)
    now: datetime = (await db.execute(text("SELECT now()"))).scalar_one()
    user = (await db.execute(text(
        "SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid"))).scalar_one()
    doc = M["document_reference"](
        status="current", type_system=systems.LOINC, type_code=TYPE_CODE[0],
        type_display=TYPE_CODE[1], subject_patient_id=patient_id, date=now,
        description="After-visit summary", context_encounter_id=encounter_id,
        ext_origin="generated", ext_composition_id=note_id, created_by_user_id=user)
    doc.category = [M["document_reference_category"](
        category_system=systems.DOC_CLASS, category_code=CATEGORY_CODE[0],
        category_display=CATEGORY_CODE[1])]
    doc.author = [M["document_reference_author"](practitioner_id=author_practitioner_id)]
    doc.content = [M["document_reference_content"](
        attachment_content_type=pdf.CONTENT_TYPE, attachment_binary_object_id=file_id,
        attachment_title="After-visit summary", attachment_creation=now)]
    db.add(doc)
    await db.flush()
    return StoredSummary(document_id=doc.id, file_id=file_id, generated_at=now)


async def latest(db: AsyncSession, encounter_id: UUID) -> StoredSummary | None:
    """The encounter's newest current after-visit summary, or None (the download link's 404)."""
    doc_cls, content_cls = M["document_reference"], M["document_reference_content"]
    row = (await db.execute(
        select(doc_cls.id, content_cls.attachment_binary_object_id, doc_cls.date)
        .join(content_cls, content_cls.document_reference_id == doc_cls.id)
        .where(doc_cls.context_encounter_id == encounter_id, doc_cls.status == "current",
               doc_cls.ext_origin == "generated", doc_cls.type_system == systems.LOINC,
               doc_cls.type_code == TYPE_CODE[0])
        .order_by(doc_cls.date.desc(), doc_cls.id).limit(1))).one_or_none()
    if row is None:
        return None
    return StoredSummary(document_id=row[0], file_id=row[1], generated_at=row[2])
