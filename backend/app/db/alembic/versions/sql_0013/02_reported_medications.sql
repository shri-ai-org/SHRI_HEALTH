-- A medication the patient already takes, on the list (D28, D97; demo step 7), for migration
-- 0013. Frozen.
-- The check from the model (sql/01_schema.sql): an order beyond draft is still signed; a
-- reported entry (intent plan with reportedBoolean or reportedReference) needs no signature.
ALTER TABLE clinical.medication_request DROP CONSTRAINT ck_medication_request_active_requires_signature;
ALTER TABLE clinical.medication_request ADD CONSTRAINT ck_medication_request_active_requires_signature CHECK (status IN ('draft', 'cancelled', 'entered-in-error') OR entry_source IN ('imported', 'interface') OR (intent = 'plan' AND (reported_boolean IS TRUE OR reported_practitioner_id IS NOT NULL)) OR (ext_signed_at IS NOT NULL AND ext_signed_by_practitioner_id IS NOT NULL));

-- Hand-written: only a prescription (intent order) is ever sent to a pharmacy. A request the
-- session cannot see counts as not an order.
CREATE FUNCTION public.shri_erx_order_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.medication_request_id IS NOT NULL
     AND (SELECT intent FROM medication_request WHERE id = NEW.medication_request_id)
         IS DISTINCT FROM 'order' THEN
    RAISE EXCEPTION 'medication request % is not a prescription; it is never sent',
      NEW.medication_request_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- As generated (sql/30_guards.sql).
CREATE TRIGGER trg_erx_transaction_order_only BEFORE INSERT OR UPDATE OF medication_request_id ON admin.erx_transaction FOR EACH ROW EXECUTE FUNCTION shri_erx_order_only();
