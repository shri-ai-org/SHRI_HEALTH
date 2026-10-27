-- Changes to existing tables for A43 (issue #13, follow-up c). Hand-written; matches the models
-- (fhir/datatypes.py Identifier, admin/rcm.py PatientPayment, admin/platform.py PatientMerge).
-- Frozen: schema changes are new revisions. Every column is nullable with no default, so none of
-- these rewrites a table or fires a trigger.

-- ========================================================================== clinical.identifier
-- The scanned document behind a patient's identifier, e.g. a driver's license image (D56; the
-- contract's documentId). Only a patient's identifier has one, and only one of the same
-- patient's documents: a merge that moves the identifier moves its document in the same
-- transaction (the key is deferrable).
ALTER TABLE clinical.identifier ADD COLUMN supporting_document_id UUID;
ALTER TABLE clinical.identifier ADD CONSTRAINT ck_identifier_supporting_document_patient_only CHECK (supporting_document_id IS NULL OR patient_id IS NOT NULL);
ALTER TABLE clinical.identifier ADD CONSTRAINT fk_identifier_supporting_document_id_document_reference FOREIGN KEY(supporting_document_id) REFERENCES clinical.document_reference (id);
ALTER TABLE clinical.identifier ADD CONSTRAINT fk_identifier_supporting_document_id_same_patient FOREIGN KEY(patient_id, supporting_document_id) REFERENCES clinical.document_reference (subject_patient_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE clinical.identifier ADD CONSTRAINT fk_identifier_supporting_document_id_tenant FOREIGN KEY(tenant_id, supporting_document_id) REFERENCES clinical.document_reference (tenant_id, id);

-- ======================================================================= admin.patient_payment
-- The receipt PDF (D58), a file in this clinic, generated in the payment transaction.
ALTER TABLE admin.patient_payment ADD COLUMN receipt_file_id UUID;
ALTER TABLE admin.patient_payment ADD CONSTRAINT fk_patient_payment_receipt_file_id_binary_object FOREIGN KEY(receipt_file_id) REFERENCES admin.binary_object (id);
ALTER TABLE admin.patient_payment ADD CONSTRAINT fk_patient_payment_receipt_file_id_tenant FOREIGN KEY(tenant_id, receipt_file_id) REFERENCES admin.binary_object (tenant_id, id);

-- ========================================================================= admin.patient_merge
-- Both patients' versions before the merge, for the undo rule (D51; 04_functions.sql). Required
-- on every new merge (shri_patient_merge_versions). Merges recorded before this migration have
-- none, so they can no longer be undone.
ALTER TABLE admin.patient_merge ADD COLUMN surviving_patient_version INTEGER;
ALTER TABLE admin.patient_merge ADD COLUMN merged_patient_version INTEGER;
