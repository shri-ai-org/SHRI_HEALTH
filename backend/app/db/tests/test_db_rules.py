"""The integrity rules hold in a live PostgreSQL database, independent of the API."""
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
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant, open_session

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS


def fails(db: Session, sqlstate: str, constraint: str | None = None,
          message: str | None = None) -> Any:
    """Context manager: the block must fail with this SQLSTATE (and constraint / message)."""
    class _Ctx:
        def __enter__(self) -> Any:
            self.sp = db.begin_nested()
            return self

        def __exit__(self, et: Any, ev: Any, tb: Any) -> bool:
            assert et is not None and issubclass(et,
                                                 DBAPIError), f"expected {sqlstate}, got success"
            orig = ev.orig
            assert orig.sqlstate == sqlstate, f"{orig.sqlstate}: {orig}"
            if constraint:
                assert orig.diag.constraint_name == constraint, orig.diag.constraint_name
            if message:
                assert message in str(orig), str(orig)
            self.sp.rollback()
            return True
    return _Ctx()


# =========================================================================== datatypes
def test_npi_check_digit(db: Session) -> None:
    ok, bad = db.execute(text("SELECT shri_npi_valid('1234567893'), "
                              "shri_npi_valid('1234567890')")).one()
    assert ok and not bad
    with fails(db, "23514", "ck_identifier_npi_valid"):
        p = M["practitioner"]()
        p.identifier = [M["identifier"](system=systems.NPI, value="1234567890")]
        db.add(p)
        db.flush()


def test_ssn_never_stored_in_clear(db: Session) -> None:
    pt = b.patient(db)
    with fails(db, "23514", "ck_identifier_ssn_not_clear_text"):
        db.add(M["identifier"](patient_id=pt.id, system=systems.SSN, value="123-45-6789"))
        db.flush()
    db.add(M["identifier"](patient_id=pt.id, system=systems.SSN, value="***-**-6789"))
    db.flush()


def test_identifier_needs_exactly_one_owner(db: Session) -> None:
    pt = b.patient(db)
    ctx = b.practitioner(db, "Shah", "Ravi")
    with fails(db, "23514", "ck_identifier_one_owner"):
        db.add(M["identifier"](patient_id=pt.id, practitioner_id=ctx["practitioner"].id,
                               system="urn:x", value="1"))
        db.flush()


def test_mrn_unique_per_tenant(db: Session) -> None:
    p1 = b.patient(db)
    mrn = p1.identifier[0]
    with fails(db, "23505", "uq_identifier_patient_value"):
        p2 = b.patient(db, "Other", "Person")
        db.add(M["identifier"](patient_id=p2.id, system=mrn.system, value=mrn.value))
        db.flush()


def test_coding_needs_registered_system(db: Session) -> None:
    pt = b.patient(db)
    with fails(db, "23503"):
        db.add(M["condition"](subject_patient_id=pt.id, clinical_status="active",
                              code_system=systems.ICD10CM, code_code="R51.9",
                              severity_system="http://example.org/not-registered",
                              severity_code="X"))
        db.flush()


# =========================================================================== FHIR invariants
def test_condition_con_4_and_con_5(db: Session) -> None:
    pt = b.patient(db)
    with fails(db, "23514", "ck_condition_fhir_con_4"):
        db.add(M["condition"](subject_patient_id=pt.id, clinical_status="active",
                              code_system=systems.ICD10CM, code_code="J01.90",
                              abatement_date_time=b.NOW))
        db.flush()
    with fails(db, "23514", "ck_condition_fhir_con_5"):
        db.add(M["condition"](subject_patient_id=pt.id, clinical_status="active",
                              verification_status="entered-in-error",
                              code_system=systems.ICD10CM, code_code="J01.90"))
        db.flush()


def test_condition_code_binding_and_required_code(db: Session) -> None:
    pt = b.patient(db)
    with fails(db, "23514", "ck_condition_code_system_binding"):
        db.add(M["condition"](subject_patient_id=pt.id, clinical_status="active",
                              code_system=systems.LOINC, code_code="1234-5"))
        db.flush()
    with fails(db, "23514", "ck_condition_fhir_code_required"):
        db.add(M["condition"](subject_patient_id=pt.id, clinical_status="active"))
        db.flush()


