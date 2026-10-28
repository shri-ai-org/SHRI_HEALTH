-- Downgrade of migration 0013: the trigger and function as 0002 left them, without the columns.

DROP TRIGGER trg_medication_request_version ON clinical.medication_request;
CREATE TRIGGER trg_medication_request_version BEFORE INSERT OR UPDATE ON clinical.medication_request
  FOR EACH ROW EXECUTE FUNCTION shri_fhir_version();

CREATE OR REPLACE FUNCTION public.shri_fhir_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.meta_version_id := 1;
    NEW.meta_txid := txid_current();
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

ALTER TABLE clinical.medication_request
  DROP COLUMN ext_safety_checked_version,
  DROP COLUMN ext_safety_checked_at;
