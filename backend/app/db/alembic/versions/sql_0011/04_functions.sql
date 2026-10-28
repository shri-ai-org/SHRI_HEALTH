-- The portal's sign-in functions (ADR-0013 §3, §5; Thulasi on #13: EXECUTE for shri_app,
-- since core's sign-in path runs as shri_app before any patient is known) and the staff
-- back-channel logout (D94; the shape from #80). Hand-written. Frozen. Every one is SECURITY
-- DEFINER, owned by shri_migrator, with search_path pinned and every name schema-qualified;
-- EXECUTE is revoked from PUBLIC and granted to shri_app only. RLS is forced, so each comes
-- with narrow shri_migrator policies that let it see exactly the rows it needs.

-- ============================================================ cookie to portal session
-- Live sessions of active accounts only. It returns only IDs: core then sets the clinic and
-- the patient (app.current_tenant_id, app.current_patient_id) and works under RLS.
CREATE POLICY migrator_portal_session_lookup ON admin.portal_session FOR SELECT TO shri_migrator
  USING (revoked_at IS NULL AND expires_at > now());
CREATE POLICY migrator_portal_account_lookup ON admin.portal_account FOR SELECT TO shri_migrator
  USING (status IN ('pending-setup', 'active'));

CREATE FUNCTION admin.lookup_portal_session(p_token_hash text)
RETURNS TABLE (session_id uuid, tenant_id uuid, patient_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.id, s.tenant_id, s.patient_id
    FROM admin.portal_session s
    JOIN admin.portal_account a ON a.id = s.account_id AND a.status = 'active'
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND s.idle_expires_at > now()
$$;
REVOKE EXECUTE ON FUNCTION admin.lookup_portal_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.lookup_portal_session(text) TO shri_app;

-- ===================================================== /callback: the account behind a login
-- A pending-setup or active account only; a disabled or suspended one gets nothing.
CREATE FUNCTION admin.lookup_portal_account(p_keycloak_user_id text)
RETURNS TABLE (account_id uuid, tenant_id uuid, patient_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.id, a.tenant_id, a.patient_id, a.status::text
    FROM admin.portal_account a
   WHERE a.keycloak_user_id = p_keycloak_user_id
     AND a.status IN ('pending-setup', 'active')
$$;
REVOKE EXECUTE ON FUNCTION admin.lookup_portal_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.lookup_portal_account(text) TO shri_app;

-- ======================================================== enrolment: redeem an invitation
-- The code's HMAC and the date of birth are checked together, in the database, so the API
-- never reads a chart's date of birth before the patient is known (ADR-0013 §3). On success
-- the invitation is used and the clinic, patient and invitation come back. On any failure
-- nothing comes back, and a wrong date of birth adds a try; the fifth revokes the invitation.
-- The caller commits either way, so failed tries count.
-- Unexpired invitations, open or not: an UPDATE's new row must stay visible to the role, so
-- the one just used or revoked has to be; the function itself acts only on open ones.
CREATE POLICY migrator_portal_invitation_open ON admin.portal_invitation FOR SELECT
  TO shri_migrator USING (expires_at > now());
-- WITH CHECK (true): the row it marks used or revoked is no longer open.
CREATE POLICY migrator_portal_invitation_redeem ON admin.portal_invitation FOR UPDATE
  TO shri_migrator USING (used_at IS NULL AND revoked_at IS NULL AND expires_at > now())
  WITH CHECK (true);
-- The date of birth of a patient with an open invitation, and nothing else of any chart.
CREATE POLICY migrator_portal_invitation_patient ON clinical.patient FOR SELECT TO shri_migrator
  USING (EXISTS (SELECT 1 FROM admin.portal_invitation i
                  WHERE i.patient_id = patient.id AND i.used_at IS NULL
                    AND i.revoked_at IS NULL AND i.expires_at > now()));

CREATE FUNCTION admin.redeem_portal_invitation(p_code_hmac text, p_birth_date date)
RETURNS TABLE (tenant_id uuid, patient_id uuid, invitation_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE inv record; dob date;
BEGIN
  SELECT i.id, i.tenant_id, i.patient_id, i.failed_tries INTO inv
    FROM admin.portal_invitation i
   WHERE i.code_hmac = p_code_hmac AND i.used_at IS NULL AND i.revoked_at IS NULL
     AND i.expires_at > now()
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT p.birth_date INTO dob FROM clinical.patient p WHERE p.id = inv.patient_id;
  IF dob IS NULL OR p_birth_date IS NULL OR dob <> p_birth_date THEN
    UPDATE admin.portal_invitation i
       SET failed_tries = inv.failed_tries + 1,
           revoked_at = CASE WHEN inv.failed_tries + 1 >= 5 THEN now() END,
           updated_at = now()
     WHERE i.id = inv.id;
    RETURN;
  END IF;
  UPDATE admin.portal_invitation i SET used_at = now(), updated_at = now() WHERE i.id = inv.id;
  tenant_id := inv.tenant_id; patient_id := inv.patient_id; invitation_id := inv.id;
  RETURN NEXT;
END $$;
REVOKE EXECUTE ON FUNCTION admin.redeem_portal_invitation(text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.redeem_portal_invitation(text, date) TO shri_app;

-- ============================================== the staff back-channel logout (D94, #80)
-- Core has validated the logout token (signature, iss, aud, iat, the events claim). This
-- records its jti, so a replay is refused (P0001; core answers 400), and ends the sessions it
-- names, across clinics, since no clinic is known yet: the one Keycloak session (sid), or, with
-- only sub, every live session of that user. It returns the sessions it ended, so core can
-- write each one's security audit row in its clinic.
CREATE POLICY migrator_logout_token_record ON admin.consumed_logout_token FOR INSERT
  TO shri_migrator WITH CHECK (true);
CREATE POLICY migrator_backchannel_end ON admin.app_session FOR UPDATE TO shri_migrator
  USING (revoked_at IS NULL) WITH CHECK (revoked_at IS NOT NULL);
-- Sessions not past their absolute expiry, ended or not: the session just ended must stay
-- visible to the role for the UPDATE to complete.
CREATE POLICY migrator_backchannel_read ON admin.app_session FOR SELECT TO shri_migrator
  USING (expires_at > now());
-- The users with a live session, to match the token's sub; no other user is in reach.
CREATE POLICY migrator_backchannel_user ON admin.app_user FOR SELECT TO shri_migrator
  USING (EXISTS (SELECT 1 FROM admin.app_session s
                  WHERE s.user_id = app_user.id AND s.revoked_at IS NULL
                    AND s.expires_at > now()));

CREATE FUNCTION admin.end_backchannel_sessions(p_jti text, p_jti_expires_at timestamptz,
                                               p_sid text, p_subject text)
RETURNS TABLE (session_id uuid, tenant_id uuid, user_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ended uuid[];
BEGIN
  IF coalesce(length(p_jti), 0) = 0 OR p_jti_expires_at IS NULL THEN
    RAISE EXCEPTION 'logout token: jti and its expiry are required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(length(p_sid), 0) = 0 AND coalesce(length(p_subject), 0) = 0 THEN
    RAISE EXCEPTION 'logout token: names neither a session (sid) nor a user (sub)'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    INSERT INTO admin.consumed_logout_token (id, jti, expires_at)
    VALUES (gen_random_uuid(), p_jti, p_jti_expires_at);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'logout token: already used' USING ERRCODE = 'P0001',
      CONSTRAINT = 'logout_token_replayed';
  END;
  -- Chosen first and returned from the lock, because an ended session is no longer visible
  -- to the migrator (migrator_session_lookup shows live sessions only).
  SELECT coalesce(array_agg(x.id), '{}') INTO ended FROM (
    SELECT s.id FROM admin.app_session s
     WHERE s.revoked_at IS NULL
       AND CASE WHEN coalesce(length(p_sid), 0) > 0 THEN s.keycloak_sid = p_sid
                ELSE s.user_id IN (SELECT u.id FROM admin.app_user u
                                    WHERE u.keycloak_subject = p_subject) END
       FOR UPDATE) x;
  RETURN QUERY SELECT s.id, s.tenant_id, s.user_id FROM admin.app_session s
                WHERE s.id = ANY (ended);
  UPDATE admin.app_session s SET revoked_at = now(), updated_at = now()
   WHERE s.id = ANY (ended);
END $$;
REVOKE EXECUTE ON FUNCTION admin.end_backchannel_sessions(text, timestamptz, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.end_backchannel_sessions(text, timestamptz, text, text)
  TO shri_app;

-- ======================================================================= retention
-- Portal sessions 24 hours after they end, as staff sessions; invitations 24 hours after they
-- were used, revoked or expired (the account keeps who enrolled and when); used logout tokens
-- once the token itself has expired, when it can no longer be replayed.
CREATE POLICY migrator_purge_read ON admin.portal_session FOR SELECT TO shri_migrator
  USING (least(revoked_at, idle_expires_at, expires_at) < now() - interval '24 hours');
CREATE POLICY migrator_purge ON admin.portal_session FOR DELETE TO shri_migrator
  USING (least(revoked_at, idle_expires_at, expires_at) < now() - interval '24 hours');
CREATE POLICY migrator_purge_read ON admin.portal_invitation FOR SELECT TO shri_migrator
  USING (least(used_at, revoked_at, expires_at) < now() - interval '24 hours');
CREATE POLICY migrator_purge ON admin.portal_invitation FOR DELETE TO shri_migrator
  USING (least(used_at, revoked_at, expires_at) < now() - interval '24 hours');
CREATE POLICY migrator_purge_read ON admin.consumed_logout_token FOR SELECT TO shri_migrator
  USING (expires_at < now());
CREATE POLICY migrator_purge ON admin.consumed_logout_token FOR DELETE TO shri_migrator
  USING (expires_at < now());

CREATE OR REPLACE FUNCTION admin.purge_expired_runtime_rows()
RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM admin.app_session
   WHERE least(revoked_at, idle_expires_at, expires_at) < now() - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'app_session'; deleted := n; RETURN NEXT;
  DELETE FROM admin.idempotency_record WHERE expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'idempotency_record'; deleted := n; RETURN NEXT;
  DELETE FROM admin.event_log WHERE created_at < now() - interval '10 minutes';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'event_log'; deleted := n; RETURN NEXT;
  DELETE FROM admin.operation WHERE completed_at < now() - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'operation'; deleted := n; RETURN NEXT;
  DELETE FROM admin.pre_registration
   WHERE (status = 'pending' AND created_at < now() - interval '30 days')
      OR (status = 'rejected' AND decided_at < now() - interval '30 days');
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'pre_registration'; deleted := n; RETURN NEXT;
  DELETE FROM admin.portal_session
   WHERE least(revoked_at, idle_expires_at, expires_at) < now() - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'portal_session'; deleted := n; RETURN NEXT;
  DELETE FROM admin.portal_invitation
   WHERE least(used_at, revoked_at, expires_at) < now() - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'portal_invitation'; deleted := n; RETURN NEXT;
  DELETE FROM admin.consumed_logout_token WHERE expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'consumed_logout_token'; deleted := n;
  RETURN NEXT;
END $$;

-- =================================================================== part 2: the portal (D93)
-- A decided request is final: accepted or declined, it stays as it was decided.
CREATE FUNCTION public.shri_final_once_decided() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION '% %: it was % and no longer changes', TG_TABLE_NAME, OLD.id, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- A hold is lifted once and stays lifted (D90): its record of who held it, why and when is
-- kept as it was.
CREATE FUNCTION public.shri_release_hold_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.lifted_at IS NOT NULL THEN
    RAISE EXCEPTION 'release hold %: it was lifted and no longer changes', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- The session patient's held items, for the portal's "held by your clinician" markers (D86,
-- D90): which item and its date, never its content, the reason or the clinician. The items
-- themselves are hidden from shri_portal, so this reads them as the migrator, in the session's
-- clinic and for the session's patient only. The date is the visit or document's date, the
-- result's issue date, or the problem's recorded date.
CREATE FUNCTION admin.portal_held_items()
RETURNS TABLE (item_type text, item_id uuid, item_date timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'DocumentReference', d.id, d.date
    FROM admin.release_hold h JOIN clinical.document_reference d ON d.id = h.document_reference_id
   WHERE h.lifted_at IS NULL
     AND h.patient_id = NULLIF(current_setting('app.current_patient_id', true), '')::uuid
  UNION ALL
  SELECT 'DiagnosticReport', r.id, r.issued
    FROM admin.release_hold h JOIN clinical.diagnostic_report r ON r.id = h.diagnostic_report_id
   WHERE h.lifted_at IS NULL
     AND h.patient_id = NULLIF(current_setting('app.current_patient_id', true), '')::uuid
  UNION ALL
  SELECT 'Condition', c.id, c.recorded_date
    FROM admin.release_hold h JOIN clinical.condition c ON c.id = h.condition_id
   WHERE h.lifted_at IS NULL
     AND h.patient_id = NULLIF(current_setting('app.current_patient_id', true), '')::uuid
$$;
REVOKE EXECUTE ON FUNCTION admin.portal_held_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.portal_held_items() TO shri_portal;

-- When a provider is busy, for online booking's free times (ADR-0013; the contract's
-- PortalSlot is computed, not stored). Other patients' appointments are hidden from
-- shri_portal, so this returns only the blocking times of one provider in the session's
-- clinic, at most 62 days, with nothing about whose they are.
CREATE FUNCTION admin.portal_busy_times(p_practitioner_id uuid, p_from timestamptz,
                                        p_to timestamptz)
RETURNS TABLE (start_at timestamptz, end_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '62 days' THEN
    RAISE EXCEPTION 'busy times: a window of up to 62 days' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT p.period_start, p.period_end FROM clinical.appointment_participant p
   WHERE p.actor_practitioner_id = p_practitioner_id AND p.ext_blocking
     AND p.period_start < p_to AND p.period_end > p_from
   ORDER BY p.period_start;
END $$;
REVOKE EXECUTE ON FUNCTION admin.portal_busy_times(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.portal_busy_times(uuid, timestamptz, timestamptz)
  TO shri_portal;

-- 0002's history snapshot, recording the patient as the author of a version written in a
-- portal session (ADR-0013 §6), where there is no user. A staff user, when set, is the author.
CREATE OR REPLACE FUNCTION public.shri_fhir_history() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = clinical, admin, audit, public, pg_temp AS $$
DECLARE ver int; snap jsonb; who_user uuid; who_patient uuid;
BEGIN
  EXECUTE format('SELECT meta_version_id, shri_snapshot_%s($1) FROM %I WHERE id = $1',
                 TG_TABLE_NAME, TG_TABLE_NAME) INTO ver, snap USING NEW.id;
  IF snap IS NULL THEN
    RETURN NULL;
  END IF;
  who_user := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  IF who_user IS NULL THEN
    who_patient := NULLIF(current_setting('app.current_patient_id', true), '')::uuid;
  END IF;
  INSERT INTO fhir_resource_history (tenant_id, resource_type, resource_id, version_id,
                                     recorded_by_user_id, recorded_by_patient_id, snapshot)
  VALUES (NEW.tenant_id, TG_ARGV[0], NEW.id, ver, who_user, who_patient, snap)
  ON CONFLICT (resource_type, resource_id, version_id) DO NOTHING;
  RETURN NULL;
END $$;