def test_allergy_ait_1(db: Session) -> None:
    pt = b.patient(db)
    with fails(db, "23514", "ck_allergy_intolerance_fhir_ait_1"):
        db.add(M["allergy_intolerance"](patient_id=pt.id, verification_status="confirmed",
                                        code_system=systems.RXNORM, code_code="7980"))
        db.flush()
    with fails(db, "23514", "ck_allergy_intolerance_category_codes"):
        db.add(M["allergy_intolerance"](patient_id=pt.id, clinical_status="active",
                                        category=["medication", "pollen"],
                                        code_system=systems.RXNORM, code_code="7980"))
        db.flush()


def test_observation_value_x_and_obs_6(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx)
    base = dict(status="final", code_system=systems.LOINC, code_code="72166-2",
                subject_patient_id=pt.id, encounter_id=enc.id, effective_date_time=b.NOW)
    with fails(db, "23514", "ck_observation_fhir_value_x"):
        db.add(M["observation"](value_string="never", value_boolean=False, **base))
        db.flush()
    with fails(db, "23514", "ck_observation_fhir_obs_6"):
        db.add(M["observation"](value_string="never",
                                data_absent_reason_system=systems.DATA_ABSENT_REASON,
                                data_absent_reason_code="unknown", **base))
        db.flush()
    with fails(db, "23514", "ck_observation_fhir_value_quantity_qty_3"):
        db.add(M["observation"](value_quantity_value=5, value_quantity_code="mg", **base))
        db.flush()


def test_reference_arc_exactly_one(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx)
    obs = b.blood_pressure(db, pt, enc, status="preliminary")
    with fails(db, "23514", "ck_observation_performer_fhir_performer_arc"):
        db.add(M["observation_performer"](observation_id=obs.id,
                                          practitioner_id=ctx["practitioner"].id,
                                          organization_id=ctx["org"].id))
        db.flush()
    with fails(db, "23514", "ck_observation_performer_fhir_performer_arc"):
        db.add(M["observation_performer"](observation_id=obs.id))
        db.flush()


def test_appointment_invariants(db: Session) -> None:
    pt = b.patient(db)
    with fails(db, "23514", "ck_appointment_fhir_app_3"):
        db.add(M["appointment"](status="booked", subject_patient_id=pt.id))
        db.flush()
    with fails(db, "23514", "ck_appointment_fhir_app_4"):
        db.add(M["appointment"](status="booked", subject_patient_id=pt.id, start=b.NOW,
                                end=b.NOW + dt.timedelta(minutes=15),
                                cancelation_reason_text="patient called"))
        db.flush()


# =========================================================================== tenancy / patient
def test_tenant_isolation_and_cross_tenant_reference(app_engine: Engine,
                                                     admin_engine: Engine) -> None:
    t1, t2 = make_tenant(admin_engine), make_tenant(admin_engine)
    s1 = open_session(app_engine, t1)
    pt = b.patient(s1)
    s1.commit()
    s2 = open_session(app_engine, t2)
    try:
        assert s2.get(M["patient"], pt.id) is None            # RLS hides it
        with fails(s2, "23503"):                               # composite tenant FK
            s2.add(M["condition"](subject_patient_id=pt.id, clinical_status="active",
                                  code_system=systems.ICD10CM, code_code="R51.9"))
            s2.flush()
        with fails(s2, "42501"):                               # RLS WITH CHECK
            s2.execute(text("INSERT INTO human_name (id, tenant_id, patient_id, family) "
                            "VALUES (gen_random_uuid(), :t, :p, 'X')"), {"t": t1, "p": pt.id})
    finally:
        s1.close()
        s2.close()


def test_no_tenant_set_sees_nothing(app_engine: Engine, admin_engine: Engine) -> None:
    t = make_tenant(admin_engine)
    s = open_session(app_engine, t)
    b.patient(s)
    s.commit()
    s.close()
    with app_engine.connect() as c:
        assert c.execute(text("SELECT count(*) FROM patient")).scalar() == 0


def test_same_patient_references(db: Session) -> None:
    ctx = b.practice(db)
    p1, p2 = b.patient(db), b.patient(db, "Other", "Person")
    enc_of_p2 = b.encounter(db, p2, ctx)
    with fails(db, "23503", "fk_observation_encounter_id_same_patient"):
        db.add(M["observation"](status="final", code_system=systems.LOINC, code_code="8867-4",
                                subject_patient_id=p1.id, encounter_id=enc_of_p2.id,
                                effective_date_time=b.NOW, value_quantity_value=72))
        db.flush()


