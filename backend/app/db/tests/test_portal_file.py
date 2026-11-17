"""Migration 0024: admin.portal_file(), one file's storage fields for the portal's after-visit
summary download (D105, D93), as shri_portal: only a clean after-visit summary on a current,
released, non-PSY document of the session patient in the session's clinic; nothing for any other
file, purpose, patient, clinic or state; EXECUTE for shri_portal only, and still no privilege on
admin.binary_object. Synthetic data only."""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session

from app.db.models import MAPPERS, systems
from app.db.tests import builders as b
from app.db.tests.conftest import make_tenant
from app.db.tests.test_portal_access import (
    DENIED,
    _as_patient,
    _hold,
    _refused,
    chart,
    portal_engine,
)

__all__ = ["chart", "portal_engine"]       # fixtures, used by name
M = MAPPERS
FILE = "SELECT * FROM admin.portal_file(:f)"


def _file(s: Session, chart: dict[str, Any], purpose: str = "after-visit-summary",
          state: str = "clean") -> uuid.UUID:
    """A file as the file service leaves it: a server-made one clean and never scanned, an
    upload clean only after a clean scan, a rejected one scanned infected (0012's checks)."""
    file_id = uuid.uuid4()
    generated = purpose in ("after-visit-summary", "imaging", "receipt")
    scan = ("pending" if generated or state == "quarantined"
            else "infected" if state == "rejected" else "clean")
    s.execute(text(
        "INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, content_type, "
        "size_bytes, sha256, purpose, state, scan_status, scanned_at, wrapped_data_key) "
        "VALUES (:i, :t, :bucket, :k, 'application/pdf', 1200, :h, :p, :s, :scan, "
        "CAST(:scanned AS timestamptz), :w)"),
        {"i": file_id, "t": chart["tenant"], "bucket": "clean" if state == "clean" else
         "quarantine", "k": f"{chart['tenant']}/{file_id}", "h": "b" * 64, "p": purpose,
         "s": state, "scan": scan,
         "scanned": None if scan == "pending" else "2026-11-01T00:00:00Z",
         "w": "vault:v1:test-wrapped-key" if state == "clean" else None})
    return file_id


def _document(s: Session, pt: Any, file_id: uuid.UUID, **kw: Any) -> Any:
    doc = M["document_reference"](status=kw.pop("status", "current"), type_system=systems.LOINC,
                                  type_code="34133-9", subject_patient_id=pt.id, date=b.NOW,
                                  ext_origin="generated", **kw)
    doc.content = [M["document_reference_content"](attachment_content_type="application/pdf",
                                                   attachment_binary_object_id=file_id)]
    s.add(doc)
    s.flush()
    return doc


def _read(c: Connection, chart: dict[str, Any], file_id: uuid.UUID, who: str = "me"
          ) -> list[Any]:
    _as_patient(c, chart, who)
    return list(c.execute(text(FILE), {"f": file_id}).all())


