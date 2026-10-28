-- Migration 0011's downgrade: the retention purge exactly as 0009 defined it. Frozen.
-- CREATE OR REPLACE keeps its grants (EXECUTE for shri_maintenance only).

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
