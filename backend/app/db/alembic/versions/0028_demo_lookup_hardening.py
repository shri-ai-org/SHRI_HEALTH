"""The demo sign-in's lookup never matches a number with no digits (hardening of 0027; Anand's
review of #432, 18 Nov).

0027's phone match compares a contact point's digits with app.demo_portal_phone. The function
clears that setting to '' before it returns, and a contact value made only of separators (the
phone format allows "(((((((") has '' as its digits, so within the rest of that transaction the
three migrator policies would match such a number. The match now also requires the setting to
be non-empty. The same three policies and the function are re-created with that one condition
added; nothing else changes (grants, owner, the demo-clinic limit, the function's rules).

Revision ID: 0028
Revises: 0027
Create Date: 2026-11-18
"""
from __future__ import annotations

from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None

#: The demo seed's clinic, as in 0027.
DEMO_CLINIC = "0a000000-0000-4000-8000-00000000000a"

#: 0027's match (alias cp), with GUARD where the new condition goes.
_PHONE_MATCH = """cp.tenant_id = 'DEMO_CLINIC'::uuid AND cp.system IN ('phone', 'sms')
       AND (cp.period_end IS NULL OR cp.period_end > now())GUARD
       AND CASE WHEN length(regexp_replace(cp.value, '[^0-9]', '', 'g')) = 10
                THEN '1' || regexp_replace(cp.value, '[^0-9]', '', 'g')
                ELSE regexp_replace(cp.value, '[^0-9]', '', 'g') END
           = current_setting('app.demo_portal_phone', true)"""
#: The new condition: the setting holds a number (it is '' once the function has returned).
_GUARD = "\n       AND coalesce(current_setting('app.demo_portal_phone', true), '') <> ''"

_DROP_POLICIES = """
DROP POLICY migrator_demo_portal_account ON admin.portal_account;
DROP POLICY migrator_demo_portal_patient ON clinical.patient;
DROP POLICY migrator_demo_portal_phone ON clinical.contact_point;
"""

_LOOKUP = """
CREATE POLICY migrator_demo_portal_phone ON clinical.contact_point FOR SELECT TO shri_migrator
  USING (patient_id IS NOT NULL AND PHONE_MATCH_HERE);
CREATE POLICY migrator_demo_portal_patient ON clinical.patient FOR SELECT TO shri_migrator
  USING (EXISTS (SELECT 1 FROM clinical.contact_point cp
                  WHERE cp.patient_id = patient.id AND PHONE_MATCH)
         AND tenant_id = 'DEMO_CLINIC'::uuid);
CREATE POLICY migrator_demo_portal_account ON admin.portal_account FOR SELECT TO shri_migrator
  USING (tenant_id = 'DEMO_CLINIC'::uuid AND status IN ('disabled', 'suspended') AND EXISTS (
    SELECT 1 FROM clinical.contact_point cp
     WHERE cp.patient_id = portal_account.patient_id AND PHONE_MATCH));

-- The demo sign-in's lookup (SHRI_DEMO only; core refuses to start with it on elsewhere): one
-- chart of the demo seed's clinic by mobile number and date of birth, or nothing.
CREATE OR REPLACE FUNCTION admin.demo_portal_patient(p_phone_digits text, p_birth_date date)
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
   WHERE p.tenant_id = 'DEMO_CLINIC'::uuid AND p.active AND p.birth_date = p_birth_date
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


def _lookup(guard: str) -> str:
    match = _PHONE_MATCH.replace("GUARD", guard)
    return (_DROP_POLICIES
            + _LOOKUP.replace("PHONE_MATCH_HERE", match.replace("cp.", "contact_point."))
            .replace("PHONE_MATCH", match).replace("DEMO_CLINIC", DEMO_CLINIC))


def upgrade() -> None:
    op.execute(_lookup(_GUARD))


def downgrade() -> None:
    op.execute(_lookup(""))
