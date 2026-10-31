"""The after-visit summary: its PDF, and storing it with its DocumentReference in the caller's
transaction (a real database, as shri_app). Synthetic data only."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine

from app.core.db import Database
from app.db import fhir_store as fs
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, admin_engine, app_engine  # noqa: F401
from app.db.tests.test_fhir_store import _rows, clinic, database, session  # noqa: F401
from app.db.tests.test_fhir_store_visits import _facility, _visit  # noqa: F401
from app.modules.files.storage import LocalFileStore

from .. import after_visit_summary as avs
from .. import pdf

STORE = fs.SqlFhirStore()
DETAILS = avs.AfterVisitSummaryDetails(
    practice_name="Riverbend Family Medicine (synthetic)", patient_name="Mai Nguyen",
    visit_start=datetime(2026, 11, 3, 15, 30, tzinfo=UTC), time_zone="America/Chicago",
    clinician_name="Dr. Elena Rivera", facility_name="Main office",
    reason_for_visit="Headaches for two weeks",
    diagnoses=("Migraine without aura (G43.009)",),
    medications=(avs.Medication("Sumatriptan 50 mg tablet",
                                "Take 1 tablet at the start of a migraine."),),
    orders=("Basic metabolic panel",), instructions="Rest in a dark room.\nDrink water.",
    follow_up="In 4 weeks, with Dr. Rivera")


def _text(data: bytes) -> list[str]:
    return [m.decode("cp1252") for m in re.findall(rb"\((.*?)\) Tj", data)]


# ====================================================================== the PDF
def test_the_summary_shows_what_the_patient_needs() -> None:
    shown = _text(avs.render(DETAILS))
    for expected in ("After-visit summary", "Patient: Mai Nguyen",
                     "Visit date: November 3, 2026", "Seen by: Dr. Elena Rivera",
                     "Location: Main office", "Diagnoses", "- Migraine without aura \\(G43.009\\)",
                     "- Sumatriptan 50 mg tablet",
                     "    Take 1 tablet at the start of a migraine.", "Orders",
                     "Rest in a dark room.", "Drink water.", "In 4 weeks, with Dr. Rivera"):
        assert expected in shown, expected


def test_empty_sections_are_left_out_and_dates_use_the_facility_zone() -> None:
    bare = avs.AfterVisitSummaryDetails(
        practice_name="P", patient_name="Mai Nguyen", clinician_name="Dr. R",
        visit_start=datetime(2026, 11, 4, 2, 0, tzinfo=UTC), time_zone="America/Chicago")
    shown = _text(avs.render(bare))
    assert "Visit date: November 3, 2026" in shown  # 8 pm the evening before, in Chicago
    assert not {"Diagnoses", "Your medications", "Orders", "Instructions", "Follow-up"} & set(
        shown)


def test_a_valid_pdf_with_no_metadata_and_the_same_bytes_each_time() -> None:
    data = avs.render(DETAILS)
    assert data.startswith(b"%PDF-1.4") and data.endswith(b"%%EOF\n")
    assert b"/Info" not in data and b"/Producer" not in data
    assert avs.render(DETAILS) == data
    xref_at = int(data.rsplit(b"startxref\n", 1)[1].split(b"\n")[0])
    assert data[xref_at:].startswith(b"xref\n")
    for number, offset in enumerate(re.findall(rb"(\d{10}) 00000 n", data), start=1):
        assert data[int(offset):].startswith(f"{number} 0 obj".encode())


def test_a_long_summary_runs_onto_more_pages() -> None:
    many = avs.AfterVisitSummaryDetails(
        practice_name="P", patient_name="Mai Nguyen", clinician_name="Dr. R",
        visit_start=datetime(2026, 11, 3, tzinfo=UTC), time_zone="UTC",
        diagnoses=tuple(f"Synthetic diagnosis {i}" for i in range(80)))
    data = avs.render(many)
    pages = len(pdf.paginate(avs.lines(many)))
    assert pages > 1 and f"/Count {pages}".encode() in data
    assert f"Page {pages} of {pages}" in _text(data)


# ====================================================================== stored and recorded
@pytest.mark.db
@SKIP_WITHOUT_DATABASE
async def test_stored_with_its_document_and_found_as_the_latest(
        database: Database, clinic: dict[str, Any], admin_engine: Engine,  # noqa: F811
        tmp_path: Path) -> None:
    patient, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        note = await STORE.create_note(s, fs.NoteIn(
            encounter_id=enc.id, note_type=fs.Coded(system="http://loinc.org", code="11506-3",
                                                    display="Progress note"),
            title="Visit", sections=(fs.SectionIn("69730-0", "Instructions", "Rest."),)))
        await STORE.sign_note(s, note.id, if_version=note.version)
        await s.commit()
    files = LocalFileStore(tmp_path)
    async with session(database, clinic) as s:
        assert await avs.latest(s, enc.id) is None
        first = await avs.store(s, files, patient_id=patient.id, encounter_id=enc.id,
                                note_id=note.id, author_practitioner_id=clinic["practitioner"],
                                details=DETAILS)
        await s.commit()
    async with session(database, clinic) as s:
        second = await avs.store(s, files, patient_id=patient.id, encounter_id=enc.id,
                                 note_id=note.id, author_practitioner_id=clinic["practitioner"],
                                 details=DETAILS)
        await s.commit()
        assert await avs.latest(s, enc.id) == second  # generating again makes a new document
    (doc,) = _rows(admin_engine, "SELECT status, type_code, subject_patient_id, ext_origin, "
                   "ext_composition_id, context_encounter_id, created_by_user_id FROM "
                   "clinical.document_reference WHERE id = :i", i=first.document_id)
    assert tuple(doc) == ("current", "34133-9", patient.id, "generated", note.id, enc.id,
                          clinic["user"])
    (cat,) = _rows(admin_engine, "SELECT category_code FROM clinical.document_reference_category "
                   "WHERE document_reference_id = :i", i=first.document_id)
    assert cat.category_code == "clinical-note"
    (obj,) = _rows(admin_engine, "SELECT purpose, state, storage_key FROM admin.binary_object "
                   "WHERE id = :i", i=first.file_id)
    assert (obj.purpose, obj.state) == ("after-visit-summary", "clean")
    assert (tmp_path / obj.storage_key).read_bytes() == avs.render(DETAILS)
