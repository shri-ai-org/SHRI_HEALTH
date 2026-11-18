"""Migration 0028 and the refill helpers (#400, #415): the patient asks, as shri_portal, through
admin.portal_request_refill(); the clinician answers, as shri_app, through
respond_to_refill_request(). A request is built from the prescription only, refused for anything
but the patient's own active, signed, non-controlled prescription (fail closed when its schedule
can't be read), one open per prescription, and never behaves like a medication: no list, no
duplicate warning, no /fhir. Synthetic data only."""
from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from pydantic import SecretStr
from sqlalchemy import Engine, text

from app.core.config import Settings
from app.core.db import Database
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, TEST_DATABASE_URL, switch_to_role
from app.db.tests.test_fhir_store import clinic, database, session
from app.db.tests.test_fhir_store_prescriptions import (
    AMOXICILLIN,
    STORE,
    _draft,
    _pharmacy,
)
from app.db.tests.test_fhir_store_visits import _facility, _visit
from app.modules.medications.portal_repository import SqlPortalMedicationReads
from app.modules.medications.repository import SqlMedicationRepository

__all__ = ["_facility", "_pharmacy", "clinic", "database"]   # fixtures, used by name
pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

OXYCODONE = fs.Coded(system=systems.RXNORM, code="1049621",
                     display="oxycodone hydrochloride 5 MG Oral Tablet")
NOT_LOADED = fs.Coded(system=systems.RXNORM, code="999999001",
                      display="synthetic drug not in the loaded release")


@pytest.fixture
async def portal() -> AsyncIterator[Database]:
    db = Database(Settings(database_url=SecretStr(TEST_DATABASE_URL or "")))
    switch_to_role(db.engine.sync_engine, "shri_portal")
    yield db
    await db.dispose()


@pytest.fixture(autouse=True)
def _concepts(admin_engine: Engine) -> None:
    """The RxNorm concepts the tests prescribe: amoxicillin (no schedule), oxycodone (CII). The
    third drug is left out on purpose, so its schedule can't be read."""
    with admin_engine.begin() as c:
        for drug, schedule in ((AMOXICILLIN, None), (OXYCODONE, "CII")):
            concept = c.execute(text(
                "INSERT INTO admin.concept (id, code_system_id, code, display, is_active) "
                "SELECT gen_random_uuid(), s.id, :code, :display, true FROM admin.code_system s "
                "WHERE s.uri = :rxnorm ON CONFLICT DO NOTHING RETURNING id"),
                {"code": drug.code, "display": drug.display, "rxnorm": systems.RXNORM}).scalar()
            if concept is not None and schedule is not None:
                c.execute(text("INSERT INTO admin.concept_property (id, concept_id, property, "
                               "value) VALUES (gen_random_uuid(), :c, 'dea_schedule', :v)"),
                          {"c": concept, "v": schedule})


async def _prescribed(database: Database, clinic: dict[str, Any], patient: Any, enc: Any,
                      drug: fs.Coded = AMOXICILLIN, dea: str | None = None) -> fs.Written:
    async with session(database, clinic) as s:
        w = await STORE.create_prescription(s, _draft(patient, enc, clinic, medication=drug,
                                                      dea_schedule=dea))
        await STORE.record_safety_check(s, w.id, (), if_version=w.version)
        signed = await STORE.sign_prescription(s, w.id, if_version=w.version)
        await s.commit()
    return signed


async def _ask(portal: Database, clinic: dict[str, Any], patient_id: uuid.UUID,
               prescription_id: uuid.UUID, note: str | None = None) -> fs.Written:
    async with portal.patient_session(clinic["tenant"], patient_id) as s:
        written = await STORE.create_refill_request(s, fs.RefillRequestIn(
            patient_id=patient_id, prior_prescription_id=prescription_id, note=note))
        await s.commit()
    return written


async def _row(database: Database, clinic: dict[str, Any], row_id: uuid.UUID) -> Any:
    async with session(database, clinic) as s:
        return (await s.execute(text(
            "SELECT m.*, (SELECT array_agg(d.text) FROM clinical.dosage d "
            "WHERE d.medication_request_id = m.id) AS sigs FROM clinical.medication_request m "
            "WHERE m.id = :i"), {"i": row_id})).one()


