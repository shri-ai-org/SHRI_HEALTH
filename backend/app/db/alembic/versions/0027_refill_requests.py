"""Refill requests: the patient portal asks for a prescription to be renewed (#400's
createPortalRefillRequest; #415; D93, D97; Anand's design on #85, approved 17 Nov).

A request is a MedicationRequest with intent `proposal`, status `active`, the patient as subject
and requester, and `prior_prescription_id` naming the prescription to renew. It is never a
medication: every list and rule that reads medications reads intent `plan` and `order` only, and
/fhir doesn't serve it.

  admin.portal_request_refill(p_prescription_id uuid) RETURNS uuid
      Takes only the prescription's ID. The request is built from the prescription, never from
      the caller: its drug and its sig (dosage), no free text. Refused unless the prescription
      is the session patient's (app.current_patient_id) in the session's clinic, intent order,
      signed, active, not labelled PSY, and not a controlled substance: its RxNorm concept must
      be loaded and have no dea_schedule, so a schedule that can't be read refuses (fail
      closed). Not the patient's or missing: P0002 (404). Refused: P0001 with constraint
      refill_not_active (not active or not signed) or refill_not_refillable (PSY, controlled,
      schedule unreadable): the contract's 409 invalid-state-transition, not-active or
      not-refillable. Already requested: the unique index below (409). It writes the
      request (draft, its sig, then active, as the dosage guard needs), its history version
      (recorded by the patient) and a Provenance with the patient as author.
      VOLATILE (it writes) SECURITY DEFINER, owner shri_migrator, search_path pinned to
      clinical, admin, audit, public, pg_temp, as the other writing definer functions (the
      tables' triggers name their tables unqualified; no role may create in those schemas);
      every name in the body is schema-qualified. EXECUTE for shri_portal only, nothing for
      PUBLIC. shri_portal gets no table privilege.
  uq_medication_request_open_refill
      One open request per prescription: unique (tenant_id, prior_prescription_id) where intent
      is proposal and status active.
  ck_medication_request_active_requires_signature
      Gains one arm: an active proposal with a patient requester and a prior prescription (a
      request is never signed).
  portal_fhir_no_refill_request
      A RESTRICTIVE policy for shri_fhir_reader: /fhir never serves a proposal.

Revision ID: 0027
Revises: 0026
Create Date: 2026-11-17
"""
from __future__ import annotations

from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None

_SIGNATURE_RULE = """
ALTER TABLE clinical.medication_request
  DROP CONSTRAINT ck_medication_request_active_requires_signature;
ALTER TABLE clinical.medication_request
  ADD CONSTRAINT ck_medication_request_active_requires_signature CHECK (
    status IN ('draft', 'cancelled', 'entered-in-error')
    OR entry_source IN ('imported', 'interface')
    OR (intent = 'plan' AND (reported_boolean IS TRUE OR reported_practitioner_id IS NOT NULL))
    OR (ext_signed_at IS NOT NULL AND ext_signed_by_practitioner_id IS NOT NULL)@PROPOSAL@);
"""
_PROPOSAL_ARM = """
    OR (intent = 'proposal' AND requester_patient_id IS NOT NULL
        AND prior_prescription_id IS NOT NULL)"""


def _signature_rule(proposal_arm: str) -> str:
    """0013's rule, with or without the proposal's arm (a constant of this file)."""
    return _SIGNATURE_RULE.replace("@PROPOSAL@", proposal_arm)


