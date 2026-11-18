"""The patient portal reads where its own prescriptions went: the pharmacy's name and the latest
transmission status (listPortalMedications' `pharmacyName` and `transmissionStatus`; D93, D97;
Anand's design, approved 17 Nov).

shri_portal has no privilege on admin.pharmacy or admin.erx_transaction and gets none. The
portal's medication list needs two values per signed prescription, so this adds one function
that hands out exactly those and nothing else:

  admin.portal_prescription_transmissions()
      RETURNS (medication_request_id, pharmacy_name, transmission_status)
      One row per prescription of the session patient (app.current_patient_id) in the
      session's clinic (app.current_tenant_id) that the portal's list shows as a prescription:
      intent order, signed, never draft or entered-in-error, not labelled PSY. The pharmacy
      and the status come from the prescription's latest outbound NewRx; a prescription not
      sent yet has neither. The status is one of the contract's five (queued, sent, accepted,
      rejected, error), otherwise NULL. Never a pharmacy's address, phone or identifiers, an
      error code or message, a vendor message ID, or who signed or sent it. Medications are
      never held (D90: release_hold has no medication column), so there is nothing to hold.
      STABLE SECURITY DEFINER, owner shri_migrator, search_path pinned to pg_catalog, pg_temp
      (every name schema-qualified); EXECUTE for shri_portal only, nothing for PUBLIC.

No table, column, policy or other grant changes. The downgrade drops only the new function.

Revision ID: 0026
Revises: 0025
Create Date: 2026-11-17
"""
from __future__ import annotations

from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None

PORTAL_PRESCRIPTION_TRANSMISSIONS = """
-- Where the session patient's prescriptions went, for the portal's medication list only (D93,
-- D97). It runs as the migrator under forced row security (the session's clinic only), so it
-- never reads another clinic's rows, and names the session patient itself, never one from its
-- caller.
CREATE FUNCTION admin.portal_prescription_transmissions()
RETURNS TABLE (medication_request_id uuid, pharmacy_name text, transmission_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, left(p.name::text, 200),
         CASE WHEN t.status::text IN ('queued', 'sent', 'accepted', 'rejected', 'error')
              THEN t.status::text END
    FROM clinical.medication_request m
    LEFT JOIN LATERAL (
      SELECT x.status, x.pharmacy_id
        FROM admin.erx_transaction x
       WHERE x.medication_request_id = m.id AND x.tenant_id = m.tenant_id
         AND x.message_type::text = 'NewRx' AND x.direction::text = 'outbound'
       ORDER BY x.occurred_at DESC, x.created_at DESC, x.id DESC
       LIMIT 1) t ON true
    LEFT JOIN admin.pharmacy p ON p.id = t.pharmacy_id
   WHERE m.tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
     AND m.subject_patient_id = NULLIF(current_setting('app.current_patient_id', true), '')::uuid
     AND m.intent::text = 'order'
     AND m.ext_signed_at IS NOT NULL
     AND m.status::text NOT IN ('draft', 'entered-in-error')
     AND NOT (coalesce(m.meta_security, ARRAY[]::varchar[]) && ARRAY['PSY']::varchar[])
$$;
ALTER FUNCTION admin.portal_prescription_transmissions() OWNER TO shri_migrator;
REVOKE ALL ON FUNCTION admin.portal_prescription_transmissions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.portal_prescription_transmissions() TO shri_portal;
"""


def upgrade() -> None:
    op.execute(PORTAL_PRESCRIPTION_TRANSMISSIONS)


def downgrade() -> None:
    op.execute("DROP FUNCTION admin.portal_prescription_transmissions()")
