-- Changes to existing tables for migration 0012. Hand-written (names from the models). Frozen.

-- ======================================================================= admin.payer_enrollment
-- The key had no clinic, so a second clinic couldn't record the same enrollment with a platform
-- payer, and the error showed that the other clinic's row existed (#116).
ALTER TABLE admin.payer_enrollment
  DROP CONSTRAINT uq_payer_enrollment_payer_id_practitioner_id_transactio_c010;
ALTER TABLE admin.payer_enrollment
  ADD CONSTRAINT uq_payer_enrollment_tenant_id_payer_id_practitioner_id__a493
  UNIQUE NULLS NOT DISTINCT (tenant_id, payer_id, practitioner_id, transaction, clearinghouse);

-- ======================================================================== admin.patient_payment
-- D104: the receipt is made in the same transaction as the payment, so every payment has one.
ALTER TABLE admin.patient_payment ALTER COLUMN receipt_file_id SET NOT NULL;
ALTER TABLE admin.patient_payment ADD COLUMN check_number VARCHAR(40);
ALTER TABLE admin.patient_payment ADD COLUMN note VARCHAR(500);
ALTER TABLE admin.patient_payment ADD CONSTRAINT ck_patient_payment_check_number_method
  CHECK (check_number IS NULL OR method = 'check');

-- ========================================================================== admin.binary_object
-- The file service (API_STANDARDS §15): what a file is for, where it is in the upload flow,
-- and its data key, wrapped by core (envelope encryption), once it is clean. A file the server
-- makes (a receipt, an after-visit summary) is never uploaded, so it is clean from the start.
-- Files stored before 0012 are documents; a clean scan makes them clean, an infected one
-- rejected, and any other quarantined.
ALTER TABLE admin.binary_object ADD COLUMN purpose VARCHAR(40);
ALTER TABLE admin.binary_object ADD COLUMN state VARCHAR(40) DEFAULT 'pending-upload';
ALTER TABLE admin.binary_object ADD COLUMN wrapped_data_key TEXT;
UPDATE admin.binary_object SET purpose = 'document',
  state = CASE scan_status WHEN 'clean' THEN 'clean' WHEN 'infected' THEN 'rejected'
                           ELSE 'quarantined' END;
ALTER TABLE admin.binary_object ALTER COLUMN purpose SET NOT NULL;
ALTER TABLE admin.binary_object ALTER COLUMN state SET NOT NULL;
ALTER TABLE admin.binary_object ADD CONSTRAINT ck_binary_object_purpose_codes
  CHECK (purpose IN ('insurance-card', 'identity', 'receipt', 'encounter-audio',
                     'after-visit-summary', 'document', 'fax', 'ccda', 'export',
                     'onboarding-import'));
ALTER TABLE admin.binary_object ADD CONSTRAINT ck_binary_object_state_codes
  CHECK (state IN ('pending-upload', 'quarantined', 'clean', 'rejected'));
ALTER TABLE admin.binary_object ADD CONSTRAINT ck_binary_object_generated_clean
  CHECK (purpose NOT IN ('receipt', 'after-visit-summary') OR state = 'clean');
ALTER TABLE admin.binary_object ADD CONSTRAINT ck_binary_object_key_when_clean
  CHECK (state = 'clean' OR wrapped_data_key IS NULL);
ALTER TABLE admin.binary_object ADD CONSTRAINT ck_binary_object_clean_when_scanned
  CHECK (state <> 'clean' OR scan_status = 'clean'
         OR purpose IN ('receipt', 'after-visit-summary'));