async def test_a_patient_asks_for_her_own_prescription_built_from_it_alone(
        database: Database, portal: Database, clinic: dict[str, Any]) -> None:
    patient, enc = await _visit(database, clinic)
    rx = await _prescribed(database, clinic, patient, enc)
    asked = await _ask(portal, clinic, patient.id, rx.id)
    row = await _row(database, clinic, asked.id)
    assert (row.intent, row.status, row.subject_patient_id, row.requester_patient_id,
            row.prior_prescription_id) == ("proposal", "active", patient.id, patient.id, rx.id)
    assert (row.medication_codeable_concept_code, row.ext_signed_at) == (AMOXICILLIN.code, None)
    assert row.sigs == ["1 capsule by mouth three times daily for 10 days"]   # copied
    assert row.dispense_request_performer_pharmacy_id is None                 # nothing else
    async with session(database, clinic) as s:
        author = (await s.execute(text(
            "SELECT a.who_patient_id FROM clinical.provenance p JOIN clinical.provenance_agent a "
            "ON a.provenance_id = p.id WHERE p.target_id = :i"), {"i": asked.id})).scalar()
        history = (await s.execute(text(
            "SELECT recorded_by_patient_id FROM clinical.fhir_resource_history "
            "WHERE resource_id = :i ORDER BY version_id DESC LIMIT 1"),
            {"i": asked.id})).scalar()
    assert author == patient.id and history == patient.id


async def test_requests_that_are_refused(database: Database, portal: Database,
                                         clinic: dict[str, Any]) -> None:
    patient, enc = await _visit(database, clinic)
    other, other_enc = await _visit(database, clinic)
    mine = await _prescribed(database, clinic, patient, enc)
    theirs = await _prescribed(database, clinic, other, other_enc)
    controlled = await _prescribed(database, clinic, patient, enc, OXYCODONE, dea="CII")
    unknown = await _prescribed(database, clinic, patient, enc, NOT_LOADED)
    async with session(database, clinic) as s:
        draft = await STORE.create_prescription(s, _draft(patient, enc, clinic))
        await s.commit()
    for prescription in (theirs.id, draft.id, uuid.uuid4()):     # not hers, a draft, missing
        with pytest.raises(fs.ResourceNotFound):
            await _ask(portal, clinic, patient.id, prescription)
    for prescription in (controlled.id, unknown.id):              # CII; schedule unreadable
        with pytest.raises(fs.RefillNotAllowed) as refused:
            await _ask(portal, clinic, patient.id, prescription)
        assert refused.value.current_state == "not-refillable"
    stopped = await _prescribed(database, clinic, patient, enc)
    async with session(database, clinic) as s:
        await s.execute(text("UPDATE clinical.medication_request SET status = 'stopped' "
                             "WHERE id = :i"), {"i": stopped.id})
        await s.commit()
    with pytest.raises(fs.RefillNotAllowed) as refused:
        await _ask(portal, clinic, patient.id, stopped.id)
    assert refused.value.current_state == "not-active"
    with pytest.raises(fs.InvalidInput):                          # no free text
        await _ask(portal, clinic, patient.id, mine.id, note="please hurry")
    with pytest.raises(fs.ResourceNotFound):                      # another patient's session
        await _ask(portal, clinic, other.id, mine.id)
    await _ask(portal, clinic, patient.id, mine.id)
    with pytest.raises(fs.RefillAlreadyRequested):                # one open request
        await _ask(portal, clinic, patient.id, mine.id)


async def test_a_request_is_never_a_medication(database: Database, portal: Database,
                                               clinic: dict[str, Any], admin_engine: Engine
                                               ) -> None:
    patient, enc = await _visit(database, clinic)
    rx = await _prescribed(database, clinic, patient, enc)
    asked = await _ask(portal, clinic, patient.id, rx.id)
    repo = SqlMedicationRepository()
    async with session(database, clinic) as s:
        listed = await repo.medications(s, patient.id, ("active", "completed", "stopped"),
                                        limit=100, offset=0)
        assert rx.id in {m.id for m in listed} and asked.id not in {m.id for m in listed}
        same_drug = await STORE.create_prescription(s, _draft(patient, enc, clinic))
        row = await repo.prescription(s, same_drug.id)
        assert row is not None
        facts = await repo.safety_facts(s, row)
        await s.rollback()
    on_the_list = {m.id for m in facts.medications}
    assert asked.id not in on_the_list and rx.id in on_the_list  # only the original can warn
    async with portal.patient_session(clinic["tenant"], patient.id) as s:
        portal_list = await SqlPortalMedicationReads().medications(s, patient.id, limit=100,
                                                                   offset=0)
    assert asked.id not in {m.id for m in portal_list}
    fhir = Database(Settings(database_url=SecretStr(TEST_DATABASE_URL or "")))
    switch_to_role(fhir.engine.sync_engine, "shri_fhir_reader", require_search_path=False)
    try:
        async with fhir.system_session(clinic["tenant"]) as s:
            seen = set((await s.execute(text(
                "SELECT id FROM clinical.medication_request WHERE subject_patient_id = :p"),
                {"p": patient.id})).scalars())
    finally:
        await fhir.dispose()
    assert rx.id in seen and asked.id not in seen               # /fhir never serves it


