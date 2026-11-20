"""The patient's "My records" download (getPortalRecordDownloadUrl, D105, D86, D90; Anand's design,
go on 20 Nov): the export file, its row, the portal's download of it and its purge.

  admin.binary_object
      `export` joins the server-made purposes, clean from the start without a scan, as
      receipts, after-visit summaries and imaging files are (0012, 0023): the server builds it
      from the chart's own rows, nothing is uploaded under it, and ClamAV is not deployed
      (the file service refuses an upload under a server-made purpose).
        ck_binary_object_generated_clean     an export is always clean
        ck_binary_object_clean_when_scanned  an export is clean without a scan
  admin.portal_record_export
      One export: the clinic, the session patient, its file (unique), its format (`pdf` or
      `fhir-r4`), created_at and expires_at (15 minutes later). Forced row security under the
      clinic policy, and no service role holds any privilege on it (gen_db_rules.DEFINER_ONLY).

  Every function: SECURITY DEFINER, owner shri_migrator, search_path pinned to pg_catalog,
  pg_temp with every name schema-qualified, nothing for PUBLIC, EXECUTE for one role. The clinic
  and the patient come from the session settings, never from an argument.

  shri_portal (each refuses or finds nothing without a session patient):
    admin.portal_clinic()  the session clinic's name and time zone, for the PDF's header.
    admin.portal_record_export(p_file_id, p_format, p_storage_key, p_wrapped_data_key,
        p_size_bytes, p_sha256)  records the file the API has just encrypted and stored: one
        binary_object (purpose export, bucket clean, state clean, scan pending, retention_until
        24 hours after the expiry) and one portal_record_export row. Returns expires_at.
        Refusals: P0002 no session patient; P0001 portal_record_export_format (not pdf or
        fhir-r4), portal_record_export_file (the key isn't `<clinic>/<file>`, no wrapped key,
        or a size outside 1 byte to 10 MiB), portal_record_export_rate_limited (more than 10
        exports in an hour, counted under a per-patient lock).
    admin.portal_file(p_file_id)  (0025) one more branch: a clean export of the session patient
        in the session clinic, not yet expired, with document_reference_id NULL. Every refusal
        is still no row.
  shri_maintenance (the purge job, D23; no table privileges):
    admin.list_expired_exports(p_limit)  exports 24 hours past their expiry, oldest first, as
        (id, tenant_id, bucket, storage_key) of their files: what the job deletes from the store.
    admin.delete_expired_exports(p_ids)  for each file ID: its export row and its file, both
        still expired, in one step, or neither; never a file of another purpose. Returns the IDs
        deleted. Narrow policies TO shri_migrator let these two see and delete exactly those
        rows across clinics, as 0014's do for unusable files.

The downgrade looks at every clinic (row security unforced inside its own transaction only) and
refuses while any export exists, then drops what this added and restores 0025's portal_file()
and 0023's constraints.

Revision ID: 0032
Revises: 0031 (0030 is #463; the chain is renumbered when they merge)
Create Date: 2026-11-20
"""
from __future__ import annotations

from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None

TENANT = "NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid"
PATIENT = "NULLIF(pg_catalog.current_setting('app.current_patient_id', true), '')::uuid"
SERVER_MADE = "'receipt', 'after-visit-summary', 'imaging'"
#: The window after expiry before the purge removes an export (purge.EXPORT_PURGE_AFTER).
PURGE_AFTER = "interval '24 hours'"


def _constraints(generated: str) -> str:
    return f"""
ALTER TABLE admin.binary_object
  DROP CONSTRAINT ck_binary_object_generated_clean,
  DROP CONSTRAINT ck_binary_object_clean_when_scanned,
  ADD CONSTRAINT ck_binary_object_generated_clean
    CHECK (purpose NOT IN ({generated}) OR state = 'clean'),
  ADD CONSTRAINT ck_binary_object_clean_when_scanned
    CHECK (state <> 'clean' OR scan_status = 'clean' OR purpose IN ({generated}));
"""


