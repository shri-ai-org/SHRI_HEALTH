-- Downgrade of migration 0018: shri_integration has only what 0004, 0005 and 0015 gave it.
REVOKE ALL ON clinical.appointment, clinical.appointment_participant, clinical.coverage,
  clinical.coverage_class, clinical.coverage_payor, clinical.dosage, clinical.encounter,
  clinical.human_name, clinical.identifier, clinical.medication_request, clinical.organization,
  clinical.patient, clinical.related_person FROM shri_integration;
REVOKE ALL ON admin.eligibility_check, admin.eligibility_service_type, admin.facility,
  admin.payer, admin.payer_clearinghouse_id, admin.pharmacy, admin.tenant FROM shri_integration;
REVOKE SELECT (created_by_user_id, created_at, updated_at, completed_at, result_type, result_id,
               error) ON admin.operation FROM shri_integration;
REVOKE UPDATE (updated_by_user_id) ON admin.operation FROM shri_integration;
