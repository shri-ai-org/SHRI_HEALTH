"""Migration 0008: the batch 1 follow-up schema items (A43; issue #13, follow-up c).

Every test runs as shri_app (SET ROLE from the superuser URL, see conftest.py), with forced
row-level security in force.
"""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError
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

    def pay(receipt: uuid.UUID) -> None:
        db.add(M["patient_payment"](patient_id=pt.id, amount=25, method="cash",
                                    collected_at=b.NOW, receipt_file_id=receipt))
        db.flush()

    pay(_file(db).id)
    with fails(db, "23503", "fk_patient_payment_receipt_file_id_tenant"):
        pay(_other_clinic_file(admin_engine))


# ====================================================================== merge undo (D51)
def _merge(db: Session) -> dict[str, Any]:
    """A merge as the service does it, in one transaction: first the merge row with both
    patients' versions and the record of each move at its version, then the moves: the merged
    patient's encounter goes to the surviving patient and both patients get their link."""
    ctx = b.practice(db)
    keep, dup = b.patient(db), b.patient(db, "Nguyen", "May")
    enc = b.encounter(db, dup, ctx, status="finished")
    db.commit()
    merge = M["patient_merge"](surviving_patient_id=keep.id, merged_patient_id=dup.id,
                               reason="Same person", performed_at=b.NOW,
                               performed_by_user_id=ctx["user"].id,
                               surviving_patient_version=keep.meta_version_id,
                               merged_patient_version=dup.meta_version_id)
    db.add(merge)
    db.flush()
    db.add(M["patient_merge_record"](patient_merge_id=merge.id, resource_type="Encounter",
                                     resource_id=enc.id,
                                     version_before_merge=enc.meta_version_id))
    enc.subject_patient_id = keep.id
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
    db.execute(text("UPDATE admin.patient_merge SET unmerged_at = now(), "
                    "unmerged_by_user_id = :u WHERE id = :m"),
               {"u": m["ctx"]["user"].id, "m": m["merge"].id})


def _move_back_and_finish(db: Session, m: dict[str, Any]) -> None:
    db.execute(text("UPDATE clinical.encounter SET subject_patient_id = :p WHERE id = :e"),
               {"p": m["dup"].id, "e": m["encounter"].id})
    db.execute(text("SELECT admin.finish_patient_merge_undo(:m)"), {"m": m["merge"].id})


def test_a_merge_moves_everything_it_touches_by_one_version(db: Session) -> None:
    m = _merge(db)
    assert m["keep"].meta_version_id == m["merge"].surviving_patient_version + 1
    assert m["dup"].meta_version_id == m["merge"].merged_patient_version + 1
    record = db.execute(text("SELECT version_before_merge FROM admin.patient_merge_record "
                             "WHERE patient_merge_id = :m"), {"m": m["merge"].id}).scalar_one()
    assert m["encounter"].meta_version_id == record + 1


def test_a_merge_records_the_versions_it_starts_from(db: Session) -> None:
    ctx = b.practice(db)
    keep, dup = b.patient(db), b.patient(db, "Nguyen", "May")
    enc = b.encounter(db, dup, ctx, status="finished")
    db.commit()

    def merge(**versions: Any) -> Any:
        row = M["patient_merge"](surviving_patient_id=keep.id, merged_patient_id=dup.id,
                                 reason="Same person", performed_at=b.NOW,
                                 performed_by_user_id=ctx["user"].id, **versions)
        db.add(row)
        db.flush()
        return row

    with fails(db, "P0001", message="record both patients' current versions"):
        merge()
    with fails(db, "P0001", message="record both patients' current versions"):
        merge(surviving_patient_version=keep.meta_version_id,
              merged_patient_version=dup.meta_version_id + 1)
    row = merge(surviving_patient_version=keep.meta_version_id,
                merged_patient_version=dup.meta_version_id)
    enc.subject_patient_id = keep.id                     # moved before it is listed
    db.flush()
    with fails(db, "P0001", message="list it before the merge moves it"):
        db.add(M["patient_merge_record"](patient_merge_id=row.id, resource_type="Encounter",
                                         resource_id=enc.id, version_before_merge=1))
        db.flush()


