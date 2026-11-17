"""The patient portal reads one file's metadata, for its after-visit summary download (PR A;
D105, D93; Anand's design, approved 17 Nov).

shri_portal has no privilege on admin.binary_object and gets none. The portal's download path
(getPortalVisitSummaryDownloadUrl, downloadPortalFileContent) needs one file's storage fields to
decrypt and stream it, so this adds one function that hands out exactly that row and nothing
else:

  admin.portal_file(p_file_id uuid)
      RETURNS (id, bucket, storage_key, wrapped_data_key, size_bytes, sha256, content_type,
               purpose, document_reference_id)
      One row only when the file is clean, of purpose after-visit-summary (no other purpose,
      imaging included), attached through document_reference_content to a current document
      (status current; docStatus absent, final or amended, so never a preliminary draft) of
      the session patient (app.current_patient_id) in the session's clinic
      (app.current_tenant_id), not labelled PSY, and with no active hold on it
      (portal_held_records(): only hold_active rows count, so a lifted hold no longer
      withholds the file). Otherwise no row, the same for a missing file and a refused one.
      STABLE SECURITY DEFINER, owner shri_migrator, search_path pinned to
      pg_catalog, pg_temp (every name schema-qualified); EXECUTE for shri_portal only,
      nothing for PUBLIC.

No table, column, policy or other grant changes. The downgrade drops only the new function.

Revision ID: 0025
Revises: 0024
Create Date: 2026-11-17
"""
from __future__ import annotations

from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None

PORTAL_FILE = """
-- One file's storage fields, for the portal's after-visit summary download only (D105, D93):
-- a clean summary on a current, released document of the session patient. It runs as the
-- migrator under forced row security (the session's clinic only), so it never reads another
-- clinic's rows, and names the session patient itself, never one from its caller.
CREATE FUNCTION admin.portal_file(p_file_id uuid)
RETURNS TABLE (id uuid, bucket text, storage_key text, wrapped_data_key text,
               size_bytes bigint, sha256 text, content_type text, purpose text,
               document_reference_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT b.id, b.bucket::text, b.storage_key::text, b.wrapped_data_key::text, b.size_bytes,
         b.sha256::text, b.content_type::text, b.purpose::text, d.id
    FROM admin.binary_object b
    JOIN clinical.document_reference_content c ON c.attachment_binary_object_id = b.id
    JOIN clinical.document_reference d ON d.id = c.document_reference_id
   WHERE b.id = p_file_id
     AND b.tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
     AND d.tenant_id = b.tenant_id
     AND d.subject_patient_id = NULLIF(current_setting('app.current_patient_id', true), '')::uuid
     AND b.state::text = 'clean'
     AND b.purpose::text = 'after-visit-summary'
     AND d.status::text = 'current'
     AND (d.doc_status IS NULL OR d.doc_status::text IN ('final', 'amended'))
     AND NOT (coalesce(d.meta_security, ARRAY[]::varchar[]) && ARRAY['PSY']::varchar[])
     AND NOT EXISTS (SELECT 1 FROM admin.portal_held_records() h
                      WHERE h.item_type = 'DocumentReference' AND h.item_id = d.id
                        AND h.hold_active)
$$;
ALTER FUNCTION admin.portal_file(uuid) OWNER TO shri_migrator;
REVOKE ALL ON FUNCTION admin.portal_file(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.portal_file(uuid) TO shri_portal;
"""


def upgrade() -> None:
    op.execute(PORTAL_FILE)


def downgrade() -> None:
    op.execute("DROP FUNCTION admin.portal_file(uuid)")
