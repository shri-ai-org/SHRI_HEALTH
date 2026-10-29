-- Migration 0017 down: the platform staff roles go. A user_role pointing at one blocks this
-- (its foreign key), as it should: remove the user's roles first.
ALTER TABLE admin.role NO FORCE ROW LEVEL SECURITY;
DELETE FROM admin.role WHERE tenant_id IS NULL AND is_system
  AND code IN ('ADM', 'APP', 'BIL', 'CO', 'DSP', 'FD', 'MA', 'MD', 'RN', 'SUP');
ALTER TABLE admin.role FORCE ROW LEVEL SECURITY;
