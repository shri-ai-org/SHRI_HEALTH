-- The clinic-less security-event policy (A47), and the narrow policies the SECURITY DEFINER
-- functions need. Hand-written. Frozen: schema changes are new revisions.

-- ======================================================= A47: clinic-less security events only
-- A failed sign-in, or an invalid or revoked session token, happens before a clinic is known.
-- shri_app may write such a row only as a security event of an approved action. Every other
-- clinic-less insert is refused by the tenant policy. shri_app still cannot read these rows (no
-- SELECT policy matches them), so this insert must not use RETURNING. They are for a later
-- platform-level review role.
CREATE POLICY platform_security_insert ON audit.audit_event FOR INSERT TO shri_app
  WITH CHECK (tenant_id IS NULL AND category = 'security'
              AND action IN ('login', 'access-denied'));

-- =================================================== narrow policies for the definer functions
-- RLS is forced, so it applies to shri_migrator too, which owns the tables and the SECURITY
-- DEFINER functions. Each policy below lets the migrator see exactly the rows one function
-- needs, for one command. The service roles gain nothing from them.

-- The audit chain (public.shri_audit_chain) must see the last clinic-less row to number the
-- next one. Without this every clinic-less row got chain_seq 1, and the second was refused by
-- UNIQUE NULLS NOT DISTINCT (tenant_id, chain_seq).
CREATE POLICY migrator_platform_chain ON audit.audit_event FOR SELECT TO shri_migrator
  USING (tenant_id IS NULL);

-- admin.lookup_session: cookie to session, before the clinic is known. Live sessions only.
CREATE POLICY migrator_session_lookup ON admin.app_session FOR SELECT TO shri_migrator
  USING (revoked_at IS NULL AND expires_at > now());

-- admin.claim_outbound_messages: outbound rows of every clinic, read and set to 'sending'.
CREATE POLICY migrator_outbox_read ON admin.integration_message FOR SELECT TO shri_migrator
  USING (direction = 'outbound');
CREATE POLICY migrator_outbox_claim ON admin.integration_message FOR UPDATE TO shri_migrator
  USING (direction = 'outbound') WITH CHECK (direction = 'outbound');
