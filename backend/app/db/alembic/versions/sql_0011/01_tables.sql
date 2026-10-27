-- Generated from the models (app/db/models/admin/portal.py) for
-- migration 0011 (ADR-0013, D92, D94). Frozen: schema changes are new revisions.

CREATE TABLE admin.portal_invitation (
	patient_id UUID NOT NULL, 
	code_hmac VARCHAR(64) NOT NULL, 
	issued_by_user_id UUID NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	used_at TIMESTAMP WITH TIME ZONE, 
	revoked_at TIMESTAMP WITH TIME ZONE, 
	failed_tries SMALLINT DEFAULT 0 NOT NULL, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_portal_invitation PRIMARY KEY (id), 
	CONSTRAINT ck_portal_invitation_code_hmac_format CHECK (code_hmac ~ '^[0-9a-f]{64}$'), 
	CONSTRAINT ck_portal_invitation_expires_after_issue CHECK (expires_at > created_at), 
	CONSTRAINT ck_portal_invitation_failed_tries_range CHECK (failed_tries BETWEEN 0 AND 5), 
	CONSTRAINT ck_portal_invitation_used_or_revoked CHECK (used_at IS NULL OR revoked_at IS NULL), 
	CONSTRAINT fk_portal_invitation_patient_id_patient FOREIGN KEY(patient_id) REFERENCES clinical.patient (id), 
	CONSTRAINT fk_portal_invitation_issued_by_user_id_app_user FOREIGN KEY(issued_by_user_id) REFERENCES admin.app_user (id), 
	CONSTRAINT fk_portal_invitation_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_portal_invitation_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_portal_invitation_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL
);

CREATE INDEX ix_portal_invitation_tenant_id ON admin.portal_invitation (tenant_id);
CREATE UNIQUE INDEX uq_portal_invitation_code_hmac ON admin.portal_invitation (code_hmac);
CREATE UNIQUE INDEX uq_portal_invitation_one_open ON admin.portal_invitation (patient_id) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE admin.portal_account (
	keycloak_user_id VARCHAR(100) NOT NULL, 
	patient_id UUID NOT NULL, 
	status VARCHAR(40) DEFAULT 'pending-setup' NOT NULL, 
	enrolled_at TIMESTAMP WITH TIME ZONE, 
	factors_reset_at TIMESTAMP WITH TIME ZONE, 
	disabled_at TIMESTAMP WITH TIME ZONE, 
	disabled_reason VARCHAR(500), 
	status_before_suspension VARCHAR(40), 
	suspended_by_merge_id UUID, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_portal_account PRIMARY KEY (id), 
	CONSTRAINT ck_portal_account_disabled_has_time_and_reason CHECK ((status = 'disabled') = (disabled_at IS NOT NULL AND coalesce(length(trim(disabled_reason)), 0) > 0)), 
	CONSTRAINT ck_portal_account_suspended_has_origin CHECK ((status = 'suspended') = (status_before_suspension IS NOT NULL AND suspended_by_merge_id IS NOT NULL)), 
	CONSTRAINT ck_portal_account_suspended_from_live CHECK (status_before_suspension IS NULL OR status_before_suspension IN ('pending-setup', 'active')), 
	CONSTRAINT ck_portal_account_set_up_has_time CHECK (status = 'pending-setup' OR enrolled_at IS NOT NULL), 
	CONSTRAINT fk_portal_account_patient_id_patient FOREIGN KEY(patient_id) REFERENCES clinical.patient (id), 
	CONSTRAINT fk_portal_account_suspended_by_merge_id_patient_merge FOREIGN KEY(suspended_by_merge_id) REFERENCES admin.patient_merge (id), 
	CONSTRAINT fk_portal_account_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_portal_account_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_portal_account_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT ck_portal_account_status_codes CHECK (status IN ('pending-setup', 'active', 'disabled', 'suspended')), 
	CONSTRAINT ck_portal_account_status_before_suspension_codes CHECK (status_before_suspension IN ('pending-setup', 'active', 'disabled', 'suspended')), 
	CONSTRAINT uq_portal_account_tenant_id_id UNIQUE (tenant_id, id), 
	CONSTRAINT uq_portal_account_patient_id_id UNIQUE (patient_id, id)
);

