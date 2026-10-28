"""Migration 0008: the batch 1 follow-up schema items (A43; issue #13, follow-up c), with
migration 0012's required receipt (D104) and merge by link (D103).

Every test runs as shri_app (SET ROLE from the superuser URL, see conftest.py), with forced
row-level security in force.
"""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.db.models import MAPPERS, systems
from app.db.tests import builders as b
from app.db.tests.conftest import SERVICE_ROLES, SKIP_WITHOUT_DATABASE, make_tenant, open_session
from app.db.tests.test_db_rules import fails
from app.fhir.serializer import to_fhir

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS
DL_SYSTEM = "urn:oid:2.16.840.1.113883.4.3.39"     # a state's driver's license OID


def _file(db: Session) -> Any:
    blob = M["binary_object"](bucket="docs", storage_key=f"k/{uuid.uuid4()}.pdf",
                              content_type="application/pdf", size_bytes=10, sha256="a" * 64)
    db.add(blob)
    db.flush()
    return blob


def _document(db: Session, pt: Any) -> Any:
    doc = M["document_reference"](status="current", type_system=systems.LOINC,
                                  type_code="34133-9", subject_patient_id=pt.id, date=b.NOW)
    doc.content = [M["document_reference_content"](attachment_content_type="application/pdf",
                                                   attachment_binary_object_id=_file(db).id)]
    db.add(doc)
    db.flush()
    return doc


def _other_clinic_file(admin_engine: Engine) -> uuid.UUID:
    tenant, blob = make_tenant(admin_engine), uuid.uuid4()
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, "
                       "content_type, size_bytes, sha256, scan_status) VALUES (:i, :t, 'docs', "
                       ":k, 'application/pdf', 10, :h, 'pending')"),
                  {"i": blob, "t": tenant, "k": f"k/{blob}.pdf", "h": "b" * 64})
    return blob


# ====================================================================== identifier documentId
def test_a_license_identifier_points_at_the_same_patients_scan(db: Session) -> None:
    pt, other = b.patient(db), b.patient(db, "Okafor", "Ada")
    scan, others_scan = _document(db, pt), _document(db, other)
    db.add(M["identifier"](patient_id=pt.id, system=DL_SYSTEM, value="D1234567",
                           type_system=systems.V2_0203, type_code="DL",
                           supporting_document_id=scan.id))
    db.flush()
    with fails(db, "23503", "fk_identifier_supporting_document_id_same_patient"):
        db.add(M["identifier"](patient_id=pt.id, system=DL_SYSTEM, value="D7654321",
                               type_system=systems.V2_0203, type_code="DL",
                               supporting_document_id=others_scan.id))
        db.flush()


def test_only_a_patients_identifier_has_a_supporting_document(db: Session) -> None:
    ctx = b.practice(db)
    scan = _document(db, b.patient(db))
    with fails(db, "23514", "ck_identifier_supporting_document_patient_only"):
        db.add(M["identifier"](practitioner_id=ctx["practitioner"].id, system=DL_SYSTEM,
                               value="D1111111", supporting_document_id=scan.id))
        db.flush()


def test_the_supporting_document_is_not_served_on_fhir(db: Session) -> None:
    pt = b.patient(db)
    scan = _document(db, pt)
    pt.identifier.append(M["identifier"](system=DL_SYSTEM, value="D2222222",
                                         type_system=systems.V2_0203, type_code="DL",
                                         supporting_document_id=scan.id))
    db.commit()
    assert str(scan.id) not in repr(to_fhir(pt))


# ====================================================================== consent requirements
def _requirement(db: Session, version: str = "2026-01", **kw: Any) -> Any:
    req = M["consent_requirement"](**{"kind": "privacy-notice", "title": "Notice of Privacy "
                                      "Practices", "policy_version": version,
                                      "is_required": True, "effective_date": dt.date(2026, 1, 1),
                                      **kw})
    db.add(req)
    db.flush()
    return req


