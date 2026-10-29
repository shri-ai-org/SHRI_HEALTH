-- Co-signature status and "return to author" (D73; encounters.yaml Note.cosignStatus,
-- cosigner, cosignReturn), for migration 0013. Frozen.
-- The columns and checks as sql/01_schema.sql compiles them from the models.
ALTER TABLE clinical.composition
  ADD COLUMN ext_cosign_status VARCHAR(40) DEFAULT 'not-required' NOT NULL,
  ADD COLUMN ext_cosigner_practitioner_id UUID,
  ADD COLUMN ext_cosign_return_comment VARCHAR(2000),
  ADD COLUMN ext_cosign_returned_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE clinical.composition
  ADD CONSTRAINT ck_composition_draft_not_cosigned CHECK (status <> 'preliminary' OR ext_cosign_status = 'not-required'),
  ADD CONSTRAINT ck_composition_cosign_has_cosigner CHECK (ext_cosign_status = 'not-required' OR ext_cosigner_practitioner_id IS NOT NULL),
  ADD CONSTRAINT ck_composition_return_comment_while_returned CHECK (CASE WHEN ext_cosign_status = 'returned' THEN coalesce(length(trim(ext_cosign_return_comment)), 0) > 0 AND ext_cosign_returned_at IS NOT NULL ELSE ext_cosign_return_comment IS NULL AND ext_cosign_returned_at IS NULL END),
  ADD CONSTRAINT ck_composition_ext_cosign_status_codes CHECK (ext_cosign_status IN ('not-required', 'pending', 'returned', 'cosigned')),
  ADD CONSTRAINT fk_composition_ext_cosigner_practitioner_id_practitioner FOREIGN KEY(ext_cosigner_practitioner_id) REFERENCES clinical.practitioner (id);
ALTER TABLE clinical.composition ADD CONSTRAINT fk_composition_ext_cosigner_practitioner_id_tenant FOREIGN KEY(tenant_id, ext_cosigner_practitioner_id) REFERENCES clinical.practitioner (tenant_id, id);

-- Hand-written: 0002's guard, where a signed note may now also move its co-signature. The
-- co-signer, once named, never changes, and a co-signed note's co-signature is final. A note
-- entered in error still changes in nothing.
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
                              ARRAY['status', 'verified_by_user_id', 'verified_at',
                                    'ext_cosign_status', 'ext_cosigner_practitioner_id',
                                    'ext_cosign_return_comment', 'ext_cosign_returned_at']
                              || shri_meta_columns());
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'signed note %: cannot change % (write an addendum or a replacing note)',
      OLD.id, array_to_string(bad, ', ') USING ERRCODE = 'P0001';
  END IF;
  IF (OLD.ext_cosigner_practitioner_id IS NOT NULL
      AND NEW.ext_cosigner_practitioner_id IS DISTINCT FROM OLD.ext_cosigner_practitioner_id)
     OR (OLD.ext_cosign_status = 'cosigned'
         AND NEW.ext_cosign_status IS DISTINCT FROM 'cosigned') THEN
    RAISE EXCEPTION 'signed note %: its co-signer and a completed co-signature never change',
      OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
