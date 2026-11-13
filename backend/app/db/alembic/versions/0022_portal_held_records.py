"""The portal's held records under the portal's own visibility rules (A9: Vimal's #349 and his
review on #85, 13 Nov; D90, D24, D86, Q32).

0011's admin.portal_held_items() returns every active hold of the session patient, including an
item the portal would never show: an entered-in-error problem, an encounter diagnosis that
isn't on the problem list, a draft or entered-in-error document, a psychotherapy note, or a
result that isn't final. It stays exactly as it is, because the portal's visit-summary read on
main selects its item_date; it is dropped after the demo, once that read has moved. This adds:

  admin.portal_held_records()  RETURNS (item_type, item_id, patient_id, hold_active): one row
                               per held item of the session patient (Condition,
                               DocumentReference, DiagnosticReport), hold_active true while any
                               hold on it is not lifted. Each branch applies that table's
                               portal_own_chart rule (gen_db_rules.portal_rules) without the
                               hold clause. Never the reason, the clinician or the item's
                               content; no writes. STABLE SECURITY DEFINER, search_path pinned,
                               owner shri_migrator, EXECUTE for shri_portal only (nothing for
                               PUBLIC).

No table, column, policy or other grant changes. The downgrade drops only the new function.

Revision ID: 0022
Revises: 0021
Create Date: 2026-11-13
"""
from __future__ import annotations

from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None

HELD_RECORDS = """
-- The session patient's held records, for the portal's "held by your clinician" markers (D86,
-- D90): which item, whose, and whether a hold on it is still active; never its content, the
-- reason or the clinician. The items are hidden from shri_portal while held, so this reads them
-- as the migrator, under forced row security (the session's clinic only), for the session's
-- patient only, and only items the portal would show once released (each table's
-- portal_own_chart rule without its hold clause).
CREATE FUNCTION admin.portal_held_records()
RETURNS TABLE (item_type text, item_id uuid, patient_id uuid, hold_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT held.item_type, held.item_id, held.patient_id, bool_or(held.active)
    FROM (
      SELECT 'DocumentReference'::text AS item_type, d.id AS item_id, h.patient_id,
             h.lifted_at IS NULL AS active
        FROM admin.release_hold h
        JOIN clinical.document_reference d ON d.id = h.document_reference_id
       WHERE h.patient_id = NULLIF(current_setting('app.current_patient_id', true), '')::uuid
         AND d.subject_patient_id = h.patient_id
         AND d.status::text NOT IN ('draft', 'entered-in-error')
         AND NOT (d.meta_security && ARRAY['PSY']::varchar[])
      UNION ALL
      SELECT 'DiagnosticReport', r.id, h.patient_id, h.lifted_at IS NULL
        FROM admin.release_hold h
        JOIN clinical.diagnostic_report r ON r.id = h.diagnostic_report_id
       WHERE h.patient_id = NULLIF(current_setting('app.current_patient_id', true), '')::uuid
         AND r.subject_patient_id = h.patient_id
         AND r.status::text IN ('final', 'amended', 'corrected', 'appended')
      UNION ALL
      SELECT 'Condition', c.id, h.patient_id, h.lifted_at IS NULL
        FROM admin.release_hold h
        JOIN clinical.condition c ON c.id = h.condition_id
       WHERE h.patient_id = NULLIF(current_setting('app.current_patient_id', true), '')::uuid
         AND c.subject_patient_id = h.patient_id
         AND c.verification_status::text IS DISTINCT FROM 'entered-in-error'
         AND EXISTS (SELECT 1 FROM clinical.condition_category k
                      WHERE k.condition_id = c.id AND k.category_code = 'problem-list-item')
    ) held
   GROUP BY held.item_type, held.item_id, held.patient_id
$$;
ALTER FUNCTION admin.portal_held_records() OWNER TO shri_migrator;
REVOKE ALL ON FUNCTION admin.portal_held_records() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.portal_held_records() TO shri_portal;
"""


def upgrade() -> None:
    op.execute(HELD_RECORDS)


def downgrade() -> None:
    op.execute("DROP FUNCTION admin.portal_held_records()")
