-- Rule functions and the MRN function for migration 0007 (A45). Hand-written. Frozen. All run
-- as the caller (SECURITY INVOKER), under RLS, with search_path pinned and every name
-- schema-qualified. Error code P0001 for a rule violation, as in sql_0002/10_rules.sql.

-- A self-pay visit never produces an insurance claim (CheckInRequest.selfPay). The void of a
-- claim sent before the visit became self-pay (frequency 8) is still allowed: it cancels that
-- claim at the payer.
CREATE FUNCTION public.shri_claim_not_self_pay() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.frequency_code <> '8' AND EXISTS (
       SELECT 1 FROM admin.superbill s JOIN clinical.encounter e ON e.id = s.encounter_id
        WHERE s.id = NEW.superbill_id AND e.ext_self_pay) THEN
    RAISE EXCEPTION 'claim %: the visit is self-pay, so it has no insurance claim', NEW.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- An MRN is never reused (D41): the number only grows, and the prefix and system are fixed once
-- the first MRN has been issued.
CREATE FUNCTION public.shri_mrn_counter_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'mrn_counter: the number never goes back (% to %)', OLD.next_value,
      NEW.next_value USING ERRCODE = 'P0001';
  END IF;
  IF OLD.next_value > 1
     AND (NEW.prefix, NEW.system) IS DISTINCT FROM (OLD.prefix, OLD.system) THEN
    RAISE EXCEPTION 'mrn_counter: the prefix and system are fixed once an MRN has been issued'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- The next MRN of the caller's practice (D41): the practice's MRN system, and the prefix plus
-- the number, six digits zero-padded (TEST-000123), longer past 999999. It runs as the caller,
-- under RLS, so it only ever sees the caller's counter. The UPDATE locks the counter until the
-- registration commits: concurrent registrations wait, and none gets the same number; one that
-- rolls back gives its number back.
CREATE FUNCTION admin.next_mrn() RETURNS TABLE (system text, value text)
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
  v_prefix text;
  v_system text;
  v_number bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no clinic set for this request' USING ERRCODE = '42501';
  END IF;
  UPDATE admin.mrn_counter c SET next_value = c.next_value + 1
   WHERE c.tenant_id = v_tenant
  RETURNING c.prefix, c.system, c.next_value - 1 INTO v_prefix, v_system, v_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this practice has no MRN counter' USING ERRCODE = 'P0001';
  END IF;
  system := v_system;
  value := v_prefix || '-' || CASE WHEN v_number < 1000000 THEN lpad(v_number::text, 6, '0')
                                   ELSE v_number::text END;
  RETURN NEXT;
END $$;
REVOKE EXECUTE ON FUNCTION admin.next_mrn() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.next_mrn() TO shri_app;
