"""The prescription write helpers (D97: drafts, the safety check and its overrides, signing, the
transmission) against a live database, as shri_app through the core's tenant session. Fixtures
are test_fhir_store's; the visit is test_fhir_store_visits'."""
from __future__ import annotations

import secrets
import uuid
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

from app.core.db import Database
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant
from app.db.tests.test_fhir_store import _rows, clinic, database, session
from app.db.tests.test_fhir_store_visits import WHY, _facility, _visit

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["_facility", "clinic", "database"]   # fixtures, used by name

STORE = fs.SqlFhirStore()
AMOXICILLIN = fs.Coded(system=systems.RXNORM, code="308191",
                       display="amoxicillin 500 MG Oral Capsule")
ALLERGY_RULE, DUPLICATE_RULE = "allergy", "duplicate-medication"   # the platform's (0013)
LISINOPRIL = fs.Coded(system=systems.RXNORM, code="314076", display="lisinopril 10 MG Oral Tablet")


@pytest.fixture(autouse=True)
def _pharmacy(clinic: dict[str, Any], admin_engine: Engine) -> None:
    """A pharmacy in the platform directory."""
    clinic["pharmacy"] = uuid.uuid4()
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.pharmacy (id, ncpdp_id, name, is_mail_order, "
                       "is_active) VALUES (:i, :n, 'Test Pharmacy', false, true)"),
                  {"i": clinic["pharmacy"], "n": f"{secrets.randbelow(10**7):07d}"})


def _draft(patient: Any, enc: Any, clinic: dict[str, Any], **kw: Any) -> fs.PrescriptionIn:
    return fs.PrescriptionIn(**{
        "patient_id": patient.id, "encounter_id": enc.id, "medication": AMOXICILLIN,
        "dosage_text": "1 capsule by mouth three times daily for 10 days",
        "quantity": fs.DispenseQuantity(Decimal(30), "capsule"), "days_supply": 10,
        "refills": 0, "substitution_allowed": True, "pharmacy_id": clinic["pharmacy"], **kw})


async def _signed(database: Database, clinic: dict[str, Any], patient: Any, enc: Any
                  ) -> fs.Written:
    """A signed prescription with a clean safety check: an active medication of the patient."""
    async with session(database, clinic) as s:
        w = await STORE.create_prescription(s, _draft(patient, enc, clinic))
        await STORE.record_safety_check(s, w.id, (), if_version=w.version)
        signed = await STORE.sign_prescription(s, w.id, if_version=w.version)
        await s.commit()
    return signed


async def _allergy(database: Database, clinic: dict[str, Any], patient: Any) -> uuid.UUID:
    async with session(database, clinic) as s:
        w = await STORE.create_allergy(s, fs.AllergyIn(
            patient_id=patient.id, categories=("medication",),
            code=fs.Coded(system=systems.RXNORM, code="7980", display="Penicillin G")))
        await s.commit()
    return w.id


