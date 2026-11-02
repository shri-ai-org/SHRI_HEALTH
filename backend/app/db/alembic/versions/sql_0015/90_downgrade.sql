-- Downgrade of migration 0015: shri_integration has no access to admin.erx_transaction again.
REVOKE ALL ON admin.erx_transaction FROM shri_integration;
