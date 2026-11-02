"""The AI gateway against a live database, as shri_app through the core's tenant session, with
the real AI repository, Anand's note helpers and the encounters module's draft writer; only the
model is a stub. Fixtures are test_fhir_store's (a clinic with a clinician linked to a
practitioner); the visit is test_fhir_store_visits'. Synthetic data only.

What it proves:
- the off switch is the clinic's ``ai_enabled`` and the feature's row, per clinic;
- the visit workflow (encounter, note, sign) works the same with AI off;
- a gateway draft is an unsigned note whose AI sections point at a pending suggestion, with
  its request, prompt version and sources recorded; it can't be signed (the helper and the
  database both refuse) until a person accepts the suggestion, and then the clinician signs;
- a failed model call leaves its request record and nothing else.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.db import Database
from app.core.errors import Conflict
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.models.enums import AIDecision, AIFeature
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant
from app.db.tests.test_fhir_store import _rows, clinic, database, session
from app.db.tests.test_fhir_store_visits import _facility, _visit
from app.modules.ai.model_client import ModelError
from app.modules.ai.prompts import NOTE_DRAFT_V1
from app.modules.ai.repository import SqlAIRepository, Switches
from app.modules.ai.schemas import NOTE_DRAFT_PROMPT, NOTE_DRAFT_SCHEMA, SourceRef
from app.modules.ai.service import Gateway, ModelUnavailable, ensure_enabled
from app.modules.encounters.ai_drafts import EncounterNoteDrafts

from .fakes import CHIEF, GOOD_REPLY, HISTORY, StubModelClient, request

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["_facility", "clinic", "database"]   # fixtures, used by name

REPO = SqlAIRepository()
STORE = fs.SqlFhirStore()
AMBIENT = AIFeature.AMBIENT_DOCUMENTATION
PROGRESS = fs.Coded(system=systems.LOINC, code="11506-3", display="Progress note")


async def _turn_on(database: Database, clinic: dict[str, Any]) -> None:
    async with session(database, clinic) as s:
        await REPO.set_feature(s, AMBIENT, True)
        await REPO.publish_prompt(s, NOTE_DRAFT_PROMPT, AMBIENT, NOTE_DRAFT_V1,
                                  NOTE_DRAFT_SCHEMA)
        await s.commit()


def _t(rows: Any) -> list[tuple[Any, ...]]:
    return [tuple(r) for r in rows]


def _gateway(model: StubModelClient | None = None) -> Gateway:
    return Gateway(repo=REPO, model=model or StubModelClient(), drafts=EncounterNoteDrafts())


# ================================================================================ the switch
async def test_the_switch_is_the_clinics_and_the_features(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    async with session(database, clinic) as s:
        assert await REPO.switches(s, AMBIENT) == Switches(clinic=True, feature=False)
        with pytest.raises(Conflict) as off:                  # no row: the feature is off
            await ensure_enabled(s, REPO, AMBIENT)
        assert off.value.code == "feature-disabled"
        await REPO.set_feature(s, AMBIENT, True)
        await s.commit()
    async with session(database, clinic) as s:
        await ensure_enabled(s, REPO, AMBIENT)
        assert (await REPO.switches(s, AIFeature.CHART_SUMMARY)).feature is False
        await s.execute(text("UPDATE admin.tenant SET ai_enabled = false"))
        await s.commit()
    async with session(database, clinic) as s:
        assert await REPO.switches(s, AMBIENT) == Switches(clinic=False, feature=True)
        with pytest.raises(Conflict):
            await ensure_enabled(s, REPO, AMBIENT)
        with pytest.raises(IntegrityError, match="disabled_has_reason"):
            await REPO.set_feature(s, AMBIENT, False)          # off needs a reason
    async with session(database, clinic) as s:
        await REPO.set_feature(s, AMBIENT, False, reason="Paused by the practice lead")
        await s.commit()
    assert _t(_rows(admin_engine, "SELECT is_enabled, reason FROM admin.ai_feature_setting "
                 "WHERE tenant_id = :t", t=clinic["tenant"])) == [
        (False, "Paused by the practice lead")]
    # Another clinic's switch is its own.
    other = make_tenant(admin_engine)
    async with database.tenant_session(other, clinic["user"]) as s:
        assert await REPO.switches(s, AMBIENT) == Switches(clinic=True, feature=False)


async def test_the_visit_workflow_works_with_ai_off(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    async with session(database, clinic) as s:
        await s.execute(text("UPDATE admin.tenant SET ai_enabled = false"))
        await s.commit()
    _, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        with pytest.raises(Conflict) as off:
            await _gateway().draft_note(s, request(encounter_id=enc.id))
        assert off.value.code == "feature-disabled"
        note = await STORE.create_note(s, fs.NoteIn(
            encounter_id=enc.id, note_type=PROGRESS, title="Follow-up visit",
            sections=(fs.SectionIn("10164-2", "Interval history", HISTORY),)))
        await s.commit()
    async with session(database, clinic) as s:
        section = _rows(admin_engine, "SELECT id FROM clinical.composition_section WHERE "
                        "composition_id = :n", n=note.id)[0].id
        saved = await STORE.update_note(s, note.id, fs.NoteChanges(
            sections=(fs.SectionText(section, HISTORY + " Continue topiramate."),)),
            if_version=note.version)
        signed = await STORE.sign_note(s, note.id, if_version=saved.version)
        await STORE.set_encounter_status(s, enc.id, "in-progress")
        await s.commit()
    assert signed.version == saved.version == note.version + 1   # one transaction
    assert _t(_rows(admin_engine, "SELECT status, ext_is_ai_assisted FROM "
                    "clinical.composition WHERE id = :n", n=note.id)) == [("final", False)]
    assert _rows(admin_engine, "SELECT count(*) FROM admin.ai_request WHERE tenant_id = :t",
                 t=clinic["tenant"])[0][0] == 0


# ======================================================================== drafts and signing
async def test_a_draft_needs_a_persons_decision_before_the_clinician_signs(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    await _turn_on(database, clinic)
    patient, enc = await _visit(database, clinic)
    transcript_ref = SourceRef("DocumentReference", uuid.uuid4(), 1)
    async with session(database, clinic) as s:
        result = await _gateway().draft_note(s, request(
            encounter_id=enc.id, patient_id=patient.id, sources=(transcript_ref,)))
        await s.commit()
    note_id, prov = result.note.note_id, result.provenance

    note = _t(_rows(admin_engine, "SELECT status, ext_is_ai_assisted, encounter_id, "
                    "subject_patient_id FROM clinical.composition WHERE id = :n", n=note_id))
    assert note == [("preliminary", True, enc.id, patient.id)]
    # The first note moved the visit to in-progress, as a clinician's first note does.
    assert _rows(admin_engine, "SELECT status FROM clinical.encounter WHERE id = :e",
                 e=enc.id)[0][0] == "in-progress"
    sections = _rows(admin_engine, "SELECT id, code_code, entry_source, ai_suggestion_id FROM "
                     "clinical.composition_section WHERE composition_id = :n ORDER BY sequence",
                     n=note_id)
    one, two, three, four = prov.suggestion_ids
    assert [(r.code_code, r.entry_source, r.ai_suggestion_id) for r in sections] == [
        ("10154-3", "clinician", one), ("10164-2", "clinician", two),
        ("29545-1", "clinician", three), ("51847-2", "clinician", four),
        ("69730-0", "clinician", None)]   # empty: not AI text, no suggestion
    texts = _rows(admin_engine, "SELECT text_div FROM clinical.composition_section WHERE "
                  "composition_id = :n ORDER BY sequence", n=note_id)
    assert fs.section_text(texts[0].text_div) == CHIEF

    for section, reply in zip(sections[:4], GOOD_REPLY["sections"][:4], strict=True):
        suggestion = _rows(admin_engine, "SELECT decision, target_resource_type, target_id, "
                           "content, confidence, ai_request_id, encounter_id, patient_id FROM "
                           "admin.ai_suggestion WHERE id = :i", i=section.ai_suggestion_id)[0]
        assert (suggestion.decision, suggestion.target_resource_type, suggestion.target_id) == (
            "pending", "CompositionSection", section.id)
        assert suggestion.content["text"] == reply["text"]
        assert (suggestion.ai_request_id, suggestion.encounter_id, suggestion.patient_id) == (
            prov.request_id, enc.id, patient.id)
    ai = one
    req = _rows(admin_engine, "SELECT feature, status, model_name, prompt_template_id, "
                "input_sha256, user_id, latency_ms, created_at FROM admin.ai_request "
                "WHERE id = :i", i=prov.request_id)[0]
    assert (req.feature, req.status, req.model_name, req.user_id, req.latency_ms) == (
        "ambient-documentation", "completed", "stub/qwen3-8b", clinic["user"], 1234)
    assert req.prompt_template_id == prov.prompt_template_id and len(req.input_sha256) == 64
    assert req.created_at == prov.requested_at
    refs = _rows(admin_engine, "SELECT resource_type, resource_id, resource_version_id FROM "
                 "admin.ai_request_input_ref WHERE ai_request_id = :i ORDER BY resource_type",
                 i=prov.request_id)
    assert _t(refs) == [("DocumentReference", transcript_ref.resource_id, 1),
                                       ("Encounter", enc.id, None)]
    prompt = _t(_rows(admin_engine, "SELECT code, version, is_active FROM "
                      "admin.prompt_template WHERE id = :i", i=prov.prompt_template_id))
    assert prompt == [("note-draft", 1, True)] and prov.prompt_version == 1

    # Nobody can sign it while the suggestion is pending: the helper refuses ...
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput, match="AI-drafted section"):
            await STORE.sign_note(s, note_id, if_version=result.note.version)
    # ... and so does the database, whatever writes the signature.
    async with session(database, clinic) as s:
        await s.execute(text(
            "INSERT INTO clinical.composition_attester (id, tenant_id, composition_id, mode, "
            "time, party_practitioner_id, ext_user_id, ext_content_sha256) VALUES (:i, :t, :n, "
            "'legal', now(), :p, :u, :h)"), {"i": uuid.uuid4(), "t": clinic["tenant"],
                                             "n": note_id,
                                    "p": clinic["practitioner"], "u": clinic["user"],
                                    "h": "0" * 64})
        await s.execute(text("UPDATE clinical.composition SET status = 'final' WHERE id = :n"),
                        {"n": note_id})
        with pytest.raises(DBAPIError, match="AI-drafted section"):
            await s.commit()
    # A person accepts each section, then the clinician signs.
    async with session(database, clinic) as s:
        for suggestion_id in prov.suggestion_ids:
            await REPO.decide(s, suggestion_id, AIDecision.ACCEPTED)
        await s.commit()
    async with session(database, clinic) as s:
        await STORE.sign_note(s, note_id, if_version=result.note.version)
        await s.commit()
    assert _t(_rows(admin_engine, "SELECT c.status, a.ext_user_id FROM clinical.composition c "
                    "JOIN clinical.composition_attester a ON a.composition_id = c.id "
                    "WHERE c.id = :n", n=note_id)) == [("final", clinic["user"])]
    assert _t(_rows(admin_engine, "SELECT decision, decided_by_user_id FROM "
                    "admin.ai_suggestion WHERE id = :i", i=ai)) == [("accepted", clinic["user"])]
    # The AI output stays as the model gave it, and its decision is final.
    async with session(database, clinic) as s:
        with pytest.raises(DBAPIError, match="immutable"):
            await s.execute(text("UPDATE admin.ai_suggestion SET content = '{}'::jsonb "
                                 "WHERE id = :i"), {"i": ai})


async def test_a_closed_visit_takes_no_draft(database: Database, clinic: dict[str, Any],
                                             admin_engine: Engine) -> None:
    await _turn_on(database, clinic)
    patient, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        await STORE.set_encounter_status(s, enc.id, "in-progress")
        await STORE.set_encounter_status(s, enc.id, "finished")
        await s.commit()
    async with session(database, clinic) as s:
        with pytest.raises(Conflict) as closed:
            await _gateway().draft_note(s, request(encounter_id=enc.id, patient_id=patient.id))
        assert closed.value.extensions == {"currentState": "finished"}
    assert _rows(admin_engine, "SELECT count(*) FROM clinical.composition WHERE "
                 "encounter_id = :e", e=enc.id)[0][0] == 0


async def test_a_failed_model_call_leaves_only_its_request_record(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    await _turn_on(database, clinic)
    patient, enc = await _visit(database, clinic)
    model = StubModelClient([ModelError("timeout", "the model did not answer in time")])
    async with session(database, clinic) as s:
        with pytest.raises(ModelUnavailable) as failed:
            await _gateway(model).draft_note(s, request(encounter_id=enc.id,
                                                        patient_id=patient.id))
        await s.commit()            # the AI operation commits the failure record
    rows = _t(_rows(admin_engine, "SELECT status, error_message, input_tokens FROM "
                    "admin.ai_request WHERE id = :i", i=failed.value.request_id))
    assert rows == [("timeout", "the model did not answer in time", None)]
    for table in ("admin.ai_suggestion", "clinical.composition"):
        assert _rows(admin_engine, f"SELECT count(*) FROM {table} WHERE "  # noqa: S608
                     "encounter_id = :e", e=enc.id)[0][0] == 0


async def test_a_new_prompt_version_replaces_the_active_one(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    await _turn_on(database, clinic)
    async with session(database, clinic) as s:
        second = await REPO.publish_prompt(s, NOTE_DRAFT_PROMPT, AMBIENT, NOTE_DRAFT_V1 + "\n",
                                           None)
        await s.commit()
    async with session(database, clinic) as s:
        active = await REPO.active_prompt(s, NOTE_DRAFT_PROMPT)
    assert active is not None and (active.id, active.version) == (second.id, 2)
    assert _t(_rows(
        admin_engine, "SELECT version, is_active FROM admin.prompt_template WHERE tenant_id = "
        ":t ORDER BY version", t=clinic["tenant"])) == [(1, False), (2, True)]
