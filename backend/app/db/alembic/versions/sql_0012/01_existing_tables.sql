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
