"""admin.portal_held_records() leaves out a hold on a preliminary document (#395; D86, D90).

0022's DocumentReference branch kept out drafts, entered-in-error documents and psychotherapy
notes, but not a document whose docStatus is preliminary, so a hold on a draft visit summary
(status current, docStatus preliminary) still came back as a "held by your clinician" marker,
which tells the patient that a summary exists that the portal never shows once released. The
document branch now also requires docStatus to be absent, final or amended, as the portal's
visit-summary read shows them (Vimal's finding on #395). The result reports and problems branches
are unchanged.

  admin.portal_held_records()  CREATE OR REPLACE: same output columns (item_type, item_id,
                               patient_id, hold_active), same STABLE SECURITY DEFINER, search_path
                               pinned to pg_catalog, pg_temp; owner shri_migrator and EXECUTE for
                               shri_portal only, nothing for PUBLIC, restated.

No table, column, policy or other grant changes. The downgrade puts 0022's body back.

Numbering: 0023 is #387's imaging file purpose, which is approved on its latest commit, so this
is 0024 on top of it (stacked on #387) and the portal file read is 0025.

Revision ID: 0024
Revises: 0023
Create Date: 2026-11-17
"""
from __future__ import annotations

from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None

_DOCUMENT_RELEASED = """
         AND d.status::text NOT IN ('draft', 'entered-in-error')
         AND NOT (d.meta_security && ARRAY['PSY']::varchar[])"""
_DOCUMENT_RELEASED_FINAL = _DOCUMENT_RELEASED + """
         AND (d.doc_status IS NULL OR d.doc_status::text IN ('final', 'amended'))"""


_HELD_RECORDS = """
CREATE OR REPLACE FUNCTION admin.portal_held_records()
RETURNS TABLE (item_type text, item_id uuid, patient_id uuid, hold_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT held.item_type, held.item_id, held.patient_id, bool_or(held.active)
    FROM (
      SELECT 'DocumentReference'::text AS item_type, d.id AS item_id, h.patient_id,
             h.lifted_at IS NULL AS active
        FROM admin.release_hold h
        JOIN clinical.document_reference d ON d.id = h.document_reference_id
       WHERE h.patient_id = NULLIF(current_setting('app.current_patient_id', true), '')::uuid
         AND d.subject_patient_id = h.patient_id@DOCUMENT_RULE@
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


def _held_records(document_rule: str) -> str:
    """0022's function with the document branch's release rule (a constant of this file)."""
    return _HELD_RECORDS.replace("@DOCUMENT_RULE@", document_rule)


def upgrade() -> None:
    op.execute(_held_records(_DOCUMENT_RELEASED_FINAL))


def downgrade() -> None:
    op.execute(_held_records(_DOCUMENT_RELEASED))
