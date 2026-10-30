"""The note write helpers (Composition: draft, autosave, sign, addendum, co-sign, entered in
error; D8, D73) against a live database, as shri_app through the core's tenant session.
Fixtures are test_fhir_store's; the visit is test_fhir_store_visits'."""
from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

from app.core.db import Database
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.tests import builders as b
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant, open_session
from app.db.tests.test_fhir_store import _rows, clinic, database, session
from app.db.tests.test_fhir_store_visits import WHY, _facility, _visit

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["_facility", "clinic", "database"]   # fixtures, used by name

STORE = fs.SqlFhirStore()
PROGRESS = fs.Coded(system=systems.LOINC, code="11506-3", display="Progress note")
HPI = "Headache for 3 days; worse with light & noise <no aura>."


def _history(admin_engine: Engine, note_id: uuid.UUID) -> list[int]:
    return [r.version_id for r in _rows(admin_engine, "SELECT version_id FROM clinical."
                                        "fhir_resource_history WHERE resource_id = :n ORDER BY "
                                        "version_id", n=note_id)]


@pytest.fixture
def cosigner(clinic: dict[str, Any], app_engine: Engine) -> dict[str, Any]:
    """A second clinician of the same clinic: the supervising physician."""
    s = open_session(app_engine, clinic["tenant"])
    sup = b.practitioner(s, "Okafor", "Chidi")
    s.commit()
    out = {**clinic, "user": sup["user"].id, "practitioner": sup["practitioner"].id}
    s.close()
    return out


