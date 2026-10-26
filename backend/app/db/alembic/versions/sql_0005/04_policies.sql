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

-- admin.purge_expired_runtime_rows: the only way rows leave the four runtime tables (no role has
-- DELETE on them; Thulasi's and Vimal's reviews of #52). The migrator sees and deletes, across
-- clinics, only rows past retention; a live session or a stored response is never in reach.
CREATE POLICY migrator_purge_read ON admin.app_session FOR SELECT TO shri_migrator
  USING (least(coalesce(revoked_at, expires_at), expires_at) < now() - interval '24 hours');
CREATE POLICY migrator_purge ON admin.app_session FOR DELETE TO shri_migrator
  USING (least(coalesce(revoked_at, expires_at), expires_at) < now() - interval '24 hours');
CREATE POLICY migrator_purge_read ON admin.idempotency_record FOR SELECT TO shri_migrator
  USING (expires_at < now());
CREATE POLICY migrator_purge ON admin.idempotency_record FOR DELETE TO shri_migrator
  USING (expires_at < now());
CREATE POLICY migrator_purge_read ON admin.event_log FOR SELECT TO shri_migrator
  USING (created_at < now() - interval '10 minutes');
CREATE POLICY migrator_purge ON admin.event_log FOR DELETE TO shri_migrator
  USING (created_at < now() - interval '10 minutes');
CREATE POLICY migrator_purge_read ON admin.operation FOR SELECT TO shri_migrator
  USING (completed_at < now() - interval '7 days');
CREATE POLICY migrator_purge ON admin.operation FOR DELETE TO shri_migrator
  USING (completed_at < now() - interval '7 days');

-- ====================================================== the partner worker (Vimal's review, B5)
-- It publishes events (result.received and the like), in the clinic of the job it runs.
GRANT INSERT ON admin.event_log TO shri_integration;
-- It completes the operations assigned to it (eligibility, medication history) and nothing else:
-- column grants limit what it may read and set, and the restrictive policy limits which rows.
GRANT SELECT (id, tenant_id, kind, status, assigned_to_integration) ON admin.operation
  TO shri_integration;
GRANT UPDATE (status, result_type, result_id, error, completed_at, updated_at) ON admin.operation
  TO shri_integration;
CREATE POLICY integration_assigned_only ON admin.operation AS RESTRICTIVE FOR ALL
  TO shri_integration USING (assigned_to_integration) WITH CHECK (assigned_to_integration);
