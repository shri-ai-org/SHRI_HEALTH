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
