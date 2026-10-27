-- The public pre-registration form's write path and its retention (D96, A51; Thulasi on #13).
-- Hand-written. Frozen. Every name is schema-qualified and search_path is pinned.

-- ================================================================= a decided request is final
-- Accept or reject is the request's last change: it stays as it was decided until the purge
-- (a rejected one) or for good (an accepted one, the record of the identity check).
CREATE FUNCTION public.shri_pre_registration_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'pre-registration %: it was % and no longer changes', OLD.id, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- ==================================================================== the public form's insert
-- The only write anyone can make without signing in (D96). Thulasi's shape (#13): SECURITY
-- DEFINER, owned by shri_migrator, EXECUTE for shri_public only, a role with no table
-- privileges, so a bug on the public path reaches nothing else.
--
-- The clinic comes only from the practice's code, never from the body: an unknown code, a link
-- that is turned off and an inactive practice are all P0002 (the contract's 404), which says
-- nothing about any person. No patient, email or phone is looked up. The function sets the
-- clinic only for its own work and puts the caller's setting back before it returns (an error
-- rolls it back with everything else). It stores the request and its `anonymous` audit row in
-- one call, so neither exists without the other. It returns nothing: no ID or row reaches the
-- caller.
--
-- The Idempotency-Key is unique per clinic on the request itself, with the body's hash (core's
-- idempotency_record needs a user). The same key with the same body changes nothing and
-- answers as before; with another body it is refused as idempotency_key_reused (P0001). A
-- concurrent duplicate waits on the unique index, then counts as a replay.
CREATE POLICY migrator_pre_registration_link ON admin.tenant FOR SELECT TO shri_migrator
  USING (is_active AND pre_registration_enabled);

CREATE FUNCTION admin.submit_pre_registration(
    p_practice_code text, p_idempotency_key uuid, p_request_hash text, p_details jsonb,
    p_contact_consent boolean, p_source_ip inet, p_user_agent text, p_correlation_id text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_caller_tenant text := current_setting('app.current_tenant_id', true);
  v_tenant uuid;
  v_id uuid := gen_random_uuid();
  v_hash text;
BEGIN
  SELECT t.id INTO v_tenant FROM admin.tenant t
   WHERE t.pre_registration_code = p_practice_code
     AND t.pre_registration_enabled AND t.is_active;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'pre-registration: no practice takes requests with this code'
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('app.current_tenant_id', v_tenant::text, true);

  INSERT INTO admin.pre_registration
         (id, tenant_id, idempotency_key, request_hash, details, contact_consent)
  VALUES (v_id, v_tenant, p_idempotency_key, p_request_hash, p_details, p_contact_consent)
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT r.request_hash INTO v_hash FROM admin.pre_registration r
     WHERE r.tenant_id = v_tenant AND r.idempotency_key = p_idempotency_key;
    IF v_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'pre-registration: the Idempotency-Key was used with a different body'
        USING ERRCODE = 'P0001', CONSTRAINT = 'idempotency_key_reused';
    END IF;
    PERFORM set_config('app.current_tenant_id', coalesce(v_caller_tenant, ''), true);
    RETURN;
  END IF;

  INSERT INTO audit.audit_event (tenant_id, actor_type, action, category, outcome, entity_type,
                                 entity_id, source_ip, user_agent, correlation_id)
  VALUES (v_tenant, 'anonymous', 'create', 'phi-write', 'success', 'PreRegistration',
          v_id::text, p_source_ip, left(p_user_agent, 300), left(p_correlation_id, 64));
  PERFORM set_config('app.current_tenant_id', coalesce(v_caller_tenant, ''), true);
END $$;
REVOKE EXECUTE ON FUNCTION admin.submit_pre_registration(text, uuid, text, jsonb, boolean, inet,
                                                         text, text) FROM PUBLIC;
-- USAGE on the schema only to call the function: no table in it is visible to the role.
GRANT USAGE ON SCHEMA admin TO shri_public;
GRANT EXECUTE ON FUNCTION admin.submit_pre_registration(text, uuid, text, jsonb, boolean, inet,
                                                        text, text) TO shri_public;

-- ====================================================================== the 30-day retention
-- A request that was rejected, or never reviewed, is deleted 30 days after the rejection or its
-- arrival (D96); an accepted one stays, with its identity check. As for the runtime tables
-- (0005), the migrator sees and deletes only those rows, and only inside the purge.
CREATE POLICY migrator_purge_read ON admin.pre_registration FOR SELECT TO shri_migrator
  USING ((status = 'pending' AND created_at < now() - interval '30 days')
         OR (status = 'rejected' AND decided_at < now() - interval '30 days'));
CREATE POLICY migrator_purge ON admin.pre_registration FOR DELETE TO shri_migrator
  USING ((status = 'pending' AND created_at < now() - interval '30 days')
         OR (status = 'rejected' AND decided_at < now() - interval '30 days'));

-- 0005's purge with pre-registrations added. CREATE OR REPLACE keeps its grants: EXECUTE for
-- shri_maintenance only (Thulasi on #13: the 30-day deletion goes into this purge).
CREATE OR REPLACE FUNCTION admin.purge_expired_runtime_rows()
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
  DELETE FROM admin.pre_registration
   WHERE (status = 'pending' AND created_at < now() - interval '30 days')
      OR (status = 'rejected' AND decided_at < now() - interval '30 days');
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'pre_registration'; deleted := n; RETURN NEXT;
END $$;
