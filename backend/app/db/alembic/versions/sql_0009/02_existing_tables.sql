-- Changes to existing tables for migration 0009 (D96, A51). Hand-written, from the models.
-- Frozen: schema changes are new revisions.

-- The practice's public pre-registration link (D96): the code in the form's URL, and whether
-- the link is on. Onboarding sets the code; the practice may turn the link off or replace the
-- code (shri_app, under tenant_self, its own row only).
ALTER TABLE admin.tenant
  ADD COLUMN pre_registration_code VARCHAR(64),
  ADD COLUMN pre_registration_enabled BOOLEAN DEFAULT false NOT NULL,
  ADD CONSTRAINT uq_tenant_pre_registration_code UNIQUE (pre_registration_code),
  ADD CONSTRAINT ck_tenant_pre_registration_code_format CHECK (pre_registration_code IS NULL OR pre_registration_code ~ '^[A-Za-z0-9_-]{16,64}$'),
  ADD CONSTRAINT ck_tenant_pre_registration_needs_code CHECK (NOT pre_registration_enabled OR pre_registration_code IS NOT NULL);
GRANT UPDATE (pre_registration_code, pre_registration_enabled) ON admin.tenant TO shri_app;

-- The audit trail accepts the actor of the public form, who is never a user (Thulasi on #89).
ALTER TABLE audit.audit_event
  DROP CONSTRAINT ck_audit_event_actor_type_codes,
  ADD CONSTRAINT ck_audit_event_actor_type_codes CHECK (actor_type IN ('user', 'system', 'ai', 'integration', 'patient', 'partner', 'anonymous')),
  ADD CONSTRAINT ck_audit_event_anonymous_actor CHECK (actor_type <> 'anonymous' OR actor_user_id IS NULL);

-- The MRN prefix as GET /practice-settings returns it: 2 to 8 capitals or digits (#96).
ALTER TABLE admin.mrn_counter
  DROP CONSTRAINT ck_mrn_counter_prefix_format,
  ADD CONSTRAINT ck_mrn_counter_prefix_format CHECK (prefix ~ '^[A-Z0-9]{2,8}$');
