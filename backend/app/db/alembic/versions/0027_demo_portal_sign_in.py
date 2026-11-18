"""The demo server's portal sign-in with a mobile number and date of birth (Vimal's decision on
#85, 18 Nov: "Demo-only mobile + date-of-birth sign-in to the patient portal (SHRI_DEMO only);
real sign-in after the demo"). Core refuses to start with it on outside a demo server, audits
every attempt and rate-limits by number; this is only the database part.

  admin.demo_portal_patient(p_phone_digits text, p_birth_date date)
      RETURNS (tenant_id, patient_id)
      Before a clinic is known, across clinics. p_phone_digits is the E.164 number's digits
      without the '+'; a stored 10-digit U.S. number counts as 1 plus its 10 digits. It counts
      the active (so unmerged: a merge makes the merged chart inactive, D103) patients with that
      date of birth and a current phone or sms contact point with those digits, and answers
      only when exactly one matches, and that one is not restricted (R or V, D37) and has no
      disabled or suspended portal account. Every other case returns nothing, the same as no
      match. Two charts sharing a number and a birth date are never told apart, even when one
      of them would be skipped. Malformed digits or a missing date return nothing.
      VOLATILE SECURITY DEFINER (it sets its lookup setting), owner shri_migrator,
      search_path pinned to pg_catalog, pg_temp (it only reads, so no trigger fires); EXECUTE
      for shri_app only, nothing for PUBLIC.

  The function runs under forced row security as shri_migrator. Three migrator SELECT policies
  let it see the rows of the number it was given, and only while app.demo_portal_phone holds
  that number. The function sets it with set_config (transaction-local) and clears it before
  it returns, so the policies are shut again once it does (an error ends the transaction or
  its savepoint, which takes the setting with it):
      migrator_demo_portal_phone    clinical.contact_point: current phone and sms rows with it
      migrator_demo_portal_patient  clinical.patient: the charts that have such a row
      migrator_demo_portal_account  admin.portal_account: those charts' disabled or suspended
                                    accounts (0011's policy already shows live ones)

  portal_account.sign_in_method     keycloak (the default, every existing account) or
                                    demo-phone. keycloak_user_id is set for keycloak and NULL
                                    for demo-phone (ck_portal_account_keycloak_has_user), and
                                    the method never changes (trg_portal_account_fixed).
  portal_session.sign_in_method     the account's, by a foreign key on (account_id,
                                    sign_in_method). A keycloak session has both encrypted
                                    tokens; a demo-phone session has no tokens and no Keycloak
                                    session ID (ck_portal_session_tokens_match_method).

Existing rows default to keycloak, so nothing written today changes. Core's demo sign-in
creates the account (demo-phone, active, enrolled_at now) and its session (demo-phone) with
the session's audit row, in one transaction. No new role or table grant. The downgrade refuses
while a demo-phone account exists.

Revision ID: 0027
Revises: 0026
Create Date: 2026-11-18
"""
from __future__ import annotations

from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None

#: A contact point (alias cp) that is a current phone or sms number with the looked-up digits.
_PHONE_MATCH = """cp.system IN ('phone', 'sms')
       AND (cp.period_end IS NULL OR cp.period_end > now())
       AND CASE WHEN length(regexp_replace(cp.value, '[^0-9]', '', 'g')) = 10
                THEN '1' || regexp_replace(cp.value, '[^0-9]', '', 'g')
                ELSE regexp_replace(cp.value, '[^0-9]', '', 'g') END
           = current_setting('app.demo_portal_phone', true)"""

COLUMNS = """
ALTER TABLE admin.portal_account
  ADD COLUMN sign_in_method VARCHAR(20) DEFAULT 'keycloak' NOT NULL,
  ALTER COLUMN keycloak_user_id DROP NOT NULL,
  ADD CONSTRAINT uq_portal_account_id_sign_in_method UNIQUE (id, sign_in_method),
  ADD CONSTRAINT ck_portal_account_sign_in_method_codes
    CHECK (sign_in_method IN ('keycloak', 'demo-phone')),
  ADD CONSTRAINT ck_portal_account_keycloak_has_user
    CHECK ((sign_in_method = 'keycloak') = (keycloak_user_id IS NOT NULL));
DROP TRIGGER trg_portal_account_fixed ON admin.portal_account;
CREATE TRIGGER trg_portal_account_fixed BEFORE UPDATE ON admin.portal_account
  FOR EACH ROW EXECUTE FUNCTION shri_fixed_columns('keycloak_user_id', 'patient_id',
  'sign_in_method');
ALTER TABLE admin.portal_session
  ADD COLUMN sign_in_method VARCHAR(20) DEFAULT 'keycloak' NOT NULL,
  ALTER COLUMN keycloak_access_token_enc DROP NOT NULL,
  ALTER COLUMN keycloak_refresh_token_enc DROP NOT NULL,
  ADD CONSTRAINT ck_portal_session_sign_in_method_codes
    CHECK (sign_in_method IN ('keycloak', 'demo-phone')),
  ADD CONSTRAINT ck_portal_session_tokens_match_method
    CHECK ((sign_in_method = 'keycloak' AND keycloak_access_token_enc IS NOT NULL
            AND keycloak_refresh_token_enc IS NOT NULL) OR
           (sign_in_method = 'demo-phone' AND keycloak_access_token_enc IS NULL
            AND keycloak_refresh_token_enc IS NULL AND keycloak_sid IS NULL)),
  ADD CONSTRAINT fk_portal_session_account_sign_in_method FOREIGN KEY (account_id,
    sign_in_method) REFERENCES admin.portal_account (id, sign_in_method);
"""