def test_deletes_only_on_child_rows(db: Session) -> None:
    pt = b.patient(db)
    db.commit()
    db.delete(pt.telecom[0])          # a child row of an editable resource: allowed
    db.flush()
    with fails(db, "42501"):
        db.execute(text("DELETE FROM patient WHERE id = :i"), {"i": pt.id})


# =========================================================================== versioning
def test_version_bumps_once_per_transaction_and_history_has_children(db: Session) -> None:
    pt = b.patient(db)
    db.commit()
    assert pt.meta_version_id == 1
    pt.name[0].given = ["Mai", "Lan"]                 # child change only
    db.add(M["contact_point"](patient_id=pt.id, system="email", value="mai@example.com"))
    db.commit()
    db.refresh(pt)
    assert pt.meta_version_id == 2                    # one bump for the whole transaction
    snaps = db.execute(text("SELECT version_id, snapshot FROM fhir_resource_history "
                            "WHERE resource_id = :i ORDER BY version_id"), {"i": pt.id}).all()
    assert [v for v, _ in snaps] == [1, 2]
    v1, v2 = snaps[0][1], snaps[1][1]
    assert v1["_children"]["human_name"][0]["given"] == ["Mai"]
    assert v2["_children"]["human_name"][0]["given"] == ["Mai", "Lan"]
    assert len(v2["_children"]["contact_point"]) == 2


def test_history_is_not_writable_by_the_api_role(db: Session) -> None:
    with fails(db, "42501"):
        db.execute(text("INSERT INTO fhir_resource_history (tenant_id, resource_type, "
                        "resource_id, version_id, snapshot) VALUES (:t, 'Patient', "
                        "gen_random_uuid(), 1, '{}')"), {"t": db.info["tenant_id"]})


# =========================================================================== notes
def test_signed_note_rules(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx)
    note = b.note(db, pt, enc, ctx)
    db.commit()

    note.status = "final"                               # no signature yet
    with pytest.raises(DBAPIError, match="no legal attester"):
        db.commit()
    db.rollback()

    b.sign_note(db, note, ctx)
    db.commit()
    with fails(db, "P0001", message="signed note"):
        note.title = "Edited after signing"
        db.flush()
    db.rollback()
    with fails(db, "P0001", message="cannot change"):
        db.add(M["composition_section"](composition_id=note.id, sequence=2, title="Late",
                                        text_div="<div>late</div>"))
        db.flush()
    # co-signature after signing is allowed; changing an attestation is not
    sup = b.practitioner(db, "Okafor", "Chidi")
    b.sign_note(db, note, {**ctx, **sup}, mode="professional")
    db.commit()
    with fails(db, "42501"):        # attestations: no UPDATE privilege, trigger behind it
        db.execute(text("UPDATE composition_attester SET time = now() WHERE composition_id = :c"),
                   {"c": note.id})


def test_attester_must_be_the_users_practitioner(db: Session) -> None:
    ctx = b.practice(db)
    other = b.practitioner(db, "Lee", "Ann")
    pt = b.patient(db)
    note = b.note(db, pt, b.encounter(db, pt, ctx), ctx)
    with fails(db, "P0001", message="not linked"):
        b.sign_note(db, note, {"practitioner": other["practitioner"], "user": ctx["user"]})


def test_ai_drafted_section_must_be_reviewed_before_signing(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx)
    req = M["ai_request"](feature="ambient-documentation", status="completed",
                          pipeline_version="t", patient_id=pt.id, encounter_id=enc.id)
    db.add(req)
    db.flush()
    sug = M["ai_suggestion"](ai_request_id=req.id, feature="ambient-documentation",
                             patient_id=pt.id, encounter_id=enc.id,
                             target_resource_type="Composition", content={"hpi": "..."},
                             confidence="medium", rationale="from transcript")
    db.add(sug)
    note = b.note(db, pt, enc, ctx)
    note.section[0].ai_suggestion_id = sug.id
    db.commit()
    b.sign_note(db, note, ctx)
    with pytest.raises(DBAPIError, match="was not accepted or edited"):
        db.commit()
    db.rollback()
    sug.decision, sug.decided_by_user_id, sug.decided_at = "accepted", ctx["user"].id, b.NOW
    db.commit()
    b.sign_note(db, note, ctx)
    db.commit()
    with fails(db, "P0001", message="immutable"):
        sug.content = {"hpi": "rewritten"}
        db.flush()


