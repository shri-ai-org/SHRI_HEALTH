-- What the patient portal reads of a note, for migration 0013. Frozen.
-- The co-signer's return-to-author comment, and when, is between clinicians (D73): shri_portal
-- reads every other column of clinical.composition (gen_db_rules.PORTAL_HIDDEN_COLUMNS). The
-- table-level SELECT of 0011 goes first, as it would cover the new columns.
REVOKE SELECT ON clinical.composition FROM shri_portal;
-- As generated (sql/93_portal.sql).
GRANT SELECT (status, type_system, type_code, type_display, type_text, category_system, category_code, category_display, category_text, subject_patient_id, encounter_id, date, title, confidentiality, custodian_organization_id, ext_template_id, ext_is_ai_assisted, ext_cosign_status, ext_cosigner_practitioner_id, meta_version_id, meta_last_updated, meta_txid, meta_security, extension, id, tenant_id, created_at, updated_at, created_by_user_id, updated_by_user_id, source_system, source_record_id, verified_at, entry_source, verified_by_user_id, ai_suggestion_id) ON clinical.composition TO shri_portal;
