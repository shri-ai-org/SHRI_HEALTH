-- The follow-up request's rule (D98, A52). Hand-written. Frozen. Runs as the caller, under RLS,
-- with search_path pinned. Error code P0001 for a rule violation, as in sql_0002/10_rules.sql.

-- What the clinician asked for changes only while the request is open (a PUT replaces it). The
-- status moves only along D98's paths:
--   open -> booked (the front desk books the revisit), declined (the patient won't book it),
--           withdrawn (the clinician who asked takes it back);
--   booked -> open (the revisit was cancelled, so the link is cleared),
--             booked (the revisit was rescheduled, so the link moves).
-- A declined or withdrawn request is final. The check that only the requesting clinician
-- withdraws, and the permissions, are the encounters service's.
CREATE FUNCTION public.shri_follow_up_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status IN ('declined', 'withdrawn') THEN
    RAISE EXCEPTION 'follow-up request %: it was % and no longer changes', OLD.id, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'open' AND (NEW.interval_value, NEW.interval_unit, NEW.appointment_type_id,
                               NEW.practitioner_id, NEW.note, NEW.requested_by_user_id,
                               NEW.requested_at)
       IS DISTINCT FROM (OLD.interval_value, OLD.interval_unit, OLD.appointment_type_id,
                         OLD.practitioner_id, OLD.note, OLD.requested_by_user_id,
                         OLD.requested_at) THEN
    RAISE EXCEPTION 'follow-up request %: a % request can no longer change', OLD.id, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT ((OLD.status = 'open' AND NEW.status IN ('open', 'booked', 'declined', 'withdrawn'))
          OR (OLD.status = 'booked' AND NEW.status IN ('open', 'booked'))) THEN
    RAISE EXCEPTION 'follow-up request %: cannot go from % to %', OLD.id, OLD.status,
      NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
