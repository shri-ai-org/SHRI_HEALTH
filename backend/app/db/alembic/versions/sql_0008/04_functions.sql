-- Rule functions and the merge-undo function for migration 0008 (A43). Hand-written. Frozen.
-- All run as the caller (SECURITY INVOKER), under RLS, with search_path pinned and every name
-- schema-qualified. Error code P0001 for a rule violation, as in sql_0002/10_rules.sql.

-- Columns that never change once the row exists (the trigger arguments name them).
CREATE FUNCTION public.shri_fixed_columns() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(OLD) -> col) IS DISTINCT FROM (to_jsonb(NEW) -> col) THEN
      RAISE EXCEPTION '% %: % is fixed once created', TG_TABLE_NAME, OLD.id, col
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- ============================================================================ merge undo (D51)
-- A merge records the versions it starts from, before it changes anything: both patients' on
-- patient_merge, each moved record's in patient_merge_record. Its one transaction then moves each
-- of them by exactly one version (the versioning trigger bumps a resource once per transaction).
-- Versions only grow, so a record still at that next version has not changed since the merge.

-- A new merge names both patients' current versions.
CREATE FUNCTION public.shri_patient_merge_versions() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM clinical.patient p
       WHERE (p.id = NEW.surviving_patient_id AND p.meta_version_id = NEW.surviving_patient_version)
          OR (p.id = NEW.merged_patient_id AND p.meta_version_id = NEW.merged_patient_version)) < 2
  THEN
    RAISE EXCEPTION 'patient merge %: record both patients'' current versions, before the merge '
      'changes either', NEW.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- Each moved record is listed at its current version, before the merge moves it.