async def test_the_clinician_approves_with_a_draft_renewal_or_declines_with_set_words(
        database: Database, portal: Database, clinic: dict[str, Any]) -> None:
    """Approving changes the request only; the caller (#415's service) writes the renewal
    draft in the same transaction, and refill_renewal_id() finds it."""
    patient, enc = await _visit(database, clinic)
    rx = await _prescribed(database, clinic, patient, enc)
    asked = await _ask(portal, clinic, patient.id, rx.id)
    async with session(database, clinic) as s:
        approved = await STORE.respond_to_refill_request(s, asked.id, approve=True, reason=None,
                                                         if_version=asked.version)
        draft = await STORE.create_prescription(s, _draft(patient, enc, clinic,
                                                          prior_prescription_id=rx.id))
        renewal = await fs.refill_renewal_id(s, asked.id)
        await s.commit()
    assert renewal == draft.id
    assert renewal is not None
    request, renewed = (await _row(database, clinic, asked.id),
                        await _row(database, clinic, renewal))
    assert request.status == "completed" and approved.version > asked.version
    assert (renewed.intent, renewed.status, renewed.prior_prescription_id,
            renewed.medication_codeable_concept_code) == ("order", "draft", rx.id,
                                                          AMOXICILLIN.code)
    assert renewed.sigs == ["1 capsule by mouth three times daily for 10 days"]
    async with session(database, clinic) as s:                    # answered: final
        with pytest.raises(fs.InvalidTransition):
            await STORE.respond_to_refill_request(s, asked.id, approve=False,
                                                  reason="needs-visit",
                                                  if_version=approved.version)
    second = await _ask(portal, clinic, patient.id, rx.id)        # the earlier one is closed
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput):                      # no clinician free text
            await STORE.respond_to_refill_request(s, second.id, approve=False,
                                                  reason="call me", if_version=second.version)
    async with session(database, clinic) as s:
        await STORE.respond_to_refill_request(s, second.id, approve=False, reason="needs-visit",
                                              if_version=second.version)
        await s.commit()
    declined = await _row(database, clinic, second.id)
    assert (declined.status, declined.status_reason_code, declined.status_reason_text) == (
        "cancelled", "needs-visit", fs.REFILL_DECLINE_REASONS["needs-visit"])


async def test_execute_is_shri_portal_s_only_and_no_table_privilege(
        admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        execute = {role: c.execute(text(
            "SELECT has_function_privilege(:r, 'admin.portal_request_refill(uuid)', 'EXECUTE')"),
            {"r": role}).scalar()
            for role in ("shri_portal", "shri_app", "shri_fhir_reader", "shri_integration")}
        assert execute == {"shri_portal": True, "shri_app": False, "shri_fhir_reader": False,
                           "shri_integration": False}
        assert c.execute(text(
            "SELECT p.prosecdef AND p.proconfig = "
            "ARRAY['search_path=clinical, admin, audit, public, pg_temp'] "
            "AND pg_get_userbyid(p.proowner) = 'shri_migrator' FROM pg_proc p WHERE p.oid = "
            "'admin.portal_request_refill'::regproc")).scalar()
        assert not c.execute(text(
            "SELECT has_table_privilege('shri_portal', 'clinical.medication_request', 'INSERT') "
            "OR has_table_privilege('shri_portal', 'clinical.dosage', 'INSERT')")).scalar()


def test_a_second_open_request_is_refused_by_the_index(admin_engine: Engine) -> None:
    """The partial unique index, as the database states it."""
    with admin_engine.connect() as c:
        definition = c.execute(text(
            "SELECT indexdef FROM pg_indexes WHERE indexname = "
            "'uq_medication_request_open_refill'")).scalar()
    assert definition is not None and "UNIQUE" in definition
    assert "intent" in definition and "proposal" in definition and "active" in definition