REFILLS = """
CREATE UNIQUE INDEX uq_medication_request_open_refill ON clinical.medication_request
  (tenant_id, prior_prescription_id) WHERE intent = 'proposal' AND status = 'active';

CREATE POLICY portal_fhir_no_refill_request ON clinical.medication_request AS RESTRICTIVE
  FOR SELECT TO shri_fhir_reader USING (intent <> 'proposal');

-- The patient's refill request, built from her own prescription only (D93, D97). It runs as the
-- migrator under forced row security (the session's clinic only) and names the session
-- patient itself, never one from its caller.
CREATE FUNCTION admin.portal_request_refill(p_prescription_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = clinical, admin, audit, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
  v_patient uuid := NULLIF(current_setting('app.current_patient_id', true), '')::uuid;
  v_rx clinical.medication_request%ROWTYPE;
  v_request uuid := gen_random_uuid();
  v_provenance uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_rx FROM clinical.medication_request m
   WHERE m.id = p_prescription_id AND m.tenant_id = v_tenant AND m.subject_patient_id = v_patient
     AND m.intent::text = 'order' AND m.status::text NOT IN ('draft', 'entered-in-error');
  IF NOT FOUND OR v_tenant IS NULL OR v_patient IS NULL THEN
    RAISE EXCEPTION 'prescription not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_rx.status::text <> 'active' OR v_rx.ext_signed_at IS NULL THEN
    RAISE EXCEPTION 'this prescription is not active'
      USING ERRCODE = 'P0001', CONSTRAINT = 'refill_not_active';
  END IF;
  IF coalesce(v_rx.meta_security, ARRAY[]::varchar[]) && ARRAY['PSY']::varchar[]
     OR v_rx.ext_dea_schedule IS NOT NULL
     OR v_rx.medication_codeable_concept_system IS DISTINCT FROM
        'http://www.nlm.nih.gov/research/umls/rxnorm'
     OR NOT EXISTS (SELECT 1 FROM admin.concept c
                      JOIN admin.code_system s ON s.id = c.code_system_id
                     WHERE s.uri = 'http://www.nlm.nih.gov/research/umls/rxnorm'
                       AND c.code = v_rx.medication_codeable_concept_code)
     OR EXISTS (SELECT 1 FROM admin.concept c
                  JOIN admin.code_system s ON s.id = c.code_system_id
                  JOIN admin.concept_property p ON p.concept_id = c.id
                 WHERE s.uri = 'http://www.nlm.nih.gov/research/umls/rxnorm'
                   AND c.code = v_rx.medication_codeable_concept_code
                   AND p.property = 'dea_schedule') THEN
    RAISE EXCEPTION 'this prescription cannot be refilled online'
      USING ERRCODE = 'P0001', CONSTRAINT = 'refill_not_refillable';
  END IF;
  INSERT INTO clinical.medication_request (
      id, tenant_id, status, intent, category, subject_patient_id, requester_patient_id,
      prior_prescription_id, medication_codeable_concept_system,
      medication_codeable_concept_code, medication_codeable_concept_display,
      medication_codeable_concept_text, authored_on, entry_source)
  VALUES (v_request, v_tenant, 'draft', 'proposal', v_rx.category, v_patient, v_patient,
          v_rx.id, v_rx.medication_codeable_concept_system, v_rx.medication_codeable_concept_code,
          v_rx.medication_codeable_concept_display, v_rx.medication_codeable_concept_text,
          now(), 'patient-reported');
  INSERT INTO clinical.dosage (id, tenant_id, medication_request_id, sequence, text,
                               patient_instruction)
  SELECT gen_random_uuid(), v_tenant, v_request, d.sequence, d.text, d.patient_instruction
    FROM clinical.dosage d WHERE d.medication_request_id = v_rx.id;
  UPDATE clinical.medication_request SET status = 'active' WHERE id = v_request;
  INSERT INTO clinical.provenance (id, tenant_id, target_resource_type, target_id,
                                   target_version_id, recorded, activity_system, activity_code,
                                   activity_display)
  SELECT v_provenance, v_tenant, 'MedicationRequest', v_request, m.meta_version_id, now(),
         'http://terminology.hl7.org/CodeSystem/v3-DataOperation', 'CREATE', 'create'
    FROM clinical.medication_request m WHERE m.id = v_request;
  INSERT INTO clinical.provenance_agent (id, tenant_id, provenance_id, type_system, type_code,
                                         who_patient_id)
  VALUES (gen_random_uuid(), v_tenant, v_provenance,
          'http://terminology.hl7.org/CodeSystem/provenance-participant-type', 'author',
          v_patient);
  RETURN v_request;
END $$;
ALTER FUNCTION admin.portal_request_refill(uuid) OWNER TO shri_migrator;
REVOKE ALL ON FUNCTION admin.portal_request_refill(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.portal_request_refill(uuid) TO shri_portal;
"""

DROP_REFILLS = """
DROP FUNCTION admin.portal_request_refill(uuid);
DROP POLICY portal_fhir_no_refill_request ON clinical.medication_request;
DROP INDEX clinical.uq_medication_request_open_refill;
"""


def upgrade() -> None:
    op.execute(_signature_rule(_PROPOSAL_ARM))
    op.execute(REFILLS)


def downgrade() -> None:
    # A proposal can't satisfy 0013's rule: refuse rather than leave rows the old check rejects.
    op.execute("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM clinical.medication_request WHERE intent = 'proposal'
                AND status NOT IN ('draft', 'cancelled', 'entered-in-error')) THEN
    RAISE EXCEPTION 'refill requests exist; 0027 cannot be downgraded';
  END IF;
END $$;""")
    op.execute(DROP_REFILLS)
    op.execute(_signature_rule(""))
