-- Changes to existing tables for the patient endpoints (A45, issue #13 follow-up d).
-- Hand-written; matches the models (fhir/directory.py Patient, fhir/workflow.py Encounter,
-- admin/core.py Facility). Frozen: schema changes are new revisions.

-- ============================================================================ clinical.patient
-- The D39 demographics with no column yet, each a contract CodedValue (system, code, display,
-- text). Patient has no FHIR element for them, so /fhir does not serve them yet. A code names
-- its system, a registered code system as for every other coded column; text alone is fine.
-- No default and no rewrite: existing patients have none of them.
ALTER TABLE clinical.patient ADD COLUMN ext_gender_identity_system VARCHAR(300);
ALTER TABLE clinical.patient ADD COLUMN ext_gender_identity_code VARCHAR(64);
ALTER TABLE clinical.patient ADD COLUMN ext_gender_identity_display VARCHAR(500);
ALTER TABLE clinical.patient ADD COLUMN ext_gender_identity_text VARCHAR(1000);
ALTER TABLE clinical.patient ADD COLUMN ext_sexual_orientation_system VARCHAR(300);
ALTER TABLE clinical.patient ADD COLUMN ext_sexual_orientation_code VARCHAR(64);
ALTER TABLE clinical.patient ADD COLUMN ext_sexual_orientation_display VARCHAR(500);
ALTER TABLE clinical.patient ADD COLUMN ext_sexual_orientation_text VARCHAR(1000);
ALTER TABLE clinical.patient ADD COLUMN ext_occupation_system VARCHAR(300);
ALTER TABLE clinical.patient ADD COLUMN ext_occupation_code VARCHAR(64);
ALTER TABLE clinical.patient ADD COLUMN ext_occupation_display VARCHAR(500);
ALTER TABLE clinical.patient ADD COLUMN ext_occupation_text VARCHAR(1000);
ALTER TABLE clinical.patient ADD COLUMN ext_industry_system VARCHAR(300);
ALTER TABLE clinical.patient ADD COLUMN ext_industry_code VARCHAR(64);
ALTER TABLE clinical.patient ADD COLUMN ext_industry_display VARCHAR(500);
ALTER TABLE clinical.patient ADD COLUMN ext_industry_text VARCHAR(1000);
ALTER TABLE clinical.patient ADD COLUMN ext_tribal_affiliation_system VARCHAR(300);
ALTER TABLE clinical.patient ADD COLUMN ext_tribal_affiliation_code VARCHAR(64);
ALTER TABLE clinical.patient ADD COLUMN ext_tribal_affiliation_display VARCHAR(500);
ALTER TABLE clinical.patient ADD COLUMN ext_tribal_affiliation_text VARCHAR(1000);
ALTER TABLE clinical.patient ADD CONSTRAINT ck_patient_gender_identity_code_has_system CHECK ((ext_gender_identity_code IS NULL) = (ext_gender_identity_system IS NULL));
ALTER TABLE clinical.patient ADD CONSTRAINT ck_patient_industry_code_has_system CHECK ((ext_industry_code IS NULL) = (ext_industry_system IS NULL));
ALTER TABLE clinical.patient ADD CONSTRAINT ck_patient_occupation_code_has_system CHECK ((ext_occupation_code IS NULL) = (ext_occupation_system IS NULL));
ALTER TABLE clinical.patient ADD CONSTRAINT ck_patient_sexual_orientation_code_has_system CHECK ((ext_sexual_orientation_code IS NULL) = (ext_sexual_orientation_system IS NULL));
ALTER TABLE clinical.patient ADD CONSTRAINT ck_patient_tribal_affiliation_code_has_system CHECK ((ext_tribal_affiliation_code IS NULL) = (ext_tribal_affiliation_system IS NULL));
ALTER TABLE clinical.patient ADD CONSTRAINT fk_patient_ext_gender_identity_system_code_system FOREIGN KEY(ext_gender_identity_system) REFERENCES admin.code_system (uri) ON UPDATE CASCADE;
ALTER TABLE clinical.patient ADD CONSTRAINT fk_patient_ext_industry_system_code_system FOREIGN KEY(ext_industry_system) REFERENCES admin.code_system (uri) ON UPDATE CASCADE;
ALTER TABLE clinical.patient ADD CONSTRAINT fk_patient_ext_occupation_system_code_system FOREIGN KEY(ext_occupation_system) REFERENCES admin.code_system (uri) ON UPDATE CASCADE;
ALTER TABLE clinical.patient ADD CONSTRAINT fk_patient_ext_sexual_orientation_system_code_system FOREIGN KEY(ext_sexual_orientation_system) REFERENCES admin.code_system (uri) ON UPDATE CASCADE;
ALTER TABLE clinical.patient ADD CONSTRAINT fk_patient_ext_tribal_affiliation_system_code_system FOREIGN KEY(ext_tribal_affiliation_system) REFERENCES admin.code_system (uri) ON UPDATE CASCADE;

-- ========================================================================== clinical.encounter
-- Self-pay, from check-in (CheckInRequest.selfPay). Existing encounters are not self-pay. A
-- constant default adds the column without a rewrite and fires no trigger.
ALTER TABLE clinical.encounter ADD COLUMN ext_self_pay BOOLEAN DEFAULT false NOT NULL;

-- ============================================================================== admin.facility
-- Every facility has its IANA time zone (D40): appointments display in facility time. A
-- facility without one takes its practice's. RLS is forced, so it applies to shri_migrator
-- too, which sees no practice's rows: three policies, for this backfill only, let it read the
-- practices and fill the facilities that have no time zone, and are dropped straight after,
-- inside this migration's transaction. An UPDATE with a WHERE checks the old and the new row
-- against the SELECT policies too, so the read policy cannot be limited to rows without a time
-- zone. The UPDATE fires the facility's version trigger, so its ETag changes with it.
CREATE POLICY migrator_0007_timezone ON admin.tenant FOR SELECT TO shri_migrator USING (true);
CREATE POLICY migrator_0007_timezone_read ON admin.facility FOR SELECT TO shri_migrator
  USING (true);
CREATE POLICY migrator_0007_timezone ON admin.facility FOR UPDATE TO shri_migrator
  USING (timezone IS NULL) WITH CHECK (timezone IS NOT NULL);
UPDATE admin.facility f SET timezone = t.timezone
  FROM admin.tenant t WHERE t.id = f.tenant_id AND f.timezone IS NULL;
DROP POLICY migrator_0007_timezone ON admin.facility;
DROP POLICY migrator_0007_timezone_read ON admin.facility;
DROP POLICY migrator_0007_timezone ON admin.tenant;
ALTER TABLE admin.facility ALTER COLUMN timezone SET NOT NULL;

-- ======================================================================== admin.tenant_setting
-- The ETag for If-Match on PATCH /practice-settings (A49), as A41 for practice setup: bumped by
-- shri_bump_version() on every UPDATE (05_triggers.sql). Existing rows start at 1; a constant
-- default adds the column without a rewrite and fires no trigger.
ALTER TABLE admin.tenant_setting ADD COLUMN version INTEGER DEFAULT 1 NOT NULL;
