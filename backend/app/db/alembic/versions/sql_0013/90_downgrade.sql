-- Downgrade of migration 0013. A reported medication on the list, or a co-signature status,
-- cannot be kept by 0012's schema: the downgrade stops at the check rather than lose one.
-- The platform rules go only while no alert names them (detected_issue keeps its rule).

-- One active coverage per order again, as 0001 indexed it.
ALTER TABLE clinical.coverage DROP CONSTRAINT ex_coverage_order_no_overlap;
CREATE UNIQUE INDEX uq_coverage_active_order ON clinical.coverage (beneficiary_patient_id, "order") WHERE status = 'active';

-- The portal reads the whole note again, as 0011 granted it.
REVOKE SELECT ON clinical.composition FROM shri_portal;
GRANT SELECT ON clinical.composition TO shri_portal;

ALTER TABLE admin.cds_rule NO FORCE ROW LEVEL SECURITY;
DELETE FROM admin.cds_rule WHERE tenant_id IS NULL AND code IN ('allergy', 'duplicate-medication');
ALTER TABLE admin.cds_rule FORCE ROW LEVEL SECURITY;

-- 0002's guard; then the co-signature columns go (with their checks and keys).
CREATE OR REPLACE FUNCTION public.shri_composition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad text[];
BEGIN
  IF OLD.status = 'preliminary' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'entered-in-error' OR NEW.status = 'preliminary' THEN
    bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW), shri_meta_columns());
    IF cardinality(bad) > 0 THEN
      RAISE EXCEPTION 'note % is % and cannot change (corrections are addenda)', OLD.id,
        OLD.status USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW),
                              ARRAY['status', 'verified_by_user_id', 'verified_at']
                              || shri_meta_columns());
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'signed note %: cannot change % (write an addendum or a replacing note)',
      OLD.id, array_to_string(bad, ', ') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE clinical.composition
  DROP COLUMN ext_cosign_returned_at,
  DROP COLUMN ext_cosign_return_comment,
  DROP COLUMN ext_cosigner_practitioner_id,
  DROP COLUMN ext_cosign_status;

DROP TRIGGER trg_erx_transaction_order_only ON admin.erx_transaction;
DROP FUNCTION public.shri_erx_order_only();
ALTER TABLE clinical.medication_request DROP CONSTRAINT ck_medication_request_active_requires_signature;
ALTER TABLE clinical.medication_request ADD CONSTRAINT ck_medication_request_active_requires_signature CHECK (status IN ('draft', 'cancelled', 'entered-in-error') OR entry_source IN ('imported', 'interface') OR (ext_signed_at IS NOT NULL AND ext_signed_by_practitioner_id IS NOT NULL));

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
