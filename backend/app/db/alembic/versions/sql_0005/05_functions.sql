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
-- clinic. A message is due when it is queued, failed and due for retry, or `sending` with an
-- expired lease (its worker died after claiming it, so nothing else would ever pick it up), and
-- it still has attempts left. Within one ordering key (per clinic) only the oldest unfinished
-- message can be claimed: while an earlier one is queued, sending, failed or dead-lettered, the
-- later one waits, so a CancelRx never overtakes its NewRx, and a dead letter holds the key until
-- someone resolves it (Thulasi's review of #52). FOR UPDATE SKIP LOCKED lets several workers
-- claim without blocking each other. The claim counts the attempt itself (attempts + 1, with
-- `claimed_at`), so a worker that crashes mid-send still uses one up; the worker records only
-- the outcome, under RLS. Before claiming, every outbound row that is out of attempts (failed,
-- or sending with an expired lease) becomes a dead letter: it then holds its ordering key
-- visibly, and its inbox item reaches a person, instead of being retried forever. The lease is
-- 15 minutes.
CREATE FUNCTION admin.claim_outbound_messages(p_batch integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 500 THEN
    RAISE EXCEPTION 'batch must be between 1 and 500' USING ERRCODE = '22023';
  END IF;
  UPDATE admin.integration_message x
     SET status = 'dead-letter', updated_at = now(),
         last_error = coalesce(x.last_error, 'no outcome reported after the last attempt')
   WHERE x.direction = 'outbound'
     AND x.attempts >= x.max_attempts
     AND (x.status = 'failed'
          OR (x.status = 'sending' AND x.claimed_at < now() - interval '15 minutes'));
  RETURN QUERY
  WITH due AS (
    SELECT m.id
      FROM admin.integration_message m
     WHERE m.direction = 'outbound'
       AND m.attempts < m.max_attempts
       AND (m.status = 'queued'
            OR (m.status = 'failed' AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= now()))
            OR (m.status = 'sending' AND m.claimed_at < now() - interval '15 minutes'))
       AND (m.ordering_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM admin.integration_message e
              WHERE e.tenant_id = m.tenant_id
                AND e.ordering_key = m.ordering_key
                AND e.direction = 'outbound'
                AND e.status IN ('queued', 'sending', 'failed', 'dead-letter')
                AND (e.created_at, e.id) < (m.created_at, m.id)))
     ORDER BY m.next_attempt_at NULLS FIRST, m.created_at, m.id
     LIMIT p_batch
     FOR UPDATE OF m SKIP LOCKED
  )
  UPDATE admin.integration_message t
     SET status = 'sending', claimed_at = now(), attempts = t.attempts + 1, updated_at = now()
    FROM due
   WHERE t.id = due.id
  RETURNING t.id, t.tenant_id;
END $$;
REVOKE EXECUTE ON FUNCTION admin.claim_outbound_messages(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.claim_outbound_messages(integer) TO shri_integration;

-- The retention clean-up (Thulasi's and Vimal's reviews of #52): the only way rows leave the four
-- runtime tables. It deletes, across clinics, only rows past retention (the shri_migrator
-- policies in 04_policies.sql decide which): sessions 24 hours after they end (the earliest of
-- logout, idle timeout and absolute expiry), idempotency records at expires_at, events after
-- 10 minutes, finished operations after 7 days. It returns only counts. The scheduled clean-up
-- job calls it as shri_maintenance, a role with no table privileges and nothing else to run
-- (D23 as amended in #64), so the API role never gains a cross-clinic capability. An operation
-- still queued or running past its kind's time limit is marked failed by core
-- (operation-timed-out), after which the 7-day purge applies (Thulasi, #52).
CREATE FUNCTION admin.purge_expired_runtime_rows()
RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM admin.app_session
   WHERE least(revoked_at, idle_expires_at, expires_at) < now() - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'app_session'; deleted := n; RETURN NEXT;
  DELETE FROM admin.idempotency_record WHERE expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'idempotency_record'; deleted := n; RETURN NEXT;
  DELETE FROM admin.event_log WHERE created_at < now() - interval '10 minutes';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'event_log'; deleted := n; RETURN NEXT;
  DELETE FROM admin.operation WHERE completed_at < now() - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'operation'; deleted := n; RETURN NEXT;
END $$;
REVOKE EXECUTE ON FUNCTION admin.purge_expired_runtime_rows() FROM PUBLIC;
-- USAGE on the schema only to call the function: no table in it is visible to the role.
GRANT USAGE ON SCHEMA admin TO shri_maintenance;
GRANT EXECUTE ON FUNCTION admin.purge_expired_runtime_rows() TO shri_maintenance;

-- ======================================================================= the audit hash, v2
-- Payload 2 adds the category (Thulasi's review of #52); payload 1 is exactly 0002's, so every
-- existing hash still verifies. shri_audit_verify (0002) hashes each row with this function, so
-- it checks each row by its own version.
CREATE OR REPLACE FUNCTION public.shri_audit_payload(e audit.audit_event) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE e.hash_version
    WHEN 1 THEN jsonb_build_array('v1', e.chain_seq, e.prev_hash, e.event_uuid, e.tenant_id,
           to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           e.actor_type, e.actor_user_id, e.actor_display, e.action, e.outcome, e.entity_type,
           e.entity_id, e.entity_version_id, e.patient_id, e.purpose_of_use, e.reason,
           host(e.source_ip), e.user_agent, e.correlation_id)::text
    ELSE jsonb_build_array('v2', e.chain_seq, e.prev_hash, e.event_uuid, e.tenant_id,
           to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           e.actor_type, e.actor_user_id, e.actor_display, e.action, e.category, e.outcome,
           e.entity_type, e.entity_id, e.entity_version_id, e.patient_id, e.purpose_of_use,
           e.reason, host(e.source_ip), e.user_agent, e.correlation_id)::text
  END
$$;

-- As 0002's, except that every new row is hashed as payload 2, whatever the insert said: a
-- writer cannot choose payload 1 to leave the category out of its hash.
CREATE OR REPLACE FUNCTION public.shri_audit_chain() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = clinical, admin, audit, public, pg_temp AS $$
DECLARE last_seq bigint; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || coalesce(NEW.tenant_id::text, 'platform')));
  SELECT chain_seq, hash INTO last_seq, last_hash FROM audit_event
   WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id AND chain_seq IS NOT NULL
   ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash_version := 2;
  NEW.hash := encode(digest(shri_audit_payload(NEW), 'sha256'), 'hex');
  RETURN NEW;
END $$;
