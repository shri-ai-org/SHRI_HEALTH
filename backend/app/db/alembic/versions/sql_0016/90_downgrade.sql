-- Downgrade of migration 0016.
DROP FUNCTION admin.lookup_staff_user(text);
DROP POLICY migrator_staff_lookup ON admin.app_user;
