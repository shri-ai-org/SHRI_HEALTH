-- Merge by link (D103), for migration 0012. Hand-written. Frozen.
-- A merge records Patient.link rows and moves no record, so nothing needs listing for the
-- undo, and the undo moves nothing back. The undo is refused only when the merge is already
-- undone or a later merge involving either patient still stands. Runs as the caller (SECURITY
-- INVOKER), under RLS, with search_path pinned and every name schema-qualified; P0001 for a
-- rule violation, as in sql_0002/10_rules.sql.

-- The version-based rule of 0008 goes: its triggers, functions, columns and record table.
DROP TRIGGER trg_patient_merge_undo ON admin.patient_merge;
DROP TRIGGER trg_patient_merge_versions ON admin.patient_merge;
DROP FUNCTION public.shri_patient_merge_undo_check();
DROP FUNCTION public.shri_patient_merge_versions();
DROP FUNCTION admin.finish_patient_merge_undo(uuid);
DROP TABLE admin.patient_merge_record;   -- its triggers, policy and grants go with it
DROP FUNCTION public.shri_patient_merge_record_version();
ALTER TABLE admin.patient_merge DROP COLUMN surviving_patient_version;
ALTER TABLE admin.patient_merge DROP COLUMN merged_patient_version;

-- Whether a merge can still be undone: NULL when it can, otherwise the contract's
-- undoBlockedReason: 'already-undone', or 'later-merge' when a merge recorded after it that
-- involves either of its patients still stands. Only the caller's clinic is seen (RLS).
CREATE OR REPLACE FUNCTION admin.patient_merge_undo_blocked_reason(p_merge_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m record;
BEGIN
  SELECT pm.unmerged_at, pm.surviving_patient_id, pm.merged_patient_id, pm.performed_at,
         pm.created_at INTO m
    FROM admin.patient_merge pm WHERE pm.id = p_merge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient merge % not found', p_merge_id USING ERRCODE = 'P0002';
  END IF;
  IF m.unmerged_at IS NOT NULL THEN
    RETURN 'already-undone';
  END IF;
  IF EXISTS (
       SELECT 1 FROM admin.patient_merge later
        WHERE later.id <> p_merge_id AND later.unmerged_at IS NULL
          AND (later.performed_at, later.created_at) > (m.performed_at, m.created_at)
          AND (later.surviving_patient_id IN (m.surviving_patient_id, m.merged_patient_id)
               OR later.merged_patient_id IN (m.surviving_patient_id, m.merged_patient_id))) THEN
    RETURN 'later-merge';
  END IF;
  RETURN NULL;
END $$;

-- A merge changes only by its undo, only while the undo is allowed, and never after it.
CREATE OR REPLACE FUNCTION public.shri_patient_merge_guard() RETURNS trigger LANGUAGE plpgsql
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
  END IF;
  RETURN NEW;
END $$;