TABLE = f"""
CREATE TABLE admin.portal_record_export (
  patient_id uuid NOT NULL,
  binary_object_id uuid NOT NULL,
  format varchar(40) NOT NULL,
  expires_at timestamptz NOT NULL,
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  created_by_user_id uuid,
  updated_by_user_id uuid,
  CONSTRAINT pk_portal_record_export PRIMARY KEY (id),
  CONSTRAINT uq_portal_record_export_binary_object_id UNIQUE (binary_object_id),
  CONSTRAINT ck_portal_record_export_expires_after_creation CHECK (expires_at > created_at),
  CONSTRAINT ck_portal_record_export_format_codes CHECK (format IN ('pdf', 'fhir-r4')),
  CONSTRAINT fk_portal_record_export_patient_id_patient FOREIGN KEY (patient_id)
    REFERENCES clinical.patient (id),
  CONSTRAINT fk_portal_record_export_binary_object_id_binary_object
    FOREIGN KEY (binary_object_id) REFERENCES admin.binary_object (id),
  CONSTRAINT fk_portal_record_export_tenant_id_tenant FOREIGN KEY (tenant_id)
    REFERENCES admin.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT fk_portal_record_export_created_by_user_id_app_user FOREIGN KEY (created_by_user_id)
    REFERENCES admin.app_user (id) ON DELETE SET NULL,
  CONSTRAINT fk_portal_record_export_updated_by_user_id_app_user FOREIGN KEY (updated_by_user_id)
    REFERENCES admin.app_user (id) ON DELETE SET NULL
);
ALTER TABLE admin.portal_record_export
  ADD CONSTRAINT fk_portal_record_export_binary_object_id_tenant
  FOREIGN KEY (tenant_id, binary_object_id) REFERENCES admin.binary_object (tenant_id, id);
ALTER TABLE admin.portal_record_export ADD CONSTRAINT fk_portal_record_export_patient_id_tenant
  FOREIGN KEY (tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
CREATE INDEX ix_portal_record_export_expires_at ON admin.portal_record_export (expires_at, id);
CREATE INDEX ix_portal_record_export_patient_recent ON admin.portal_record_export
  (tenant_id, patient_id, created_at);
CREATE INDEX ix_portal_record_export_tenant_id ON admin.portal_record_export (tenant_id);
ALTER TABLE admin.portal_record_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.portal_record_export FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin.portal_record_export USING (tenant_id = {TENANT})
  WITH CHECK (tenant_id = {TENANT});
REVOKE ALL ON admin.portal_record_export FROM PUBLIC;

-- The purge's reach (RLS is forced, so it binds the owner too): across clinics, only exports
-- 24 hours past their expiry, and only for reading and deleting. The service roles gain nothing.
CREATE POLICY migrator_export_purge_read ON admin.portal_record_export FOR SELECT
  TO shri_migrator USING (expires_at < now() - {PURGE_AFTER});
CREATE POLICY migrator_export_purge ON admin.portal_record_export FOR DELETE
  TO shri_migrator USING (expires_at < now() - {PURGE_AFTER});
CREATE POLICY migrator_export_purge_read ON admin.binary_object FOR SELECT TO shri_migrator
  USING (purpose = 'export' AND retention_until < now());
CREATE POLICY migrator_export_purge ON admin.binary_object FOR DELETE TO shri_migrator
  USING (purpose = 'export' AND retention_until < now());
"""

# 0025's after-visit summary branch, unchanged but for the qualified names, and the export's.
PORTAL_FILE_BODY = f"""
  SELECT b.id, b.bucket::text, b.storage_key::text, b.wrapped_data_key::text, b.size_bytes,
         b.sha256::text, b.content_type::text, b.purpose::text, d.id
    FROM admin.binary_object b
    JOIN clinical.document_reference_content c ON c.attachment_binary_object_id = b.id
    JOIN clinical.document_reference d ON d.id = c.document_reference_id
   WHERE b.id = p_file_id
     AND b.tenant_id = {TENANT}
     AND d.tenant_id = b.tenant_id
     AND d.subject_patient_id = {PATIENT}
     AND b.state::text = 'clean'
     AND b.purpose::text = 'after-visit-summary'
     AND d.status::text = 'current'
     AND (d.doc_status IS NULL OR d.doc_status::text IN ('final', 'amended'))
     AND NOT (coalesce(d.meta_security, ARRAY[]::varchar[]) && ARRAY['PSY']::varchar[])
     AND NOT EXISTS (SELECT 1 FROM admin.portal_held_records() h
                      WHERE h.item_type = 'DocumentReference' AND h.item_id = d.id
                        AND h.hold_active)
  UNION ALL
  SELECT b.id, b.bucket::text, b.storage_key::text, b.wrapped_data_key::text, b.size_bytes,
         b.sha256::text, b.content_type::text, b.purpose::text, NULL::uuid
    FROM admin.binary_object b
    JOIN admin.portal_record_export e ON e.binary_object_id = b.id AND e.tenant_id = b.tenant_id
   WHERE b.id = p_file_id
     AND b.tenant_id = {TENANT}
     AND e.patient_id = {PATIENT}
     AND b.state::text = 'clean'
     AND b.purpose::text = 'export'
     AND e.expires_at > now()
"""  # noqa: S608