# ====================================================================== drafts
async def test_a_draft_is_written_changed_and_entered_in_error(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        w = await STORE.create_prescription(s, _draft(patient, enc, clinic))
        await s.commit()
    rid = {"r": w.id}
    row = _rows(admin_engine, "SELECT status, intent, requester_practitioner_id, "
                "dispense_request_quantity_value, dispense_request_expected_supply_duration_value,"
                " dispense_request_number_of_repeats_allowed, created_by_user_id, "
                "dispense_request_performer_pharmacy_id FROM clinical.medication_request "
                "WHERE id = :r", **rid)[0]
    assert tuple(row) == ("draft", "order", clinic["practitioner"], 30, 10, 0, clinic["user"],
                          clinic["pharmacy"])
    async with session(database, clinic) as s:
        with pytest.raises(fs.StaleVersion):
            await STORE.update_prescription(s, w.id, fs.PrescriptionChanges(days_supply=7),
                                            if_version=w.version + 1)
        w2 = await STORE.update_prescription(s, w.id, fs.PrescriptionChanges(
            days_supply=7, quantity=fs.DispenseQuantity(Decimal(21), "capsule"),
            dosage_text="1 capsule twice daily"), if_version=w.version)
        await s.commit()
    assert w2.version == w.version + 1
    assert [r.text for r in _rows(admin_engine, "SELECT text FROM clinical.dosage WHERE "
                                  "medication_request_id = :r", **rid)] == ["1 capsule twice daily"]
    async with session(database, clinic) as s:
        w3 = await STORE.prescription_entered_in_error(s, w.id, WHY, if_version=w2.version)
        await s.commit()
    prov = _rows(admin_engine, "SELECT target_version_id, reason_text, activity_code FROM "
                 "clinical.provenance WHERE target_id = :r", **rid)
    assert [tuple(p) for p in prov] == [(w3.version, "Wrong patient", "NULLIFY")]
    async with session(database, clinic) as s:
        for write in (STORE.update_prescription(s, w.id, fs.PrescriptionChanges(refills=1),
                                                if_version=w3.version),
                      STORE.prescription_entered_in_error(s, w.id, WHY)):
            with pytest.raises(fs.InvalidTransition):
                await write


async def test_drafts_that_cannot_be_written(database: Database,
                                             clinic: dict[str, Any]) -> None:
    patient, enc = await _visit(database, clinic)
    other, _ = await _visit(database, clinic)
    async with session(database, clinic) as s:
        for bad in (_draft(patient, enc, clinic, medication=fs.Coded(code="308191")),
                    _draft(patient, enc, clinic, medication=fs.Coded()),
                    _draft(other, enc, clinic)):                   # not this patient's visit
            with pytest.raises(fs.InvalidInput):
                await STORE.create_prescription(s, bad)
        with pytest.raises(fs.ResourceNotFound):
            await STORE.create_prescription(s, _draft(patient, enc, clinic,
                                                      pharmacy_id=uuid.uuid4()))


# ====================================================================== safety check, sign
async def test_the_check_and_overrides_never_move_the_drafts_version(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient, enc = await _visit(database, clinic)
    allergy = await _allergy(database, clinic, patient)
    active = await _signed(database, clinic, patient, enc)
    async with session(database, clinic) as s:
        w = await STORE.create_prescription(s, _draft(patient, enc, clinic))
        await s.commit()
    rid = {"r": w.id}

    def state() -> tuple[Any, ...]:
        return tuple(_rows(admin_engine, "SELECT meta_version_id, meta_last_updated, updated_at,"
                           " (SELECT count(*) FROM clinical.fhir_resource_history h WHERE "
                           "h.resource_id = m.id) FROM clinical.medication_request m "
                           "WHERE id = :r", **rid)[0])

    before = state()
    alerts = (fs.AlertIn(ALLERGY_RULE, "allergy", "high", "Active allergy to penicillin",
                         allergy_id=allergy),
              fs.AlertIn(DUPLICATE_RULE, "duplicate-medication", "warning",
                         "Already takes amoxicillin", medication_id=active.id))
    async with session(database, clinic) as s:
        check = await STORE.record_safety_check(s, w.id, alerts, if_version=w.version)
        await s.commit()
    assert state() == before and check.checked_version == w.version      # A58 (3)
    issues = _rows(admin_engine, "SELECT d.code_code, d.severity, d.status, count(i.*) AS n FROM "
                   "clinical.detected_issue d JOIN clinical.detected_issue_implicated i ON "
                   "i.detected_issue_id = d.id WHERE d.id = ANY(:ids) GROUP BY d.id ORDER BY "
                   "d.code_code", ids=list(check.alert_ids))
    assert [tuple(r) for r in issues] == [("ALGY", "high", "final", 2),
                                          ("DUPTHPY", "moderate", "final", 2)]
    high = check.alert_ids[0]
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput, match="override-required"):
            await STORE.sign_prescription(s, w.id, if_version=w.version)
        with pytest.raises(fs.InvalidInput):
            await STORE.override_alert(s, high, "  ok ")                # 3 characters, trimmed
        await STORE.override_alert(s, high, "Tolerated amoxicillin in 2024")
        await s.commit()
    assert state() == before
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidTransition):
            await STORE.override_alert(s, high, "Again")
        signed = await STORE.sign_prescription(s, w.id, if_version=w.version)
        await s.commit()
    row = _rows(admin_engine, "SELECT status, ext_signed_by_user_id, ext_signed_by_practitioner_id"
                " FROM clinical.medication_request WHERE id = :r", **rid)[0]
    assert tuple(row) == ("active", clinic["user"], clinic["practitioner"])
    prov = _rows(admin_engine, "SELECT p.target_version_id, p.activity_code, s.data_sha256 FROM "
                 "clinical.provenance p JOIN clinical.provenance_signature s ON s.provenance_id "
                 "= p.id WHERE p.target_id = :r", **rid)
    assert [(p.target_version_id, p.activity_code) for p in prov] == [(signed.version, "LA")]
    assert len(prov[0].data_sha256) == 64
    tx = _rows(admin_engine, "SELECT message_type, direction, status, pharmacy_id FROM "
               "admin.erx_transaction WHERE medication_request_id = :r", **rid)
    assert [tuple(t) for t in tx] == [("NewRx", "outbound", "queued", clinic["pharmacy"])]
    # frozen once signed: by the helpers, and by the database behind them
    async with session(database, clinic) as s:
        for write in (STORE.update_prescription(s, w.id, fs.PrescriptionChanges(refills=1),
                                                if_version=signed.version),
                      STORE.record_safety_check(s, w.id, (), if_version=signed.version),
                      STORE.override_alert(s, check.alert_ids[1], "Different dose"),
                      STORE.sign_prescription(s, w.id, if_version=signed.version)):
            with pytest.raises(fs.InvalidTransition):
                await write
    async with session(database, clinic) as s:
        with pytest.raises(DBAPIError, match="signed prescription"):
            await s.execute(text("UPDATE clinical.medication_request SET ext_safety_checked_at"
                                 " = now() WHERE id = :r"), rid)