@pytest.mark.db
def test_the_patients_own_clean_summary_gives_its_storage_fields(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    file_id = _file(s, chart)
    doc = _document(s, chart["me"]["pt"], file_id)
    s.commit()
    with portal_engine.begin() as c:
        (row,) = _read(c, chart, file_id)
    assert (row.id, row.bucket, row.storage_key, row.purpose, row.document_reference_id) == (
        file_id, "clean", f"{chart['tenant']}/{file_id}", "after-visit-summary", doc.id)
    assert row.wrapped_data_key and row.size_bytes == 1200 and row.content_type == (
        "application/pdf")


@pytest.mark.db
def test_another_patients_or_another_clinics_file_gives_nothing(
        portal_engine: Engine, admin_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    theirs = _file(s, chart)
    _document(s, chart["other"]["pt"], theirs)
    mine = _file(s, chart)
    _document(s, chart["me"]["pt"], mine)
    s.commit()
    with portal_engine.begin() as c:
        assert _read(c, chart, theirs) == []
        assert len(_read(c, chart, theirs, "other")) == 1         # the other patient's own
    clinic_b = make_tenant(admin_engine)
    with portal_engine.begin() as c:
        c.execute(text("SELECT set_config('app.current_tenant_id', :t, true), "
                       "set_config('app.current_patient_id', :p, true)"),
                  {"t": str(clinic_b), "p": str(chart["me"]["pt"].id)})
        assert c.execute(text(FILE), {"f": mine}).all() == []    # another clinic's session
    with portal_engine.begin() as c:
        c.execute(text("SELECT set_config('app.current_tenant_id', :t, true), "
                       "set_config('app.current_patient_id', '', true)"),
                  {"t": str(chart["tenant"])})
        assert c.execute(text(FILE), {"f": mine}).all() == []    # no session patient


@pytest.mark.db
def test_a_draft_superseded_entered_in_error_or_psychotherapy_document_gives_nothing(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    pt = chart["me"]["pt"]
    hidden = []
    for kw in ({"doc_status": "preliminary"}, {"status": "superseded"},
               {"status": "entered-in-error"}, {"meta_security": ["PSY"]}):
        file_id = _file(s, chart)
        _document(s, pt, file_id, **kw)
        hidden.append(file_id)
    s.commit()
    with portal_engine.begin() as c:
        assert [_read(c, chart, f) for f in hidden] == [[], [], [], []]


@pytest.mark.db
def test_an_actively_held_summary_gives_nothing_and_a_lifted_hold_frees_it(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    file_id = _file(s, chart)
    doc = _document(s, chart["me"]["pt"], file_id)
    hold = _hold(s, chart, document_reference_id=doc.id)
    s.commit()
    with portal_engine.begin() as c:
        assert _read(c, chart, file_id) == []
    hold.lifted_at, hold.lifted_by_user_id = dt.datetime.now(dt.UTC), chart["ctx"]["user"].id
    s.commit()
    with portal_engine.begin() as c:
        assert len(_read(c, chart, file_id)) == 1


@pytest.mark.db
def test_any_other_purpose_or_an_unclean_file_gives_nothing(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    """Imaging files (0023) and receipts are not the portal's to download this way; a file that
    isn't clean never is."""
    s: Session = chart["s"]
    pt = chart["me"]["pt"]
    others = []
    for purpose, state in (("imaging", "clean"), ("receipt", "clean"),
                           ("document", "clean"), ("document", "quarantined"),
                           ("document", "rejected")):
        file_id = _file(s, chart, purpose, state)
        _document(s, pt, file_id)
        others.append(file_id)
    s.commit()
    with portal_engine.begin() as c:
        assert all(_read(c, chart, f) == [] for f in others)
        assert _read(c, chart, uuid.uuid4()) == []                 # no such file


@pytest.mark.db
def test_only_the_portal_may_execute_it_and_it_still_cannot_read_files(
        portal_engine: Engine, admin_engine: Engine, chart: dict[str, Any]) -> None:
    with admin_engine.connect() as c:
        fn = c.execute(text(
            "SELECT p.prosecdef, p.provolatile, p.proconfig, r.rolname AS owner, "
            "p.proacl::text[] AS acl FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner "
            "WHERE p.oid = 'admin.portal_file(uuid)'::regprocedure")).one()
        executors = {role for role in ("shri_portal", "shri_app", "shri_fhir_reader",
                                       "shri_integration", "shri_reporting", "shri_public",
                                       "shri_maintenance")
                     if c.execute(text("SELECT has_function_privilege(:r, "
                                       "'admin.portal_file(uuid)', 'EXECUTE')"),
                                  {"r": role}).scalar_one()}
    assert fn.prosecdef and fn.provolatile == "s" and fn.owner == "shri_migrator"
    assert fn.proconfig == ["search_path=pg_catalog, pg_temp"]
    assert not any(entry.startswith("=") for entry in fn.acl)        # nothing for PUBLIC
    assert executors == {"shri_portal"}
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert _refused(c, "SELECT id FROM admin.binary_object") == DENIED