PORTAL_FILE_SIGNATURE = """
CREATE OR REPLACE FUNCTION admin.portal_file(p_file_id uuid)
RETURNS TABLE (id uuid, bucket text, storage_key text, wrapped_data_key text,
               size_bytes bigint, sha256 text, content_type text, purpose text,
               document_reference_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$"""

# 0025's function exactly as it was, for the downgrade.
PORTAL_FILE_0025 = PORTAL_FILE_SIGNATURE + """
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
$$;"""  # noqa: S608

# S608: every piece put into this SQL is a constant of this file.
PORTAL = f"""
CREATE FUNCTION admin.portal_clinic()
RETURNS TABLE (name text, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.name::text, t.timezone::text FROM admin.tenant t
   WHERE t.id = {TENANT} AND {PATIENT} IS NOT NULL
$$;

CREATE FUNCTION admin.portal_record_export(p_file_id uuid, p_format text, p_storage_key text,
                                           p_wrapped_data_key text, p_size_bytes bigint,
                                           p_sha256 text)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := {TENANT};
  v_patient uuid := {PATIENT};
  v_expires timestamptz := now() + interval '15 minutes';
BEGIN
  IF v_tenant IS NULL OR v_patient IS NULL OR NOT EXISTS (
       SELECT 1 FROM clinical.patient p WHERE p.id = v_patient AND p.tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'no portal patient' USING ERRCODE = 'P0002';
  END IF;
  IF p_format IS NULL OR p_format NOT IN ('pdf', 'fhir-r4') THEN
    RAISE EXCEPTION 'not an export format'
      USING ERRCODE = 'P0001', CONSTRAINT = 'portal_record_export_format';
  END IF;
  -- Only the key the file service makes for this clinic and this file, so no caller can name
  -- another clinic's object; sealed (a wrapped data key), and of a sane size.
  IF p_file_id IS NULL OR p_storage_key IS DISTINCT FROM v_tenant::text || '/' || p_file_id::text
     OR coalesce(pg_catalog.btrim(p_wrapped_data_key), '') = ''
     OR p_size_bytes IS NULL OR p_size_bytes < 1 OR p_size_bytes > 10485760 THEN
    RAISE EXCEPTION 'not a stored export file'
      USING ERRCODE = 'P0001', CONSTRAINT = 'portal_record_export_file';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('portal-record-export'),
                                           pg_catalog.hashtext(v_patient::text));
  IF (SELECT count(*) FROM admin.portal_record_export e WHERE e.tenant_id = v_tenant
         AND e.patient_id = v_patient AND e.created_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'too many record downloads; try again later'
      USING ERRCODE = 'P0001', CONSTRAINT = 'portal_record_export_rate_limited';
  END IF;
  INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, content_type, size_bytes,
                                   sha256, purpose, state, scan_status, wrapped_data_key,
                                   retention_until)
  VALUES (p_file_id, v_tenant, 'clean', p_storage_key,
          CASE p_format WHEN 'pdf' THEN 'application/pdf' ELSE 'application/fhir+json' END,
          p_size_bytes, p_sha256, 'export', 'clean', 'pending', p_wrapped_data_key,
          v_expires + {PURGE_AFTER});
  INSERT INTO admin.portal_record_export (id, tenant_id, patient_id, binary_object_id, format,
                                          expires_at)
  VALUES (gen_random_uuid(), v_tenant, v_patient, p_file_id, p_format, v_expires);
  RETURN v_expires;
END $$;
"""  # noqa: S608