async def test_signing_needs_a_current_check_and_what_the_pharmacy_needs(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        w = await STORE.create_prescription(s, _draft(patient, enc, clinic, pharmacy_id=None,
                                                      quantity=None))
        with pytest.raises(fs.InvalidInput, match="safety-check-stale"):
            await STORE.sign_prescription(s, w.id, if_version=w.version)
        first = await STORE.record_safety_check(s, w.id, (fs.AlertIn(
            ALLERGY_RULE, "allergy", "high", "Allergy"),), if_version=w.version)
        await s.commit()
    async with session(database, clinic) as s:
        w2 = await STORE.update_prescription(s, w.id, fs.PrescriptionChanges(
            pharmacy_id=clinic["pharmacy"]), if_version=w.version)
        await s.commit()
    async with session(database, clinic) as s:              # changed since the check
        with pytest.raises(fs.InvalidInput, match="/quantity.*safety-check-stale"):
            await STORE.sign_prescription(s, w.id, if_version=w2.version)
        with pytest.raises(fs.StaleVersion):                # the check ran on an old version
            await STORE.record_safety_check(s, w.id, (), if_version=w.version)
        await STORE.record_safety_check(s, w.id, (), if_version=w2.version)
        await s.commit()
    assert _rows(admin_engine, "SELECT status FROM clinical.detected_issue WHERE id = :i",
                 i=first.alert_ids[0])[0].status == "cancelled"      # the earlier check's


async def test_signing_names_each_refusal_where_get_shows_it(
        database: Database, clinic: dict[str, Any]) -> None:
    """#124 (Vimal): one errors entry per refusal, at the JSON Pointer the contract names."""
    patient, enc = await _visit(database, clinic)
    allergy = await _allergy(database, clinic, patient)
    async with session(database, clinic) as s:
        w = await STORE.create_prescription(s, _draft(patient, enc, clinic, dosage_text=None,
                                                      quantity=None, pharmacy_id=None))
        with pytest.raises(fs.SignRefused) as refused:           # each its own, combined
            await STORE.sign_prescription(s, w.id, if_version=w.version)
        assert refused.value.errors == (("/dosageText", "required"), ("/quantity", "required"),
                                        ("/pharmacyId", "required"),
                                        ("/alerts", "safety-check-stale"))
        assert "required at /quantity" in str(refused.value)
        w = await STORE.update_prescription(s, w.id, fs.PrescriptionChanges(
            dosage_text="1 capsule three times daily", pharmacy_id=clinic["pharmacy"],
            quantity=fs.DispenseQuantity(Decimal(30), "capsule")), if_version=w.version)
        check = await STORE.record_safety_check(s, w.id, (
            fs.AlertIn(ALLERGY_RULE, "allergy", "high", "Allergy", allergy_id=allergy),
            fs.AlertIn(DUPLICATE_RULE, "duplicate-medication", "warning", "Duplicate"),
            fs.AlertIn(ALLERGY_RULE, "allergy", "high", "Allergy, again")), if_version=w.version)
        order = await fs.prescription_alert_ids(s, w.id)
        assert sorted(order) == sorted(check.alert_ids)
        highs = [check.alert_ids[0], check.alert_ids[2]]
        with pytest.raises(fs.SignRefused) as refused:
            await STORE.sign_prescription(s, w.id, if_version=w.version)
        assert refused.value.errors == tuple(
            (f"/alerts/{order.index(a)}", "override-required") for a in sorted(
                highs, key=order.index))
        await STORE.override_alert(s, highs[0], "Tolerated it before")
        with pytest.raises(fs.SignRefused) as refused:           # only the other one is left
            await STORE.sign_prescription(s, w.id, if_version=w.version)
        assert refused.value.errors == ((f"/alerts/{order.index(highs[1])}",
                                         "override-required"),)
        await STORE.override_alert(s, highs[1], "Tolerated it before")
        await STORE.sign_prescription(s, w.id, if_version=w.version)
        await s.commit()


# ====================================================================== transmission
async def test_the_transmission_moves_forward_only(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient, enc = await _visit(database, clinic)
    signed = await _signed(database, clinic, patient, enc)
    async with session(database, clinic) as s:
        sent = await STORE.set_transmission_status(s, signed.id, "sent", vendor_message_id="V1")
        again = await STORE.set_transmission_status(s, signed.id, "sent")   # a repeated hook
        with pytest.raises(fs.InvalidInput):
            await STORE.set_transmission_status(s, signed.id, "error")       # needs its message
        done = await STORE.set_transmission_status(s, signed.id, "rejected",
                                                   message="Unknown prescriber")
        await s.commit()
    assert (sent.status, again.id, done.status) == ("sent", sent.id, "rejected")
    assert tuple(_rows(admin_engine, "SELECT status, error_message, vendor_message_id FROM "
                       "admin.erx_transaction WHERE id = :i", i=sent.id)[0]) == (
        "rejected", "Unknown prescriber", "V1")
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidTransition):
            await STORE.set_transmission_status(s, signed.id, "accepted")
        draft = await STORE.create_prescription(s, _draft(patient, enc, clinic))
        with pytest.raises(fs.ResourceNotFound):                          # not sent
            await STORE.set_transmission_status(s, draft.id, "sent")


# ====================================================================== another clinic
async def test_a_prescription_of_another_clinic_is_not_found(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        w = await STORE.create_prescription(s, _draft(patient, enc, clinic))
        check = await STORE.record_safety_check(s, w.id, (fs.AlertIn(
            ALLERGY_RULE, "allergy", "high", "Allergy"),), if_version=w.version)
        await s.commit()
    other = {**clinic, "tenant": make_tenant(admin_engine)}
    async with session(database, other) as s:
        for write in (STORE.create_prescription(s, _draft(patient, enc, clinic)),
                      STORE.update_prescription(s, w.id, fs.PrescriptionChanges(refills=1),
                                                if_version=w.version),
                      STORE.record_safety_check(s, w.id, (), if_version=w.version),
                      STORE.override_alert(s, check.alert_ids[0], "Benefit outweighs risk"),
                      STORE.sign_prescription(s, w.id, if_version=w.version),
                      STORE.prescription_entered_in_error(s, w.id, WHY)):
            with pytest.raises(fs.ResourceNotFound):
                await write


# ====================================================================== the medication list
async def test_a_reported_medication_is_on_the_list_unsigned_and_never_sent(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput):
            await STORE.record_medication(s, fs.MedicationIn(patient.id, LISINOPRIL,
                                                             status="draft"))
        w = await STORE.record_medication(s, fs.MedicationIn(
            patient.id, LISINOPRIL, dosage_text="1 tablet by mouth once daily",
            note="From the bottle", encounter_id=enc.id))
        await s.commit()
    rid = {"r": w.id}
    row = _rows(admin_engine, "SELECT status, intent, reported_boolean, ext_signed_at, "
                "requester_patient_id, created_by_user_id, (SELECT text FROM clinical.dosage"
                " d WHERE d.medication_request_id = m.id) AS sig, (SELECT text FROM "
                "clinical.annotation a WHERE a.medication_request_id = m.id) AS note FROM "
                "clinical.medication_request m WHERE id = :r", **rid)[0]
    assert tuple(row) == ("active", "plan", True, None, patient.id, clinic["user"],
                          "1 tablet by mouth once daily", "From the bottle")
    async with session(database, clinic) as s:       # not a prescription
        for write in (STORE.update_prescription(s, w.id, fs.PrescriptionChanges(refills=1),
                                                if_version=w.version),
                      STORE.record_safety_check(s, w.id, (), if_version=w.version),
                      STORE.sign_prescription(s, w.id, if_version=w.version),
                      STORE.prescription_entered_in_error(s, w.id, WHY)):
            with pytest.raises(fs.ResourceNotFound):
                await write
    async with session(database, clinic) as s:       # the database never sends one
        with pytest.raises(DBAPIError, match="never sent"):
            await s.execute(text(
                "INSERT INTO admin.erx_transaction (id, tenant_id, medication_request_id, "
                "message_type, direction, status, occurred_at) VALUES (gen_random_uuid(), :t, "
                ":r, 'NewRx', 'outbound', 'queued', now())"), {**rid, "t": clinic["tenant"]})
    # An unsigned active order is still refused, and so is a plan that nobody reported.
    for intent, reported in (("order", True), ("plan", None), ("plan", False)):
        async with session(database, clinic) as s:
            with pytest.raises(DBAPIError, match="active_requires_signature"):
                await s.execute(text(
                    "INSERT INTO clinical.medication_request (id, tenant_id, status, intent, "
                    "reported_boolean, subject_patient_id, requester_patient_id, "
                    "medication_codeable_concept_text) VALUES (gen_random_uuid(), :t, 'active', "
                    ":i, :rep, :p, :p, 'Lisinopril')"),
                    {"t": clinic["tenant"], "i": intent, "rep": reported, "p": patient.id})
    other = {**clinic, "tenant": make_tenant(admin_engine)}
    async with session(database, other) as s:
        with pytest.raises(fs.ResourceNotFound):
            await STORE.record_medication(s, fs.MedicationIn(patient.id, LISINOPRIL))


async def test_a_duplicate_alert_names_the_reported_medication(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        listed = await STORE.record_medication(s, fs.MedicationIn(patient.id, LISINOPRIL))
        w = await STORE.create_prescription(s, _draft(patient, enc, clinic, medication=LISINOPRIL))
        check = await STORE.record_safety_check(s, w.id, (fs.AlertIn(
            DUPLICATE_RULE, "duplicate-medication", "warning", "Already takes lisinopril",
            medication_id=listed.id),), if_version=w.version)
        await STORE.sign_prescription(s, w.id, if_version=w.version)   # no high alert
        await s.commit()
    named = _rows(admin_engine, "SELECT medication_request_id FROM clinical."
                  "detected_issue_implicated WHERE detected_issue_id = :i ORDER BY "
                  "medication_request_id = :w", i=check.alert_ids[0], w=w.id)
    assert [r.medication_request_id for r in named] == [listed.id, w.id]


# ====================================================================== the platform rules
async def test_the_platform_rules_are_every_clinics_and_nobodys_to_write(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    rules = _rows(admin_engine, "SELECT code, default_severity, is_suppressible, rule_source "
                  "FROM admin.cds_rule WHERE tenant_id IS NULL ORDER BY code")
    assert [tuple(r) for r in rules] == [("allergy", "high", False, "deterministic"),
                                         ("duplicate-medication", "moderate", False,
                                          "deterministic")]
    assert _rows(admin_engine, "SELECT relforcerowsecurity FROM pg_class WHERE oid = "
                 "'admin.cds_rule'::regclass")[0].relforcerowsecurity
    for each in (clinic, {**clinic, "tenant": make_tenant(admin_engine)}):  # every clinic reads
        async with session(database, each) as s:
            seen = (await s.execute(text("SELECT code FROM admin.cds_rule WHERE tenant_id IS "
                                         "NULL ORDER BY code"))).scalars().all()
            assert seen == ["allergy", "duplicate-medication"], each["tenant"]
    async with session(database, clinic) as s:
        changed = await s.execute(text("UPDATE admin.cds_rule SET is_active = false WHERE "
                                       "tenant_id IS NULL RETURNING id"))
        assert changed.all() == []                     # a clinic can't change one
        with pytest.raises(DBAPIError, match="row-level security"):
            await s.execute(text("INSERT INTO admin.cds_rule (id, tenant_id, code, name, "
                                 "alert_type, rule_source, default_severity, "
                                 "requires_override_reason, is_suppressible, is_active) VALUES "
                                 "(gen_random_uuid(), NULL, 'mine', 'Mine', 'dose', "
                                 "'deterministic', 'low', false, true, true)"))