def test_consent_requirements_are_versioned_by_kind(db: Session) -> None:
    first = _requirement(db, form_file_id=_file(db).id)
    _requirement(db, "2026-07")                      # a new version is a new row
    _requirement(db, kind="treatment", title="Consent to treatment")
    with fails(db, "23505", "uq_consent_requirement_tenant_id_kind_policy_version"):
        _requirement(db)
    with fails(db, "23514", "ck_consent_requirement_title_given"):
        _requirement(db, "2027-01", title="  ")
    with fails(db, "23514", "ck_consent_requirement_kind_codes"):
        db.execute(text("INSERT INTO admin.consent_requirement (id, tenant_id, kind, title, "
                        "policy_version, is_required, effective_date) VALUES (:i, :t, "
                        "'marketing', 'Offers', '1', false, '2026-01-01')"),
                   {"i": uuid.uuid4(), "t": first.tenant_id})
    assert first.is_active


def test_a_consent_requirement_keeps_its_kind_and_is_never_deleted(db: Session) -> None:
    req = _requirement(db)
    db.commit()
    assert req.version == 1
    db.execute(text("UPDATE admin.consent_requirement SET is_active = false, version = 1 "
                    "WHERE id = :i"), {"i": req.id})
    db.commit()
    db.refresh(req)
    assert (req.is_active, req.version) == (False, 2)    # retired; the ETag moves
    with fails(db, "P0001", message="kind is fixed once created"):
        db.execute(text("UPDATE admin.consent_requirement SET kind = 'treatment' "
                        "WHERE id = :i"), {"i": req.id})
    with fails(db, "42501"):
        db.execute(text("DELETE FROM admin.consent_requirement WHERE id = :i"), {"i": req.id})


def test_a_consent_requirements_form_is_a_file_in_its_clinic(db: Session,
                                                             admin_engine: Engine) -> None:
    with fails(db, "23503", "fk_consent_requirement_form_file_id_tenant"):
        _requirement(db, form_file_id=_other_clinic_file(admin_engine))


# ====================================================================== payment receipts
def test_a_payment_receipt_is_a_file_in_its_clinic(db: Session, admin_engine: Engine) -> None:
    pt = b.patient(db)

    def pay(receipt: uuid.UUID | None) -> None:
        db.add(M["patient_payment"](patient_id=pt.id, amount=25, method="cash",
                                    collected_at=b.NOW, receipt_file_id=receipt))
        db.flush()

    pay(_file(db).id)
    with fails(db, "23503", "fk_patient_payment_receipt_file_id_tenant"):
        pay(_other_clinic_file(admin_engine))
    with fails(db, "23502"):                               # D104: every payment has one
        pay(None)


# ====================================================================== merge by link (D103)
def _merge(db: Session, keep: Any = None, dup: Any = None, ctx: Any = None) -> dict[str, Any]:
    """A merge as the service does it (D103): the merge row, both patients' links and the
    merged patient made inactive, in one transaction. No record moves."""
    ctx = ctx or b.practice(db)
    keep = keep or b.patient(db)
    dup = dup or b.patient(db, "Nguyen", "May")
    enc = b.encounter(db, dup, ctx, status="finished")
    db.commit()
    merge = M["patient_merge"](surviving_patient_id=keep.id, merged_patient_id=dup.id,
                               reason="Same person", performed_at=b.NOW,
                               performed_by_user_id=ctx["user"].id)
    db.add(merge)
    keep.link.append(M["patient_link"](other_patient_id=dup.id, type="replaces"))
    dup.link.append(M["patient_link"](other_patient_id=keep.id, type="replaced-by"))
    dup.active = False
    db.commit()
    db.refresh(merge)
    return {"merge": merge, "keep": keep, "dup": dup, "encounter": enc, "ctx": ctx}


def _blocked(db: Session, merge: Any) -> str | None:
    reason: str | None = db.execute(text("SELECT admin.patient_merge_undo_blocked_reason(:m)"),
                                    {"m": merge.id}).scalar_one()
    return reason


def _undo(db: Session, m: dict[str, Any]) -> None:
    """The undo as the service does it: mark the merge undone and remove both links."""
    db.execute(text("UPDATE admin.patient_merge SET unmerged_at = now(), "
                    "unmerged_by_user_id = :u WHERE id = :m"),
               {"u": m["ctx"]["user"].id, "m": m["merge"].id})
    db.execute(text("DELETE FROM clinical.patient_link WHERE patient_id IN (:k, :d) "
                    "AND other_patient_id IN (:k, :d)"), {"k": m["keep"].id, "d": m["dup"].id})


