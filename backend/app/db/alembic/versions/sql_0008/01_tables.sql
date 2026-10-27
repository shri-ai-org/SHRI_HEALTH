-- Generated from the models (app/db/models/admin/practice.py ConsentRequirement) for
-- migration 0008 (A43). Frozen: schema changes are new revisions.

CREATE TABLE admin.consent_requirement (
	kind VARCHAR(40) NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	policy_version VARCHAR(40) NOT NULL, 
	is_required BOOLEAN NOT NULL, 
	form_file_id UUID, 
	effective_date DATE NOT NULL, 
	is_active BOOLEAN DEFAULT true NOT NULL, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	version INTEGER DEFAULT 1 NOT NULL, 
	CONSTRAINT pk_consent_requirement PRIMARY KEY (id), 
	CONSTRAINT uq_consent_requirement_tenant_id_kind_policy_version UNIQUE (tenant_id, kind, policy_version), 
	CONSTRAINT ck_consent_requirement_title_given CHECK (length(trim(title)) >= 1), 
	CONSTRAINT ck_consent_requirement_policy_version_given CHECK (length(trim(policy_version)) >= 1), 
	CONSTRAINT fk_consent_requirement_form_file_id_binary_object FOREIGN KEY(form_file_id) REFERENCES admin.binary_object (id), 
	CONSTRAINT fk_consent_requirement_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_consent_requirement_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_consent_requirement_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT ck_consent_requirement_kind_codes CHECK (kind IN ('treatment', 'privacy-notice', 'ambient-recording', 'telehealth', 'research', 'information-sharing', 'financial'))
);

CREATE INDEX ix_consent_requirement_tenant_id ON admin.consent_requirement (tenant_id);

-- Clinic-carrying foreign keys (app/db/constraints.py).
ALTER TABLE admin.consent_requirement ADD CONSTRAINT fk_consent_requirement_form_file_id_tenant FOREIGN KEY(tenant_id, form_file_id) REFERENCES admin.binary_object (tenant_id, id);