def test_provenance_with_agents_and_existing_target(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    prov = M["provenance"](target_resource_type="Patient", target_id=pt.id, recorded=b.NOW,
                           activity_system=systems.V3_DATA_OPERATION, activity_code="CREATE")
    prov.agent = [M["provenance_agent"](who_practitioner_id=ctx["practitioner"].id)]
    db.add(prov)
    db.commit()
    with fails(db, "P0001", message="does not exist"):
        db.add(M["provenance"](target_resource_type="Patient", target_id=uuid.uuid4(),
                               recorded=b.NOW))
        db.flush()


# =========================================================================== prescriptions
def test_prescription_rules(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx)
    mr = b.prescription(db, pt, enc, ctx)
    with fails(db, "23514", "ck_medication_request_active_requires_signature"):
        mr.status = "active"
        db.flush()
    db.refresh(mr)
    b.sign_prescription(db, mr, ctx)
    db.commit()
    with fails(db, "P0001", message="signed prescription"):
        mr.dispense_request_quantity_value = 30
        db.flush()
    db.rollback()
    with fails(db, "P0001", message="cannot change"):
        mr.dosage_instruction[0].text = "Take 2 tablets"
        db.flush()


def test_controlled_substance_refill_limits(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx)
    with fails(db, "23514", "ck_medication_request_cii_no_refills"):
        b.prescription(db, pt, enc, ctx, ext_dea_schedule="CII")


def test_high_severity_alert_needs_override_reason(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx)
    mr = b.prescription(db, pt, enc, ctx)
    rule = M["cds_rule"](tenant_id=db.info["tenant_id"], code="ddi-ssri-triptan",
                         name="SSRI + triptan", alert_type="drug-interaction",
                         default_severity="high", is_suppressible=False)
    db.add(rule)
    db.flush()
    issue = M["detected_issue"](status="final", severity="high", patient_id=pt.id,
                                code_system=systems.V3_ACT_CODE, code_code="DRG",
                                ext_cds_rule_id=rule.id, identified_date_time=b.NOW)
    issue.implicated = [M["detected_issue_implicated"](medication_request_id=mr.id)]
    db.add(issue)
    db.commit()
    b.sign_prescription(db, mr, ctx)
    with pytest.raises(DBAPIError, match="without an override reason"):
        db.commit()
    db.rollback()
    db.add(M["detected_issue_mitigation"](detected_issue_id=issue.id,
                                          action_system=systems.V3_ACT_CODE,
                                          action_code="EMAUTH", date=b.NOW,
                                          author_practitioner_id=ctx["practitioner"].id,
                                          ext_reason="Benefit outweighs risk; counselled"))
    db.commit()
    b.sign_prescription(db, mr, ctx)
    db.commit()


def test_high_severity_rule_cannot_be_suppressed(db: Session) -> None:
    ctx = b.practice(db)
    rule = M["cds_rule"](tenant_id=db.info["tenant_id"], code="dose-max", name="Max dose",
                         alert_type="dose", default_severity="high", is_suppressible=False)
    db.add(rule)
    db.flush()
    with fails(db, "23503", "fk_user_alert_suppression_rule_suppressible"):
        db.add(M["user_alert_suppression"](user_id=ctx["user"].id, cds_rule_id=rule.id))
        db.flush()


# =========================================================================== results
def test_final_result_corrected_not_edited(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx)
    obs = M["observation"](status="final", code_system=systems.LOINC, code_code="2345-7",
                           subject_patient_id=pt.id, encounter_id=enc.id,
                           effective_date_time=b.NOW, value_quantity_value=99)
    db.add(obs)
    db.commit()
    with fails(db, "P0001", message="corrected or amended"):
        obs.value_quantity_value = 199
        db.flush()
    db.rollback()
    obs.value_quantity_value, obs.status = 199, "corrected"
    db.commit()
    versions = db.execute(text("SELECT snapshot->>'value_quantity_value' FROM "
                               "fhir_resource_history WHERE resource_id = :i ORDER BY version_id"),
                          {"i": obs.id}).scalars().all()
    assert [float(v) for v in versions] == [99.0, 199.0]
    with fails(db, "P0001", message="cannot go back"):
        obs.status = "preliminary"
        db.flush()


# =========================================================================== scheduling
def test_no_double_booking_unless_overbook(db: Session) -> None:
    ctx = b.practice(db)
    p1, p2 = b.patient(db), b.patient(db, "Other", "Person")

    def book(pt: Any, start: dt.datetime, **kw: Any) -> Any:
        a = M["appointment"](status="booked", subject_patient_id=pt.id, start=start,
                             end=start + dt.timedelta(minutes=30), **kw)
        a.participant = [M["appointment_participant"](actor_practitioner_id=ctx["practitioner"].id,
                                                      status="accepted"),
                         M["appointment_participant"](actor_patient_id=pt.id, status="accepted")]
        db.add(a)
        db.flush()
        return a

    first = book(p1, b.NOW)
    with fails(db, "23P01", "ex_appointment_participant_no_double_booking"):
        book(p2, b.NOW + dt.timedelta(minutes=15))
    book(p2, b.NOW + dt.timedelta(minutes=15), ext_overbook=True)       # allowed overbook
    first.status, first.ext_cancelled_at = "cancelled", b.NOW
    db.flush()
    book(p2, b.NOW + dt.timedelta(minutes=5))                          # slot freed


# =========================================================================== billing
def test_charge_pointer_must_be_on_its_own_encounter(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx, status="finished")
    other = b.encounter(db, pt, ctx, status="finished")
    cond = b.condition(db, pt, enc)
    db.add(M["encounter_diagnosis"](encounter_id=enc.id, condition_id=cond.id, rank=1))
    sb = M["superbill"](encounter_id=enc.id, patient_id=pt.id,
                        rendering_practitioner_id=ctx["practitioner"].id,
                        facility_id=ctx["facility"].id)
    db.add(sb)
    db.flush()
    ch = M["charge"](superbill_id=sb.id, encounter_id=enc.id, line_number=1,
                     code_system=systems.CPT, code="99214", units=1, unit_charge=150,
                     total_charge=150, service_date=b.NOW.date())
    db.add(ch)
    db.flush()
    db.add(M["charge_diagnosis_pointer"](charge_id=ch.id, encounter_id=enc.id, position=1,
                                         diagnosis_rank=1))
    db.flush()
    with fails(db, "23503"):
        db.add(M["charge_diagnosis_pointer"](charge_id=ch.id, encounter_id=enc.id, position=2,
                                             diagnosis_rank=2))     # no rank-2 diagnosis
        db.flush()
    ch2 = M["charge"](superbill_id=sb.id, encounter_id=enc.id, line_number=3,
                      code_system=systems.CPT, code="99000", units=1, unit_charge=5,
                      total_charge=5, service_date=b.NOW.date())
    db.add(ch2)
    db.flush()
    with fails(db, "23503", "fk_charge_dx_pointer_charge_encounter"):
        db.add(M["charge_diagnosis_pointer"](charge_id=ch2.id, encounter_id=other.id,
                                             position=1, diagnosis_rank=1))
        db.flush()
    with fails(db, "23514", "ck_charge_total_matches"):
        db.add(M["charge"](superbill_id=sb.id, encounter_id=enc.id, line_number=2,
                           code_system=systems.CPT, code="36415", units=2, unit_charge=10,
                           total_charge=25, service_date=b.NOW.date()))
        db.flush()


def test_card_numbers_never_stored(db: Session) -> None:
    pt = b.patient(db)
    with fails(db, "23514", "ck_patient_payment_no_card_number"):
        db.add(M["patient_payment"](patient_id=pt.id, amount=25, method="card",
                                    processor_reference="4111 1111 1111 1111",
                                    collected_at=b.NOW))
        db.flush()


# =========================================================================== AI / consent
def test_audio_requires_ambient_recording_consent(db: Session) -> None:
    ctx = b.practice(db)
    pt = b.patient(db)
    enc = b.encounter(db, pt, ctx)
    treat = M["consent"](status="active", scope_system=systems.CONSENT_SCOPE,
                         scope_code="treatment", patient_id=pt.id, date_time=b.NOW,
                         ext_kind="treatment", ext_signature_method="electronic")
    db.add(treat)
    db.flush()
    with fails(db, "23503", "fk_audio_recording_consent_kind"):
        db.add(M["audio_recording"](encounter_id=enc.id, patient_id=pt.id, consent_id=treat.id,
                                    mode="ambient"))
        db.flush()
    amb = M["consent"](status="active", scope_system=systems.CONSENT_SCOPE,
                       scope_code="patient-privacy", patient_id=pt.id, date_time=b.NOW,
                       ext_kind="ambient-recording", ext_signature_method="verbal")
    db.add(amb)
    db.flush()
    db.add(M["audio_recording"](encounter_id=enc.id, patient_id=pt.id, consent_id=amb.id,
                                mode="ambient"))
    db.flush()


def test_ai_generated_rows_need_an_accepted_suggestion(db: Session) -> None:
    pt = b.patient(db)
    with fails(db, "P0001", message="needs an accepted or edited ai_suggestion"):
        db.add(M["condition"](subject_patient_id=pt.id, clinical_status="active",
                              code_system=systems.ICD10CM, code_code="R51.9",
                              entry_source="ai-generated"))
        db.flush()


# =========================================================================== audit
def test_audit_chain_detects_tampering(app_engine: Engine, admin_engine: Engine) -> None:
    t = make_tenant(admin_engine)
    s = open_session(app_engine, t)
    for action in ("read", "read", "export"):
        s.add(M["audit_event"](tenant_id=t, actor_type="system", action=action,
                               outcome="success"))
        s.flush()
    s.commit()
    # shri_audit_verify is reviewed with admin_engine throughout, not the app role: shri_app is
    # insert-only on audit_event (D23) and the function isn't SECURITY DEFINER (deliberately -
    # it must see the real stored hash under whatever RLS bypass its *caller* has, not the
    # function owner's, since its whole purpose is checking a specific tenant on request,
    # independent of whatever tenant context the caller's own session happens to be in).
    with admin_engine.begin() as c0:
        assert c0.execute(text("SELECT count(*) FROM shri_audit_verify(:t)"),
                          {"t": t}).scalar() == 0
    with fails(s, "42501"):          # no UPDATE privilege (and a trigger behind it)
        s.execute(text("UPDATE audit_event SET action = 'read' WHERE tenant_id = :t"), {"t": t})
    s.close()
    with admin_engine.begin() as c:   # a superuser bypassing the trigger is still detected
        # postgres (admin_engine) has no search_path override (only the 5 service roles do -
        # see sql/00_extensions.sql), so these need the schema qualified explicitly.
        c.execute(text(
            "ALTER TABLE audit.audit_event DISABLE TRIGGER trg_audit_event_insert_only"))
        c.execute(text("UPDATE audit.audit_event SET action = 'read' WHERE tenant_id = :t "
                       "AND action = 'export'"), {"t": t})
        c.execute(text(
            "ALTER TABLE audit.audit_event ENABLE TRIGGER trg_audit_event_insert_only"))
        problems = c.execute(text("SELECT problem FROM shri_audit_verify(:t)"),
                             {"t": t}).scalars().all()
    assert any("hash mismatch" in p for p in problems)


# =========================================================================== catalog
def test_every_tenant_table_has_forced_rls(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        missing = c.execute(text("""
            SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
            WHERE n.nspname IN ('clinical', 'admin', 'audit') AND c.relkind = 'r'
              AND NOT c.relforcerowsecurity""")
        ).scalars().all()
    assert missing == []


def test_every_fk_between_tenant_tables_is_tenant_consistent(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        missing = c.execute(text("""
            SELECT con.conrelid::regclass || '.' || a.attname
              FROM pg_constraint con
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
             WHERE con.contype = 'f' AND cardinality(con.conkey) = 1 AND a.attname <> 'tenant_id'
               AND EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = con.conrelid
                             AND t.attname = 'tenant_id' AND t.attnotnull)
               AND EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = con.confrelid
                             AND t.attname = 'tenant_id' AND t.attnotnull)
               AND NOT EXISTS (SELECT 1 FROM pg_constraint c2 WHERE c2.contype = 'f'
                             AND c2.conrelid = con.conrelid AND c2.confrelid = con.confrelid
                             AND cardinality(c2.conkey) = 2 AND con.conkey[1] = ANY (c2.conkey))
        """)).scalars().all()
    assert missing == []


def test_no_virtual_generated_columns(admin_engine: Engine) -> None:
    """D34: every computed column is STORED. PostgreSQL 18 makes a generated column VIRTUAL by
    default when STORED/VIRTUAL is omitted, and a VIRTUAL column cannot be indexed (e.g.
    content_tsv and its GIN index) - this is the schema test the decision requires."""
    with admin_engine.connect() as c:
        virtual = c.execute(text("""
            SELECT c.relname || '.' || a.attname
              FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname IN ('clinical', 'admin', 'audit') AND a.attgenerated = 'v'""")
        ).scalars().all()
    assert virtual == []
