-- Migration 0010's downgrade: the encounter's history snapshot as 0002 defined it. Frozen.

CREATE OR REPLACE FUNCTION clinical.shri_snapshot_encounter(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(r) || jsonb_build_object('_children', jsonb_build_object(
      'encounter_diagnosis', coalesce((SELECT jsonb_agg(to_jsonb(c1) ORDER BY c1.created_at, c1.id) FROM clinical.encounter_diagnosis c1 WHERE c1.encounter_id = r.id), '[]'::jsonb),
      'encounter_location', coalesce((SELECT jsonb_agg(to_jsonb(c1) ORDER BY c1.created_at, c1.id) FROM clinical.encounter_location c1 WHERE c1.encounter_id = r.id), '[]'::jsonb),
      'encounter_participant', coalesce((SELECT jsonb_agg(to_jsonb(c1) ORDER BY c1.created_at, c1.id) FROM clinical.encounter_participant c1 WHERE c1.encounter_id = r.id), '[]'::jsonb),
      'encounter_reason', coalesce((SELECT jsonb_agg(to_jsonb(c1) ORDER BY c1.created_at, c1.id) FROM clinical.encounter_reason c1 WHERE c1.encounter_id = r.id), '[]'::jsonb),
      'encounter_status_history', coalesce((SELECT jsonb_agg(to_jsonb(c1) ORDER BY c1.created_at, c1.id) FROM clinical.encounter_status_history c1 WHERE c1.encounter_id = r.id), '[]'::jsonb),
      'encounter_type', coalesce((SELECT jsonb_agg(to_jsonb(c1) ORDER BY c1.created_at, c1.id) FROM clinical.encounter_type c1 WHERE c1.encounter_id = r.id), '[]'::jsonb),
      'identifier', coalesce((SELECT jsonb_agg(to_jsonb(c1) ORDER BY c1.created_at, c1.id) FROM clinical.identifier c1 WHERE c1.encounter_id = r.id), '[]'::jsonb)))
  FROM clinical.encounter r WHERE r.id = p_id
$$;