# ====================================================================== draft and autosave
async def test_every_committed_autosave_is_a_version(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    _, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        w = await STORE.create_note(s, fs.NoteIn(
            encounter_id=enc.id, note_type=PROGRESS, title="Follow-up visit",
            sections=(fs.SectionIn("10164-2", "History of present illness", HPI),
                      fs.SectionIn("51847-2", "Assessment and plan"))))
        await s.commit()
    nid = {"n": w.id}
    row = _rows(admin_engine, "SELECT status, subject_patient_id IS NOT NULL AS pt, "
                "created_by_user_id, (SELECT practitioner_id FROM clinical.composition_author a "
                "WHERE a.composition_id = c.id) AS author FROM clinical.composition c "
                "WHERE id = :n", **nid)[0]
    assert tuple(row) == ("preliminary", True, clinic["user"], clinic["practitioner"])
    sections = _rows(admin_engine, "SELECT id, code_code, text_div FROM clinical."
                     "composition_section WHERE composition_id = :n ORDER BY sequence", **nid)
    assert [fs.section_text(r.text_div) for r in sections] == [HPI, ""]   # escaped, read back
    plan = sections[1].id
    version = w.version
    for text_ in ("Migraine without aura.", "Migraine without aura. Start sumatriptan."):
        async with session(database, clinic) as s:
            saved = await STORE.update_note(s, w.id, fs.NoteChanges(
                sections=(fs.SectionText(plan, text_),)), if_version=version)
            await s.commit()
        assert saved.version == version + 1
        version = saved.version
    assert _history(admin_engine, w.id) == [1, 2, 3]
    async with session(database, clinic) as s:
        with pytest.raises(fs.StaleVersion):
            await STORE.update_note(s, w.id, fs.NoteChanges(title="Late tab"), if_version=1)
        with pytest.raises(fs.InvalidInput):
            await STORE.update_note(s, w.id, fs.NoteChanges(
                sections=(fs.SectionText(uuid.uuid4(), "x"),)), if_version=version)


# ====================================================================== sign, then frozen
async def test_signing_writes_the_attester_and_provenance_then_the_note_is_frozen(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    w = await _created(database, clinic)
    nid = {"n": w.id}
    async with session(database, clinic) as s:
        with pytest.raises(fs.StaleVersion):
            await STORE.sign_note(s, w.id, if_version=w.version + 1)
        signed = await STORE.sign_note(s, w.id, if_version=w.version)
        await s.commit()
    att = _rows(admin_engine, "SELECT mode, party_practitioner_id, ext_user_id, "
                "ext_content_sha256 FROM clinical.composition_attester WHERE composition_id = :n",
                **nid)
    assert [(a.mode, a.party_practitioner_id, a.ext_user_id) for a in att] == [
        ("legal", clinic["practitioner"], clinic["user"])]
    prov = _rows(admin_engine, "SELECT p.target_version_id, p.activity_code, s.data_sha256, "
                 "a.type_code FROM clinical.provenance p JOIN clinical.provenance_signature s ON "
                 "s.provenance_id = p.id JOIN clinical.provenance_agent a ON a.provenance_id = "
                 "p.id WHERE p.target_id = :n", **nid)
    assert [tuple(p) for p in prov] == [(signed.version, "LA", att[0].ext_content_sha256,
                                         "author")]
    assert _rows(admin_engine, "SELECT status FROM clinical.composition WHERE id = :n",
                 **nid)[0].status == "final"
    section = _rows(admin_engine, "SELECT id FROM clinical.composition_section WHERE "
                    "composition_id = :n LIMIT 1", **nid)[0].id
    async with session(database, clinic) as s:
        for write in (STORE.update_note(s, w.id, fs.NoteChanges(title="Edited"),
                                        if_version=signed.version),
                      STORE.sign_note(s, w.id, if_version=signed.version)):
            with pytest.raises(fs.InvalidTransition):
                await write
    async with session(database, clinic) as s:              # the database refuses it too
        with pytest.raises(DBAPIError, match="cannot change"):
            await s.execute(text("UPDATE clinical.composition_section SET text_div = NULL "
                                 "WHERE id = :i"), {"i": section})


async def _created(database: Database, clinic: dict[str, Any]) -> fs.Written:
    _, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        w = await STORE.create_note(s, fs.NoteIn(
            encounter_id=enc.id, note_type=PROGRESS, title="Follow-up visit",
            sections=(fs.SectionIn("51847-2", "Assessment and plan", "Migraine."),)))
        await s.commit()
    return w


# ====================================================================== addendum
async def test_an_addendum_appends_to_the_signed_note(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    w = await _created(database, clinic)
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidTransition):            # a draft is edited, not amended
            await STORE.add_note_addendum(s, w.id, "Late entry", if_version=w.version)
        signed = await STORE.sign_note(s, w.id, if_version=w.version)
        await s.commit()
    async with session(database, clinic) as s:
        added = await STORE.add_note_addendum(s, w.id, "BP rechecked: 128/82.",
                                              if_version=signed.version)
        await s.commit()
    assert added.note.version == signed.version + 1
    add = _rows(admin_engine, "SELECT c.status, r.code, r.target_composition_id, s.text_div, "
                "(SELECT count(*) FROM clinical.composition_attester t WHERE t.composition_id = "
                "c.id AND t.mode = 'legal') AS legal, (SELECT count(*) FROM clinical.provenance p"
                " WHERE p.target_id = c.id) AS provs FROM clinical.composition c JOIN clinical."
                "composition_relates_to r ON r.composition_id = c.id JOIN clinical."
                "composition_section s ON s.composition_id = c.id WHERE c.id = :a",
                a=added.addendum.id)[0]
    assert (add.status, add.code, add.target_composition_id, fs.section_text(add.text_div),
            add.legal, add.provs) == ("final", "appends", w.id, "BP rechecked: 128/82.", 1, 1)
    assert tuple(_rows(admin_engine, "SELECT status, ext_cosign_status FROM clinical.composition"
                       " WHERE id = :n", n=w.id)[0]) == ("amended", "not-required")
    async with session(database, clinic) as s:              # no co-signature was asked for
        with pytest.raises(fs.InvalidTransition):
            await STORE.cosign_note(s, w.id, if_version=added.note.version)


# ====================================================================== co-sign, return
async def test_the_cosigner_returns_the_note_then_cosigns_the_answer(
        database: Database, clinic: dict[str, Any], cosigner: dict[str, Any],
        admin_engine: Engine) -> None:
    w = await _created(database, clinic)
    nid = {"n": w.id}

    def cosign() -> tuple[Any, ...]:
        return tuple(_rows(admin_engine, "SELECT status, ext_cosign_status, "
                           "ext_cosigner_practitioner_id, ext_cosign_return_comment, "
                           "ext_cosign_returned_at IS NOT NULL AS returned FROM "
                           "clinical.composition WHERE id = :n", **nid)[0])

    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput):                 # the author never co-signs
            await STORE.sign_note(s, w.id, if_version=w.version,
                                  cosigner_practitioner_id=clinic["practitioner"])
        signed = await STORE.sign_note(s, w.id, if_version=w.version,
                                       cosigner_practitioner_id=cosigner["practitioner"])
        await s.commit()
    assert cosign() == ("final", "pending", cosigner["practitioner"], None, False)
    async with session(database, clinic) as s:               # only the named co-signer
        for write in (STORE.cosign_note(s, w.id, if_version=signed.version),
                      STORE.return_note_to_author(s, w.id, "Add the BP",
                                                  if_version=signed.version)):
            with pytest.raises(fs.InvalidInput):
                await write
    async with session(database, cosigner) as s:
        with pytest.raises(fs.InvalidInput):
            await STORE.return_note_to_author(s, w.id, "  ", if_version=signed.version)
        with pytest.raises(fs.StaleVersion):
            await STORE.return_note_to_author(s, w.id, "Add the BP", if_version=1)
        returned = await STORE.return_note_to_author(s, w.id, "Please add the BP.",
                                                     if_version=signed.version)
        await s.commit()
    assert returned.version == signed.version + 1
    assert cosign() == ("final", "returned", cosigner["practitioner"], "Please add the BP.", True)
    # Still signed and frozen (D73): no edit, and no co-signature until the author answers.
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidTransition):
            await STORE.update_note(s, w.id, fs.NoteChanges(title="Edited"),
                                    if_version=returned.version)
    async with session(database, cosigner) as s:
        with pytest.raises(fs.InvalidTransition):
            await STORE.cosign_note(s, w.id, if_version=returned.version)
    async with session(database, clinic) as s:
        added = await STORE.add_note_addendum(s, w.id, "BP 128/82.", if_version=returned.version)
        await s.commit()
    assert cosign() == ("amended", "pending", cosigner["practitioner"], None, False)
    async with session(database, cosigner) as s:
        cosigned = await STORE.cosign_note(s, w.id, if_version=added.note.version)
        await s.commit()
    assert cosign()[:2] == ("amended", "cosigned")
    att = _rows(admin_engine, "SELECT party_practitioner_id FROM clinical.composition_attester "
                "WHERE composition_id = :n AND mode = 'professional'", **nid)
    assert [a.party_practitioner_id for a in att] == [cosigner["practitioner"]]
    prov = _rows(admin_engine, "SELECT p.activity_code, a.type_code, a.who_practitioner_id FROM "
                 "clinical.provenance p JOIN clinical.provenance_agent a ON a.provenance_id = "
                 "p.id WHERE p.target_id = :n AND p.target_version_id = :v", v=cosigned.version,
                 **nid)
    assert [tuple(p) for p in prov] == [("AUTHEN", "attester", cosigner["practitioner"])]
    # The return is kept in the note's history, and a co-signature is final.
    returns = _rows(admin_engine, "SELECT snapshot->>'ext_cosign_return_comment' AS c FROM "
                    "clinical.fhir_resource_history WHERE resource_id = :n AND version_id = :v",
                    v=returned.version, **nid)
    assert [r.c for r in returns] == ["Please add the BP."]
    async with session(database, cosigner) as s:
        with pytest.raises(fs.InvalidTransition):
            await STORE.cosign_note(s, w.id, if_version=cosigned.version)
    async with session(database, cosigner) as s:
        with pytest.raises(DBAPIError, match="co-signature never change"):
            await s.execute(text("UPDATE clinical.composition SET ext_cosign_status = 'pending'"
                                 " WHERE id = :n"), nid)