MAINTENANCE = f"""
CREATE FUNCTION admin.list_expired_exports(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, bucket text, storage_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT b.id, b.tenant_id, b.bucket::text, b.storage_key::text
    FROM admin.portal_record_export e
    JOIN admin.binary_object b ON b.id = e.binary_object_id AND b.tenant_id = e.tenant_id
   WHERE e.expires_at < now() - {PURGE_AFTER}
     AND b.purpose::text = 'export' AND b.retention_until < now()
   ORDER BY e.expires_at, e.id
   LIMIT p_limit;
END $$;

CREATE FUNCTION admin.delete_expired_exports(p_ids uuid[])
RETURNS TABLE (id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE f uuid;
BEGIN
  IF p_ids IS NULL OR pg_catalog.cardinality(p_ids) > 1000 THEN
    RAISE EXCEPTION 'between 0 and 1000 file IDs' USING ERRCODE = '22023';
  END IF;
  FOR f IN SELECT DISTINCT u.x FROM pg_catalog.unnest(p_ids) AS u(x) WHERE u.x IS NOT NULL
            ORDER BY u.x LOOP
    BEGIN
      DELETE FROM admin.portal_record_export e
       WHERE e.binary_object_id = f AND e.expires_at < now() - {PURGE_AFTER};
      IF FOUND THEN
        DELETE FROM admin.binary_object b
         WHERE b.id = f AND b.purpose::text = 'export' AND b.retention_until < now();
        IF NOT FOUND THEN
          RAISE EXCEPTION 'kept' USING ERRCODE = 'P0001';  -- undoes the row's delete
        END IF;
        id := f;
        RETURN NEXT;
      END IF;
    EXCEPTION WHEN raise_exception OR foreign_key_violation THEN
      NULL;  -- kept, row and file
    END;
  END LOOP;
END $$;
"""  # noqa: S608

FUNCTIONS = {
    "admin.portal_clinic()": "shri_portal",
    "admin.portal_record_export(uuid, text, text, text, bigint, text)": "shri_portal",
    "admin.list_expired_exports(integer)": "shri_maintenance",
    "admin.delete_expired_exports(uuid[])": "shri_maintenance",
}


def upgrade() -> None:
    op.execute(_constraints(f"{SERVER_MADE}, 'export'"))
    op.execute(TABLE)
    op.execute(PORTAL)
    op.execute(MAINTENANCE)
    for function, role in FUNCTIONS.items():
        op.execute(f"ALTER FUNCTION {function} OWNER TO shri_migrator; "
                   f"REVOKE ALL ON FUNCTION {function} FROM PUBLIC; "
                   f"GRANT EXECUTE ON FUNCTION {function} TO {role};")
    # Replaced in place: its owner (shri_migrator) and EXECUTE for shri_portal only stay.
    op.execute(PORTAL_FILE_SIGNATURE + PORTAL_FILE_BODY + "$$;")


def downgrade() -> None:
    # Every clinic's rows: the owner looks without forced row security, inside this transaction
    # only. An export is a copy with a 24-hour life; refuse rather than leave its object behind.
    op.execute("""
ALTER TABLE admin.binary_object NO FORCE ROW LEVEL SECURITY;
ALTER TABLE admin.portal_record_export NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM admin.binary_object WHERE purpose = 'export')
     OR EXISTS (SELECT 1 FROM admin.portal_record_export) THEN
    RAISE EXCEPTION 'record exports exist: purge them before downgrading 0032'
      USING ERRCODE = 'P0001';
  END IF;
END $$;
ALTER TABLE admin.binary_object FORCE ROW LEVEL SECURITY;""")
    op.execute(PORTAL_FILE_0025)
    for function in FUNCTIONS:
        op.execute(f"DROP FUNCTION {function}")
    op.execute("""
DROP POLICY migrator_export_purge_read ON admin.binary_object;
DROP POLICY migrator_export_purge ON admin.binary_object;
DROP TABLE admin.portal_record_export;
""")
    op.execute(_constraints(SERVER_MADE))