CREATE FUNCTION public.shri_patient_merge_record_version() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_table text := clinical.shri_resource_table(NEW.resource_type);
  v_version integer;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'patient merge record: % is not a stored FHIR resource', NEW.resource_type
      USING ERRCODE = 'P0001';
  END IF;
  EXECUTE format('SELECT meta_version_id FROM clinical.%I WHERE id = $1', v_table)
    INTO v_version USING NEW.resource_id;
  IF v_version IS DISTINCT FROM NEW.version_before_merge THEN
    RAISE EXCEPTION 'patient merge record: %/% is at version %, not %; list it before the merge '
      'moves it', NEW.resource_type, NEW.resource_id, v_version, NEW.version_before_merge
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- Whether a merge can still be undone: NULL when it can, otherwise the contract's
-- undoBlockedReason. It can while it stands and both patients and every record it moved are
-- still at the version the merge left them at. It runs as the caller, under RLS, so it only sees
-- the caller's clinic.
--
-- Not covered (its cost would be a query per same-patient key, most of them unindexed): a record
-- created or linked after the merge that points at a moved record, such as a new result on a
-- moved visit. The undo itself is then refused with the same 'records-changed', not a key error
-- (admin.finish_patient_merge_undo).
CREATE FUNCTION admin.patient_merge_undo_blocked_reason(p_merge_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m record;
  r record;
  v_table text;
  v_version integer;
BEGIN
  SELECT pm.unmerged_at, pm.surviving_patient_id, pm.surviving_patient_version,
         pm.merged_patient_id, pm.merged_patient_version INTO m
    FROM admin.patient_merge pm WHERE pm.id = p_merge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient merge % not found', p_merge_id USING ERRCODE = 'P0002';
  END IF;
  IF m.unmerged_at IS NOT NULL THEN
    RETURN 'already-undone';
  END IF;
  IF m.surviving_patient_version IS NULL OR m.merged_patient_version IS NULL OR (
       SELECT count(*) FROM clinical.patient p
        WHERE (p.id = m.surviving_patient_id AND p.meta_version_id = m.surviving_patient_version + 1)
           OR (p.id = m.merged_patient_id AND p.meta_version_id = m.merged_patient_version + 1)) < 2
  THEN
    RETURN 'records-changed';
  END IF;
  FOR r IN SELECT mr.resource_type, mr.resource_id, mr.version_before_merge
             FROM admin.patient_merge_record mr WHERE mr.patient_merge_id = p_merge_id LOOP
    v_table := clinical.shri_resource_table(r.resource_type);
    IF v_table IS NULL THEN
      RETURN 'records-changed';
    END IF;
    v_version := NULL;
    EXECUTE format('SELECT meta_version_id FROM clinical.%I WHERE id = $1', v_table)
      INTO v_version USING r.resource_id;
    IF v_version IS DISTINCT FROM r.version_before_merge + 1 THEN
      RETURN 'records-changed';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION admin.patient_merge_undo_blocked_reason(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.patient_merge_undo_blocked_reason(uuid) TO shri_app;

-- A merge changes only by its undo, only while the undo is allowed, and never after it. The undo
-- is three steps in one transaction: set unmerged_at, move the records back, then
-- SELECT admin.finish_patient_merge_undo(id). Setting unmerged_at defers the deferrable keys for
-- the rest of the transaction, so the moves can be checked together at the end.
CREATE FUNCTION public.shri_patient_merge_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  changed text[];
  v_reason text;
BEGIN
  IF OLD.unmerged_at IS NOT NULL THEN
    RAISE EXCEPTION 'patient merge %: it was undone and no longer changes', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  changed := public.shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW),
               ARRAY['unmerged_at', 'unmerged_by_user_id'] || public.shri_meta_columns());
  IF cardinality(changed) > 0 THEN
    RAISE EXCEPTION 'patient merge %: only its undo may change it; cannot change: %', OLD.id,
      array_to_string(changed, ', ') USING ERRCODE = 'P0001';
  END IF;
  IF NEW.unmerged_at IS NOT NULL THEN
    v_reason := admin.patient_merge_undo_blocked_reason(OLD.id);
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'patient merge %: it cannot be undone (%)', OLD.id, v_reason
        USING ERRCODE = 'P0001';
    END IF;
    IF NULLIF(current_setting('shri.patient_merge_undo', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'patient merge %: finish the undo already in progress first', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM set_config('shri.patient_merge_undo', OLD.id::text, true);
    SET CONSTRAINTS ALL DEFERRED;
  END IF;
  RETURN NEW;
END $$;

-- The undo's last step, after the records are back: runs the deferred key checks now and turns a
-- same-patient key violation (a record left pointing at a record that went back to the other
-- patient) into the contract's 'records-changed', so the API never sees a raw key error. (At
-- commit it would be too late: the key checks are already queued by then.)
CREATE FUNCTION admin.finish_patient_merge_undo(p_merge_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_setting('shri.patient_merge_undo', true) IS DISTINCT FROM p_merge_id::text THEN
    RAISE EXCEPTION 'patient merge %: no undo of it in progress', p_merge_id
      USING ERRCODE = 'P0001';
  END IF;
  -- Finished first: running the deferred checks also runs shri_patient_merge_undo_check.
  PERFORM set_config('shri.patient_merge_undo', '', true);
  BEGIN
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'patient merge %: it cannot be undone (records-changed): a record created '
      'or linked since the merge points at a record the merge moved', p_merge_id
      USING ERRCODE = 'P0001';
  END;
END $$;
REVOKE EXECUTE ON FUNCTION admin.finish_patient_merge_undo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.finish_patient_merge_undo(uuid) TO shri_app;

-- At commit: an undo that skipped admin.finish_patient_merge_undo is refused with a clear error,
-- before the deferred key checks could fail with a raw one.
CREATE FUNCTION public.shri_patient_merge_undo_check() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.unmerged_at IS NULL AND NEW.unmerged_at IS NOT NULL
     AND current_setting('shri.patient_merge_undo', true) = NEW.id::text THEN
    RAISE EXCEPTION 'patient merge %: the undo did not finish: end it with '
      'admin.finish_patient_merge_undo()', NEW.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
