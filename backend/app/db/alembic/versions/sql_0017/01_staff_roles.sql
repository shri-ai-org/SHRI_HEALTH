-- Staff roles for sign-in, for migration 0017. Frozen.
-- Core's staff sign-in (#126) reads a user's roles from admin.user_role joined to admin.role, so
-- each role code in core's ROLE_PERMISSIONS (app/core/permissions.py) needs a row. They are
-- platform roles (tenant_id NULL): every clinic reads them (tenant_read) and no role may write
-- one (tenant_write needs the session's clinic). shri_migrator owns the table but is subject to
-- its forced RLS, so the rows go in with RLS not forced for this statement only. ALTER TABLE
-- holds an ACCESS EXCLUSIVE lock until the migration commits, so no other session ever sees the
-- table unforced; the roles test checks it is forced again afterwards.
ALTER TABLE admin.role NO FORCE ROW LEVEL SECURITY;

-- As generated (sql/95_seed.sql, gen_db_rules.platform_roles_sql).
INSERT INTO admin.role (id, tenant_id, code, name, description, is_system) VALUES
  (gen_random_uuid(), NULL, 'ADM', 'ADM', 'Staff role from core (app/core/permissions.py ROLE_PERMISSIONS)', true),
  (gen_random_uuid(), NULL, 'APP', 'APP', 'Staff role from core (app/core/permissions.py ROLE_PERMISSIONS)', true),
  (gen_random_uuid(), NULL, 'BIL', 'BIL', 'Staff role from core (app/core/permissions.py ROLE_PERMISSIONS)', true),
  (gen_random_uuid(), NULL, 'CO', 'CO', 'Staff role from core (app/core/permissions.py ROLE_PERMISSIONS)', true),
  (gen_random_uuid(), NULL, 'DSP', 'DSP', 'Staff role from core (app/core/permissions.py ROLE_PERMISSIONS)', true),
  (gen_random_uuid(), NULL, 'FD', 'FD', 'Staff role from core (app/core/permissions.py ROLE_PERMISSIONS)', true),
  (gen_random_uuid(), NULL, 'MA', 'MA', 'Staff role from core (app/core/permissions.py ROLE_PERMISSIONS)', true),
  (gen_random_uuid(), NULL, 'MD', 'MD', 'Staff role from core (app/core/permissions.py ROLE_PERMISSIONS)', true),
  (gen_random_uuid(), NULL, 'RN', 'RN', 'Staff role from core (app/core/permissions.py ROLE_PERMISSIONS)', true),
  (gen_random_uuid(), NULL, 'SUP', 'SUP', 'Staff role from core (app/core/permissions.py ROLE_PERMISSIONS)', true)
ON CONFLICT DO NOTHING;

ALTER TABLE admin.role FORCE ROW LEVEL SECURITY;