async def test_the_database_keeps_the_cosignature_consistent(
        database: Database, clinic: dict[str, Any], cosigner: dict[str, Any]) -> None:
    w = await _created(database, clinic)
    nid = {"n": w.id}
    async with session(database, clinic) as s:              # a draft needs no co-signature yet
        with pytest.raises(DBAPIError, match="draft_not_cosigned"):
            await s.execute(text("UPDATE clinical.composition SET ext_cosign_status = 'pending',"
                                 " ext_cosigner_practitioner_id = :c WHERE id = :n"),
                            {**nid, "c": cosigner["practitioner"]})
    async with session(database, clinic) as s:
        signed = await STORE.sign_note(s, w.id, if_version=w.version,
                                       cosigner_practitioner_id=cosigner["practitioner"])
        await s.commit()
    for sql, constraint in (
            ("ext_cosign_status = 'returned'", "return_comment_while_returned"),
            ("ext_cosign_return_comment = 'x'", "return_comment_while_returned"),
            ("ext_cosigner_practitioner_id = :c", "co-signature never change")):
        async with session(database, clinic) as s:
            with pytest.raises(DBAPIError, match=constraint):
                await s.execute(text(f"UPDATE clinical.composition SET {sql} WHERE id = :n"),
                                {**nid, "c": clinic["practitioner"]})
    assert signed.version > w.version


# ====================================================================== entered in error
async def test_a_note_entered_in_error_has_its_provenance_and_stays_so(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    w = await _created(database, clinic)
    async with session(database, clinic) as s:
        signed = await STORE.sign_note(s, w.id, if_version=w.version)
        with pytest.raises(fs.InvalidInput):
            await STORE.note_entered_in_error(s, w.id, fs.Reason(text="  "))
        wrong = await STORE.note_entered_in_error(s, w.id, WHY, if_version=signed.version)
        await s.commit()
    assert [tuple(r) for r in _rows(admin_engine, "SELECT target_version_id, reason_text FROM "
                                    "clinical.provenance WHERE target_id = :n AND activity_code"
                                    " = 'NULLIFY'", n=w.id)] == [(wrong.version, "Wrong patient")]
    async with session(database, clinic) as s:
        for write in (STORE.note_entered_in_error(s, w.id, WHY),
                      STORE.add_note_addendum(s, w.id, "Late", if_version=wrong.version)):
            with pytest.raises(fs.InvalidTransition):
                await write


# ====================================================================== another clinic
async def test_a_note_of_another_clinic_is_not_found(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    w = await _created(database, clinic)
    other = {**clinic, "tenant": make_tenant(admin_engine)}
    _, enc = await _visit(database, clinic)
    async with session(database, other) as s:
        for write in (STORE.create_note(s, fs.NoteIn(encounter_id=enc.id, note_type=PROGRESS,
                                                     title="x", sections=())),
                      STORE.update_note(s, w.id, fs.NoteChanges(title="x"), if_version=1),
                      STORE.sign_note(s, w.id, if_version=1),
                      STORE.add_note_addendum(s, w.id, "x", if_version=1),
                      STORE.cosign_note(s, w.id, if_version=1),
                      STORE.return_note_to_author(s, w.id, "x", if_version=1),
                      STORE.note_entered_in_error(s, w.id, WHY)):
            with pytest.raises(fs.ResourceNotFound):
                await write
