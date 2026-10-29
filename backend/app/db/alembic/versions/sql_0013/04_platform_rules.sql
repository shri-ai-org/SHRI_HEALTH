-- The platform's two fixed prescription rules (D97, D99), for migration 0013. Frozen.
-- tenant_id NULL: every clinic reads them (tenant_read), and no role may write one
-- (tenant_write needs the session's clinic). shri_migrator owns the table but is subject to
-- its forced RLS, so the rows go in with RLS not forced for this statement only. ALTER TABLE
-- holds an ACCESS EXCLUSIVE lock until the migration commits, so no other session ever sees
-- the table unforced; the row-level security test checks it is forced again afterwards.
ALTER TABLE admin.cds_rule NO FORCE ROW LEVEL SECURITY;

-- As generated (sql/95_seed.sql, gen_db_rules.platform_cds_rules_sql).
INSERT INTO admin.cds_rule (id, tenant_id, code, name, alert_type, rule_source, default_severity, requires_override_reason, is_suppressible, is_active) VALUES
  (gen_random_uuid(), NULL, 'allergy', 'Allergy to an ingredient of the drug', 'allergy', 'deterministic', 'high', true, false, true),
  (gen_random_uuid(), NULL, 'duplicate-medication', 'Active medication with the same ingredient', 'duplicate-medication', 'deterministic', 'moderate', false, false, true)
ON CONFLICT DO NOTHING;

ALTER TABLE admin.cds_rule FORCE ROW LEVEL SECURITY;