def test_an_untouched_merge_can_be_undone_once(db: Session) -> None:
    m = _merge(db)
    assert _blocked(db, m["merge"]) is None
    _undo(db, m)                         # the undo marks it, moves the records back, finishes
    _move_back_and_finish(db, m)
    db.commit()
    assert _blocked(db, m["merge"]) == "already-undone"
    with fails(db, "P0001", message="it was undone and no longer changes"):
        db.execute(text("UPDATE admin.patient_merge SET unmerged_at = NULL WHERE id = :m"),
                   {"m": m["merge"].id})


@pytest.mark.parametrize("change", ["moved record", "surviving patient", "merged patient"])
def test_a_change_since_the_merge_blocks_its_undo(db: Session, change: str) -> None:
    m = _merge(db)
    if change == "moved record":
        m["encounter"].period_end = b.NOW + dt.timedelta(hours=1)
    elif change == "surviving patient":
        m["keep"].ext_race_text = "Asked again"
    else:
        m["dup"].ext_race_text = "Asked again"
    db.commit()
    assert _blocked(db, m["merge"]) == "records-changed"
    with fails(db, "P0001", message="cannot be undone (records-changed)"):
        _undo(db, m)


def test_a_new_record_on_the_surviving_chart_does_not_block_the_undo(db: Session) -> None:
    m = _merge(db)
    b.encounter(db, m["keep"], m["ctx"])
    db.commit()
    assert _blocked(db, m["merge"]) is None


def test_an_undo_that_would_split_a_new_link_is_refused_as_records_changed(db: Session) -> None:
    # The documented limitation: a result added since the merge to the moved visit doesn't
    # change the visit's version, so undoAllowed stays true. The undo itself is refused at
    # commit with records-changed, not a raw key error.
    m = _merge(db)
    b.blood_pressure(db, m["keep"], m["encounter"])
    db.commit()
    assert _blocked(db, m["merge"]) is None
    _undo(db, m)
    with fails(db, "P0001", message="cannot be undone (records-changed)"):
        _move_back_and_finish(db, m)


def test_an_undo_must_finish(db: Session) -> None:
    m = _merge(db)
    _undo(db, m)
    db.execute(text("UPDATE clinical.encounter SET subject_patient_id = :p WHERE id = :e"),
               {"p": m["dup"].id, "e": m["encounter"].id})
    with pytest.raises(DBAPIError) as refused:
        db.commit()
    assert refused.value.orig.sqlstate == "P0001"          # type: ignore[union-attr]
    assert "the undo did not finish" in str(refused.value.orig)
    db.rollback()
    with fails(db, "P0001", message="no undo of it in progress"):
        db.execute(text("SELECT admin.finish_patient_merge_undo(:m)"), {"m": m["merge"].id})


def test_an_undo_that_moves_records_back_first_is_refused(db: Session) -> None:
    m = _merge(db)
    db.execute(text("UPDATE clinical.encounter SET subject_patient_id = :p WHERE id = :e"),
               {"p": m["dup"].id, "e": m["encounter"].id})
    with fails(db, "P0001", message="cannot be undone (records-changed)"):
        _undo(db, m)


def test_a_merge_changes_only_by_its_undo(db: Session) -> None:
    m = _merge(db)
    for change in ("reason = 'Different reason'", "surviving_patient_version = 99",
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


@pytest.mark.parametrize("function", ["admin.patient_merge_undo_blocked_reason(uuid)",
                                      "admin.finish_patient_merge_undo(uuid)"])
def test_the_undo_functions_run_as_the_caller_for_shri_app_only(admin_engine: Engine,
                                                                function: str) -> None:
    with admin_engine.connect() as c:
        definer, config = c.execute(text(
            "SELECT p.prosecdef, p.proconfig FROM pg_proc p "
            "WHERE p.oid = CAST(:f AS regprocedure)"), {"f": function}).one()
        assert not definer and config == ["search_path=pg_catalog, pg_temp"]
        for role in SERVICE_ROLES:
            assert c.execute(text("SELECT has_function_privilege(:r, :f, 'EXECUTE')"),
                             {"r": role, "f": function}).scalar_one() == (role == "shri_app")