_LOOKUP = """
CREATE POLICY migrator_demo_portal_phone ON clinical.contact_point FOR SELECT TO shri_migrator
  USING (patient_id IS NOT NULL AND PHONE_MATCH_HERE);
CREATE POLICY migrator_demo_portal_patient ON clinical.patient FOR SELECT TO shri_migrator
  USING (EXISTS (SELECT 1 FROM clinical.contact_point cp
                  WHERE cp.patient_id = patient.id AND PHONE_MATCH));
CREATE POLICY migrator_demo_portal_account ON admin.portal_account FOR SELECT TO shri_migrator
  USING (status IN ('disabled', 'suspended') AND EXISTS (
    SELECT 1 FROM clinical.contact_point cp
     WHERE cp.patient_id = portal_account.patient_id AND PHONE_MATCH));

-- The demo sign-in's lookup (SHRI_DEMO only; core refuses to start with it on elsewhere): one
-- chart by mobile number and date of birth, or nothing.
CREATE FUNCTION admin.demo_portal_patient(p_phone_digits text, p_birth_date date)
RETURNS TABLE (tenant_id uuid, patient_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE matches integer; m_tenant uuid; m_patient uuid; usable boolean := false;
BEGIN
  IF p_birth_date IS NULL OR p_phone_digits IS NULL
     OR p_phone_digits !~ '^[1-9][0-9]{7,14}$' THEN
    RETURN;
  END IF;
  -- Opens the three policies for this number; cleared again below before returning. An error
  -- in between ends the transaction, or its savepoint, which takes the setting with it.
  PERFORM set_config('app.demo_portal_phone', p_phone_digits, true);
  SELECT count(*), min(p.tenant_id::text)::uuid, min(p.id::text)::uuid
    INTO matches, m_tenant, m_patient
    FROM clinical.patient p
   WHERE p.active AND p.birth_date = p_birth_date
     AND EXISTS (SELECT 1 FROM clinical.contact_point cp
                  WHERE cp.patient_id = p.id AND PHONE_MATCH);
  IF matches = 1 THEN
    SELECT NOT (coalesce(p.meta_security, ARRAY[]::varchar[]) && ARRAY['R', 'V']::varchar[])
           AND NOT EXISTS (SELECT 1 FROM admin.portal_account a
                            WHERE a.patient_id = p.id
                              AND a.status IN ('disabled', 'suspended'))
      INTO usable
      FROM clinical.patient p WHERE p.id = m_patient;
  END IF;
  PERFORM set_config('app.demo_portal_phone', '', true);
  IF usable THEN
    tenant_id := m_tenant; patient_id := m_patient;
    RETURN NEXT;
  END IF;
END $$;
ALTER FUNCTION admin.demo_portal_patient(text, date) OWNER TO shri_migrator;
REVOKE ALL ON FUNCTION admin.demo_portal_patient(text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.demo_portal_patient(text, date) TO shri_app;
"""
LOOKUP = (_LOOKUP.replace("PHONE_MATCH_HERE", _PHONE_MATCH.replace("cp.", "contact_point."))
          .replace("PHONE_MATCH", _PHONE_MATCH))

DROP = """
DROP FUNCTION admin.demo_portal_patient(text, date);
DROP POLICY migrator_demo_portal_account ON admin.portal_account;
DROP POLICY migrator_demo_portal_patient ON clinical.patient;
DROP POLICY migrator_demo_portal_phone ON clinical.contact_point;
ALTER TABLE admin.portal_session
  DROP CONSTRAINT fk_portal_session_account_sign_in_method,
  DROP CONSTRAINT ck_portal_session_tokens_match_method,
  DROP CONSTRAINT ck_portal_session_sign_in_method_codes,
  ALTER COLUMN keycloak_refresh_token_enc SET NOT NULL,
  ALTER COLUMN keycloak_access_token_enc SET NOT NULL,
  DROP COLUMN sign_in_method;
DROP TRIGGER trg_portal_account_fixed ON admin.portal_account;
CREATE TRIGGER trg_portal_account_fixed BEFORE UPDATE ON admin.portal_account
  FOR EACH ROW EXECUTE FUNCTION shri_fixed_columns('keycloak_user_id', 'patient_id');
ALTER TABLE admin.portal_account
  DROP CONSTRAINT ck_portal_account_keycloak_has_user,
  DROP CONSTRAINT ck_portal_account_sign_in_method_codes,
  DROP CONSTRAINT uq_portal_account_id_sign_in_method,
  ALTER COLUMN keycloak_user_id SET NOT NULL,
  DROP COLUMN sign_in_method;
"""


def upgrade() -> None:
    op.execute(COLUMNS)
    op.execute(LOOKUP)


def downgrade() -> None:
    op.execute("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM admin.portal_account WHERE sign_in_method = 'demo-phone') THEN
    RAISE EXCEPTION 'demo-phone portal accounts exist; 0027 cannot be downgraded';
  END IF;
END $$;""")
    op.execute(DROP)
