-- Changes to existing tables for migration 0011. Hand-written, from the models. Frozen.

-- Who wrote a version: a staff user, or the patient in a portal session (ADR-0013 §6).
ALTER TABLE clinical.fhir_resource_history
  ADD COLUMN recorded_by_patient_id UUID,
  ADD CONSTRAINT ck_fhir_resource_history_one_author
    CHECK (recorded_by_user_id IS NULL OR recorded_by_patient_id IS NULL);

-- A change request's inbox item is the same patient's (the same-patient key in 01 needs it).
ALTER TABLE admin.work_item ADD CONSTRAINT uq_work_item_patient_id_id UNIQUE (patient_id, id);
-- A hold's item is the same patient's; diagnostic_report and document_reference have this key
-- since 0001.
ALTER TABLE clinical.condition
  ADD CONSTRAINT uq_condition_subject_patient_id_id UNIQUE (subject_patient_id, id);