CREATE INDEX ix_portal_account_tenant_id ON admin.portal_account (tenant_id);
CREATE UNIQUE INDEX uq_portal_account_keycloak_user_id ON admin.portal_account (keycloak_user_id);
CREATE UNIQUE INDEX uq_portal_account_patient ON admin.portal_account (tenant_id, patient_id);

CREATE TABLE admin.portal_session (
	account_id UUID NOT NULL, 
	patient_id UUID NOT NULL, 
	token_hash VARCHAR(64) NOT NULL, 
	keycloak_access_token_enc TEXT NOT NULL, 
	keycloak_refresh_token_enc TEXT NOT NULL, 
	keycloak_sid VARCHAR(100), 
	last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	tokens_refreshed_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	idle_expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	revoked_at TIMESTAMP WITH TIME ZONE, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_portal_session PRIMARY KEY (id), 
	CONSTRAINT ck_portal_session_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'), 
	CONSTRAINT ck_portal_session_idle_within_absolute CHECK (idle_expires_at <= expires_at), 
	CONSTRAINT ck_portal_session_tokens_encrypted CHECK (keycloak_access_token_enc ~ '^vault:v[0-9]+:' AND keycloak_refresh_token_enc ~ '^vault:v[0-9]+:'), 
	CONSTRAINT fk_portal_session_account_id_portal_account FOREIGN KEY(account_id) REFERENCES admin.portal_account (id), 
	CONSTRAINT fk_portal_session_patient_id_patient FOREIGN KEY(patient_id) REFERENCES clinical.patient (id), 
	CONSTRAINT fk_portal_session_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_portal_session_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_portal_session_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL
);

CREATE INDEX ix_portal_session_account ON admin.portal_session (tenant_id, account_id);
CREATE INDEX ix_portal_session_expires ON admin.portal_session (expires_at);
CREATE INDEX ix_portal_session_patient_id ON admin.portal_session (patient_id);
CREATE INDEX ix_portal_session_tenant_id ON admin.portal_session (tenant_id);
CREATE UNIQUE INDEX uq_portal_session_token_hash ON admin.portal_session (token_hash);

CREATE TABLE admin.consumed_logout_token (
	jti VARCHAR(255) NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	consumed_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	id UUID NOT NULL, 
	CONSTRAINT pk_consumed_logout_token PRIMARY KEY (id), 
	CONSTRAINT ck_consumed_logout_token_jti_given CHECK (length(jti) BETWEEN 1 AND 255)
);

CREATE INDEX ix_consumed_logout_token_expires ON admin.consumed_logout_token (expires_at);
CREATE UNIQUE INDEX uq_consumed_logout_token_jti ON admin.consumed_logout_token (jti);

-- Clinic-carrying foreign keys (app/db/constraints.py).
ALTER TABLE admin.portal_invitation ADD CONSTRAINT fk_portal_invitation_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
ALTER TABLE admin.portal_account ADD CONSTRAINT fk_portal_account_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
ALTER TABLE admin.portal_account ADD CONSTRAINT fk_portal_account_suspended_by_merge_id_tenant FOREIGN KEY(tenant_id, suspended_by_merge_id) REFERENCES admin.patient_merge (tenant_id, id);
ALTER TABLE admin.portal_session ADD CONSTRAINT fk_portal_session_account_id_same_patient FOREIGN KEY(patient_id, account_id) REFERENCES admin.portal_account (patient_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE admin.portal_session ADD CONSTRAINT fk_portal_session_account_id_tenant FOREIGN KEY(tenant_id, account_id) REFERENCES admin.portal_account (tenant_id, id);
ALTER TABLE admin.portal_session ADD CONSTRAINT fk_portal_session_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
