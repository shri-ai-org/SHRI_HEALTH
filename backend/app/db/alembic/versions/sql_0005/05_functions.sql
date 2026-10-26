-- The two lookups that must cross clinics (issue #13, Thulasi's items 1 and 4). Hand-written.
-- Frozen. Both are SECURITY DEFINER, owned by shri_migrator (the role that runs migrations),
-- with search_path pinned and every name schema-qualified; EXECUTE is revoked from PUBLIC and
-- granted to one role each. Neither gives any role BYPASSRLS (D23).

-- Cookie to session, before the clinic is known. Returns one row for a live session (not
-- revoked, not past its absolute or idle expiry), else nothing. It returns only the IDs: core
-- then sets the clinic, as tenant_db does, and reads or updates the session under RLS.
CREATE FUNCTION admin.lookup_session(p_token_hash text)
RETURNS TABLE (session_id uuid, tenant_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.id, s.tenant_id, s.user_id
    FROM admin.app_session s
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND s.idle_expires_at > now()
$$;
REVOKE EXECUTE ON FUNCTION admin.lookup_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.lookup_session(text) TO shri_app;

-- The outbox worker claims due outbound messages across clinics and runs each job in its own
-- clinic. A message is due when it is queued, or failed and due for retry. Within one
-- ordering key (per clinic) only the oldest unfinished message can be claimed: while an
-- earlier one is queued, sending or failed, the later one waits, so a CancelRx never overtakes
-- its NewRx. FOR UPDATE SKIP LOCKED lets several workers claim without blocking each other.
-- Claimed rows are set to 'sending'; the worker records the outcome under RLS.
CREATE FUNCTION admin.claim_outbound_messages(p_batch integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 500 THEN
    RAISE EXCEPTION 'batch must be between 1 and 500' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT m.id
      FROM admin.integration_message m
     WHERE m.direction = 'outbound'
       AND m.status IN ('queued', 'failed')
       AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= now())
       AND (m.ordering_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM admin.integration_message e
              WHERE e.tenant_id = m.tenant_id
                AND e.ordering_key = m.ordering_key
                AND e.direction = 'outbound'
                AND e.status IN ('queued', 'sending', 'failed')
                AND (e.created_at, e.id) < (m.created_at, m.id)))
     ORDER BY m.next_attempt_at NULLS FIRST, m.created_at, m.id
     LIMIT p_batch
     FOR UPDATE OF m SKIP LOCKED
  )
  UPDATE admin.integration_message t
     SET status = 'sending', updated_at = now()
    FROM due
   WHERE t.id = due.id
  RETURNING t.id, t.tenant_id;
END $$;
REVOKE EXECUTE ON FUNCTION admin.claim_outbound_messages(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.claim_outbound_messages(integer) TO shri_integration;
