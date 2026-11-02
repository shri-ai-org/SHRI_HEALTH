-- Staff sign-in: who a Keycloak subject is, before a clinic is known (Thulasi on #13, for
-- core's login callback, #126), for migration 0016. Hand-written. Frozen.
-- admin.app_user is clinic-isolated, so shri_app can't find a signing-in user or their clinic.
-- The function runs as its owner, shri_migrator, which is subject to the table's forced RLS,
-- so a policy for shri_migrator alone lets it read the users. It returns IDs and the active
-- flag only; core then sets the clinic and works under RLS, and refuses an inactive user or
-- one with no clinic (platform staff) itself.
CREATE POLICY migrator_staff_lookup ON admin.app_user FOR SELECT TO shri_migrator USING (true);

CREATE FUNCTION admin.lookup_staff_user(p_keycloak_subject text)
RETURNS TABLE (user_id uuid, tenant_id uuid, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.is_active
    FROM admin.app_user u
   WHERE u.keycloak_subject = p_keycloak_subject
$$;
REVOKE EXECUTE ON FUNCTION admin.lookup_staff_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.lookup_staff_user(text) TO shri_app;
