-- Changes to three existing tables for Thulasi's core (issue #13). Hand-written; matches the
-- models in app/db/models/admin/platform.py. Frozen: schema changes are new revisions.

-- ============================================================================ audit.audit_event
-- The audit category (SECURITY_MODEL §6), so a security event can be told apart without
-- parsing the action, and the clinic-less insert policy (03_rls_grants.sql) can name it.
-- Existing rows take the category their action implies. ALTER ... TYPE ... USING computes it
-- in a table rewrite, which fires no row trigger and no RLS policy: an UPDATE would be refused,
-- rightly, by the insert-only trigger. The hash payload (shri_audit_payload, v1) is unchanged,
-- so every existing hash still verifies.
ALTER TABLE audit.audit_event ADD COLUMN category VARCHAR(40);
ALTER TABLE audit.audit_event ALTER COLUMN category TYPE VARCHAR(40) USING (
  CASE action
    WHEN 'read' THEN 'phi-read'
    WHEN 'create' THEN 'phi-write'
    WHEN 'update' THEN 'phi-write'
    WHEN 'delete' THEN 'phi-write'
    WHEN 'merge' THEN 'phi-write'
    WHEN 'sign' THEN 'sign'
    WHEN 'export' THEN 'export'
    WHEN 'print' THEN 'export'
    WHEN 'login' THEN 'security'
    WHEN 'logout' THEN 'security'
    WHEN 'access-denied' THEN 'security'
    WHEN 'break-glass' THEN 'security'
    WHEN 'ai-request' THEN 'ai'
    WHEN 'ai-review' THEN 'ai'
    WHEN 'config-change' THEN 'admin'
  END);
ALTER TABLE audit.audit_event ALTER COLUMN category SET NOT NULL;
ALTER TABLE audit.audit_event ADD CONSTRAINT ck_audit_event_category_codes
  CHECK (category IN ('phi-read', 'phi-write', 'sign', 'export', 'security', 'ai', 'admin'));
-- Platform-level review of clinic-less security events, newest first.
CREATE INDEX ix_audit_event_platform_time ON audit.audit_event (recorded_at)
  WHERE tenant_id IS NULL;

-- ====================================================================== audit.break_glass_access
-- D53: a reason code, with free text required only for 'other'. The old check
-- (length(trim(reason)) >= 10) refused a code-only grant. Existing rows become 'other' with
-- their text, which already satisfies the new check. coalesce, because a CHECK that evaluates
-- to NULL passes: without it, 'other' with no text at all would pass too.
ALTER TABLE audit.break_glass_access ADD COLUMN reason_code VARCHAR(40) NOT NULL DEFAULT 'other';
ALTER TABLE audit.break_glass_access ALTER COLUMN reason_code DROP DEFAULT;
ALTER TABLE audit.break_glass_access RENAME COLUMN reason TO reason_text;
ALTER TABLE audit.break_glass_access ALTER COLUMN reason_text DROP NOT NULL;
ALTER TABLE audit.break_glass_access DROP CONSTRAINT ck_break_glass_access_reason_stated;
ALTER TABLE audit.break_glass_access ADD CONSTRAINT ck_break_glass_access_reason_code_codes
  CHECK (reason_code IN ('emergency-care', 'continuity-of-care', 'patient-request', 'other'));
ALTER TABLE audit.break_glass_access ADD CONSTRAINT ck_break_glass_access_other_needs_text
  CHECK (reason_code <> 'other' OR coalesce(length(trim(reason_text)), 0) >= 1);

-- ===================================================================== admin.integration_message
-- The outbox (T29, D25): an ordering key (a CancelRx never overtakes its NewRx) and the
-- outbound job as IDs only. Indexes for the claim and for ordering within a key.
ALTER TABLE admin.integration_message ADD COLUMN ordering_key VARCHAR(100);
ALTER TABLE admin.integration_message ADD COLUMN payload JSONB;
CREATE INDEX ix_integration_message_outbound_due ON admin.integration_message (next_attempt_at)
  WHERE direction = 'outbound' AND status IN ('queued', 'failed');
CREATE INDEX ix_integration_message_ordering
  ON admin.integration_message (tenant_id, ordering_key, created_at);
