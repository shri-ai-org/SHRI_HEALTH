-- shri_integration reads what the NewRx and the eligibility request need (Vimal on #85 and
-- #157), for migration 0018. As generated (sql/90_rls_grants.sql, gen_db_rules
-- INTEGRATION_READ_TABLES, INTEGRATION_COLUMN_READ, INTEGRATION_COLUMN_UPDATE). Frozen.
-- Each clinic table's tenant_isolation policy (no TO clause) keeps it to the clinic it works in.
GRANT SELECT ON clinical.appointment TO shri_integration;
GRANT SELECT ON clinical.appointment_participant TO shri_integration;
GRANT SELECT ON clinical.coverage TO shri_integration;
GRANT SELECT ON clinical.coverage_class TO shri_integration;
GRANT SELECT ON clinical.coverage_payor TO shri_integration;
GRANT SELECT ON clinical.dosage TO shri_integration;
GRANT SELECT ON admin.eligibility_check TO shri_integration;
GRANT UPDATE (status, error_code, error_message, updated_by_user_id, updated_at) ON admin.eligibility_check TO shri_integration;
GRANT SELECT ON admin.eligibility_service_type TO shri_integration;
GRANT SELECT ON clinical.encounter TO shri_integration;
GRANT SELECT ON admin.facility TO shri_integration;
GRANT SELECT ON clinical.human_name TO shri_integration;
GRANT SELECT ON clinical.identifier TO shri_integration;
GRANT SELECT ON clinical.medication_request TO shri_integration;
GRANT SELECT ON clinical.organization TO shri_integration;
GRANT SELECT ON clinical.patient TO shri_integration;
GRANT SELECT ON admin.payer TO shri_integration;
GRANT SELECT ON admin.payer_clearinghouse_id TO shri_integration;
GRANT SELECT ON admin.pharmacy TO shri_integration;
GRANT SELECT ON clinical.related_person TO shri_integration;
GRANT SELECT (id, timezone) ON admin.tenant TO shri_integration;
