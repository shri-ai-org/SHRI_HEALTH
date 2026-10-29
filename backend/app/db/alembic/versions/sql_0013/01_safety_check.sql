-- The latest safety check on a prescription (D97, A58), for migration 0013. Frozen.
-- 01: the columns (as sql/01_schema.sql compiles them from the models).
-- 02: shri_fhir_version() takes, as trigger arguments, columns whose change alone is not a new
--     version: no meta_version_id bump, no new meta_last_updated, no history row. With no
--     arguments (every other table) it behaves exactly as 0002 wrote it.
-- 03: the medication_request trigger names the two columns (sql/20_fhir_versioning.sql).

ALTER TABLE clinical.medication_request
  ADD COLUMN ext_safety_checked_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN ext_safety_checked_version INTEGER;

CREATE OR REPLACE FUNCTION public.shri_fhir_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.meta_version_id := 1;
    NEW.meta_txid := txid_current();
  ELSIF TG_NARGS > 0 AND (to_jsonb(OLD) - TG_ARGV) = (to_jsonb(NEW) - TG_ARGV) THEN
    RETURN NEW;                -- only the trigger's unversioned columns changed
  ELSIF OLD.meta_txid IS DISTINCT FROM txid_current() THEN
    NEW.meta_version_id := OLD.meta_version_id + 1;
    NEW.meta_txid := txid_current();
  ELSE
    NEW.meta_version_id := OLD.meta_version_id;
    NEW.meta_txid := OLD.meta_txid;
  END IF;
  NEW.meta_last_updated := now();
  RETURN NEW;
END $$;

DROP TRIGGER trg_medication_request_version ON clinical.medication_request;
CREATE TRIGGER trg_medication_request_version BEFORE INSERT OR UPDATE ON clinical.medication_request
  FOR EACH ROW EXECUTE FUNCTION shri_fhir_version('ext_safety_checked_at', 'ext_safety_checked_version');
