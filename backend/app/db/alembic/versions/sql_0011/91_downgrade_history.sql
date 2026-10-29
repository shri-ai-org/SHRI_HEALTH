-- Migration 0011's downgrade: the history snapshot exactly as 0002 defined it. Frozen.

CREATE OR REPLACE FUNCTION public.shri_fhir_history() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = clinical, admin, audit, public, pg_temp AS $$
DECLARE ver int; snap jsonb;
BEGIN
  EXECUTE format('SELECT meta_version_id, shri_snapshot_%s($1) FROM %I WHERE id = $1',
                 TG_TABLE_NAME, TG_TABLE_NAME) INTO ver, snap USING NEW.id;
  IF snap IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO fhir_resource_history (tenant_id, resource_type, resource_id, version_id,
                                     recorded_by_user_id, snapshot)
  VALUES (NEW.tenant_id, TG_ARGV[0], NEW.id, ver,
          NULLIF(current_setting('app.current_user_id', true), '')::uuid, snap)
  ON CONFLICT (resource_type, resource_id, version_id) DO NOTHING;
  RETURN NULL;
END $$;