def test_a_merge_moves_no_record(db: Session) -> None:
    m = _merge(db)
    db.refresh(m["encounter"])
    assert m["encounter"].subject_patient_id == m["dup"].id
    assert [(link.type, link.other_patient_id) for link in m["dup"].link] == [
        ("replaced-by", m["keep"].id)]


def test_a_merge_can_be_undone_once(db: Session) -> None:
    m = _merge(db)
    assert _blocked(db, m["merge"]) is None
    _undo(db, m)
    db.commit()
    assert _blocked(db, m["merge"]) == "already-undone"
    with fails(db, "P0001", message="it was undone and no longer changes"):
        db.execute(text("UPDATE admin.patient_merge SET unmerged_at = NULL WHERE id = :m"),
                   {"m": m["merge"].id})


def test_changes_to_either_chart_since_the_merge_do_not_block_its_undo(db: Session) -> None:
    m = _merge(db)
    m["encounter"].period_end = b.NOW + dt.timedelta(hours=1)
    m["keep"].ext_race_text = "Asked again"
    m["dup"].ext_race_text = "Asked again"
    b.encounter(db, m["keep"], m["ctx"])
    db.commit()
    assert _blocked(db, m["merge"]) is None
    _undo(db, m)
    db.commit()


@pytest.mark.parametrize("role", ["surviving", "merged"])
def test_a_later_merge_involving_either_patient_blocks_the_undo(db: Session, role: str) -> None:
    first = _merge(db)
    third = b.patient(db, "Okafor", "Lee")
    # The surviving patient is merged on into a third chart, or a third chart into it.
    later = (_merge(db, keep=third, dup=first["keep"], ctx=first["ctx"]) if role == "surviving"
             else _merge(db, keep=first["keep"], dup=third, ctx=first["ctx"]))
    assert _blocked(db, first["merge"]) == "later-merge"
    with fails(db, "P0001", message="cannot be undone (later-merge)"):
        _undo(db, first)
    _undo(db, later)                     # once the later merge is undone, the first one can be
    db.commit()
    assert _blocked(db, first["merge"]) is None


def test_a_later_merge_of_other_patients_does_not_block_the_undo(db: Session) -> None:
    first = _merge(db)
    _merge(db, keep=b.patient(db, "Okafor", "Lee"), dup=b.patient(db, "Garcia", "Ana"),
           ctx=first["ctx"])
    assert _blocked(db, first["merge"]) is None


def test_a_merge_changes_only_by_its_undo(db: Session) -> None:
    m = _merge(db)
    for change in ("reason = 'Different reason'",
                   f"surviving_patient_id = '{m['dup'].id}', merged_patient_id = '{m['keep'].id}'"):
        with fails(db, "P0001", message="only its undo may change it"):
            db.execute(text(f"UPDATE admin.patient_merge SET {change} WHERE id = :m"),  # noqa: S608
                       {"m": m["merge"].id})


def test_the_undo_rule_sees_only_its_own_clinic(app_engine: Engine, admin_engine: Engine,
                                                db: Session) -> None:
    m = _merge(db)
    other = open_session(app_engine, make_tenant(admin_engine))
    try:
        with fails(other, "P0002", message="not found"):
            _blocked(other, m["merge"])
    finally:
        conn = other.bind
        other.close()
        conn.close()  # type: ignore[union-attr]


def test_the_undo_rule_runs_as_the_caller_for_shri_app_only(admin_engine: Engine) -> None:
    function = "admin.patient_merge_undo_blocked_reason(uuid)"
    with admin_engine.connect() as c:
        definer, config = c.execute(text(
            "SELECT p.prosecdef, p.proconfig FROM pg_proc p "
            "WHERE p.oid = CAST(:f AS regprocedure)"), {"f": function}).one()
        assert not definer and config == ["search_path=pg_catalog, pg_temp"]
        for role in SERVICE_ROLES:
            assert c.execute(text("SELECT has_function_privilege(:r, :f, 'EXECUTE')"),
                             {"r": role, "f": function}).scalar_one() == (role == "shri_app")
