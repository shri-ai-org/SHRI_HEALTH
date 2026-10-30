-- shri_integration files a pharmacy's answer to a NewRx (set_transmission_status, /hooks/erx;
-- Thulasi on #124), for migration 0015. As generated (sql/90_rls_grants.sql,
-- gen_db_rules.INTEGRATION_COLUMN_UPDATE). Frozen.
-- It reads the clinic's eRx messages and updates only the status, the error message, the
-- vendor's message ID and who updated it; it never inserts or deletes one. The table's
-- tenant_isolation policy (no TO clause) keeps it to the clinic it works in.
GRANT SELECT ON admin.erx_transaction TO shri_integration;
GRANT UPDATE (status, error_message, vendor_message_id, updated_by_user_id) ON admin.erx_transaction TO shri_integration;
