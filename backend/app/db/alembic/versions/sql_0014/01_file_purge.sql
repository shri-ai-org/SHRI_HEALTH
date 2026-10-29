-- The file service's purge (migration 0014). The index as generated from the models; the
-- policies and functions hand-written. Frozen: schema changes are new revisions.

CREATE INDEX ix_binary_object_unusable ON admin.binary_object (updated_at, id) WHERE state <> 'clean';

-- ===================================================== narrow policies for the definer functions
-- RLS is forced, so it applies to shri_migrator too, which owns the table and the functions.
-- These let it see and delete, across clinics, only files that are not clean 24 hours after
-- their last change; a clean file is never in reach. The service roles gain nothing from them.
CREATE POLICY migrator_purge_read ON admin.binary_object FOR SELECT TO shri_migrator
  USING (state IN ('pending-upload', 'quarantined', 'rejected')
         AND updated_at < now() - interval '24 hours');
CREATE POLICY migrator_purge ON admin.binary_object FOR DELETE TO shri_migrator
  USING (state IN ('pending-upload', 'quarantined', 'rejected')
         AND updated_at < now() - interval '24 hours');

-- ============================================================================ the functions
-- The unusable files past the window, oldest change first, at most p_limit (1 to 1000): what
-- the job needs to delete each stored object (the bucket and key are server-generated, never
-- client input) and nothing else. Read-only.
CREATE FUNCTION admin.list_unusable_files(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, bucket text, storage_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT b.id, b.tenant_id, b.bucket::text, b.storage_key::text
    FROM admin.binary_object b
   WHERE b.state IN ('pending-upload', 'quarantined', 'rejected')
     AND b.updated_at < now() - interval '24 hours'
   ORDER BY b.updated_at, b.id
   LIMIT p_limit;
END $$;
REVOKE EXECUTE ON FUNCTION admin.list_unusable_files(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.list_unusable_files(integer) TO shri_maintenance;

-- Deletes the given files that are still unusable and past the window (the same test again, so
-- a file that became clean or changed since it was listed stays), at most 1000 per call. Each
-- row is deleted on its own: one still referenced by another table (foreign_key_violation,
-- 23503; no reference to binary_object cascades) is skipped and kept, and the others still go.
-- Returns the IDs it deleted, so the caller removes only their stored objects.
CREATE FUNCTION admin.delete_unusable_files(p_ids uuid[])
RETURNS TABLE (id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE f uuid;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) > 1000 THEN
    RAISE EXCEPTION 'between 0 and 1000 file IDs' USING ERRCODE = '22023';
  END IF;
  FOR f IN SELECT DISTINCT u.x FROM unnest(p_ids) AS u(x) WHERE u.x IS NOT NULL ORDER BY u.x LOOP
    BEGIN
      DELETE FROM admin.binary_object b
       WHERE b.id = f
         AND b.state IN ('pending-upload', 'quarantined', 'rejected')
         AND b.updated_at < now() - interval '24 hours';
      IF FOUND THEN
        id := f;
        RETURN NEXT;
      END IF;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;  -- still referenced: kept, with its stored object
    END;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION admin.delete_unusable_files(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.delete_unusable_files(uuid[]) TO shri_maintenance;
