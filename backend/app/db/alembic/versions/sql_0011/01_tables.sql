-- Generated from the models (app/db/models/admin/portal.py) for migration 0011
-- (ADR-0013, D90-D94). Frozen: schema changes are new revisions.

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

CREATE TABLE admin.portal_change_request (
	patient_id UUID NOT NULL, 
	changes JSONB NOT NULL, 
	note VARCHAR(500), 
	status VARCHAR(40) DEFAULT 'pending' NOT NULL, 
	decided_at TIMESTAMP WITH TIME ZONE, 
	decided_by_user_id UUID, 
	decision_note VARCHAR(500), 
	work_item_id UUID, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_portal_change_request PRIMARY KEY (id), 
	CONSTRAINT ck_portal_change_request_changes_given CHECK (jsonb_typeof(changes) = 'object' AND changes <> '{}'::jsonb), 
	CONSTRAINT ck_portal_change_request_changes_size CHECK (octet_length(changes::text) <= 16384), 
	CONSTRAINT ck_portal_change_request_decision_matches_status CHECK ((status = 'pending') = (decided_at IS NULL AND decided_by_user_id IS NULL)), 
	CONSTRAINT ck_portal_change_request_decision_note_not_blank CHECK (status = 'pending' OR decision_note IS NULL OR length(trim(decision_note)) > 0), 
	CONSTRAINT fk_portal_change_request_patient_id_patient FOREIGN KEY(patient_id) REFERENCES clinical.patient (id), 
	CONSTRAINT fk_portal_change_request_decided_by_user_id_app_user FOREIGN KEY(decided_by_user_id) REFERENCES admin.app_user (id), 
	CONSTRAINT fk_portal_change_request_work_item_id_work_item FOREIGN KEY(work_item_id) REFERENCES admin.work_item (id), 
	CONSTRAINT fk_portal_change_request_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_portal_change_request_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_portal_change_request_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT ck_portal_change_request_status_codes CHECK (status IN ('pending', 'accepted', 'declined'))
);

CREATE INDEX ix_portal_change_request_patient_id ON admin.portal_change_request (patient_id);
CREATE INDEX ix_portal_change_request_queue ON admin.portal_change_request (tenant_id, status, created_at);
CREATE INDEX ix_portal_change_request_tenant_id ON admin.portal_change_request (tenant_id);

CREATE TABLE admin.online_booking_setting (
	is_enabled BOOLEAN DEFAULT false NOT NULL, 
	booking_window_days SMALLINT DEFAULT 60 NOT NULL, 
	min_notice_minutes INTEGER DEFAULT 120 NOT NULL, 
	cancel_cutoff_hours SMALLINT DEFAULT 24 NOT NULL, 
	reschedule_cutoff_hours SMALLINT DEFAULT 24 NOT NULL, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	version INTEGER DEFAULT 1 NOT NULL, 
	CONSTRAINT pk_online_booking_setting PRIMARY KEY (id), 
	CONSTRAINT uq_online_booking_setting_tenant_id UNIQUE (tenant_id), 
	CONSTRAINT ck_online_booking_setting_window_range CHECK (booking_window_days BETWEEN 1 AND 365), 
	CONSTRAINT ck_online_booking_setting_notice_range CHECK (min_notice_minutes BETWEEN 0 AND 20160), 
	CONSTRAINT ck_online_booking_setting_cutoff_range CHECK (cancel_cutoff_hours BETWEEN 0 AND 336 AND reschedule_cutoff_hours BETWEEN 0 AND 336), 
	CONSTRAINT fk_online_booking_setting_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_online_booking_setting_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_online_booking_setting_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL
);

CREATE INDEX ix_online_booking_setting_tenant_id ON admin.online_booking_setting (tenant_id);

CREATE TABLE admin.online_bookable_type (
	facility_id UUID NOT NULL, 
	appointment_type_id UUID NOT NULL, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_online_bookable_type PRIMARY KEY (id), 
	CONSTRAINT uq_online_bookable_type_facility_id_appointment_type_id UNIQUE (facility_id, appointment_type_id), 
	CONSTRAINT fk_online_bookable_type_facility_id_facility FOREIGN KEY(facility_id) REFERENCES admin.facility (id), 
	CONSTRAINT fk_online_bookable_type_appointment_type_id_appointment_type FOREIGN KEY(appointment_type_id) REFERENCES admin.appointment_type (id), 
	CONSTRAINT fk_online_bookable_type_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_online_bookable_type_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_online_bookable_type_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL
);

CREATE INDEX ix_online_bookable_type_tenant_id ON admin.online_bookable_type (tenant_id);

CREATE TABLE admin.release_hold (
	patient_id UUID NOT NULL, 
	document_reference_id UUID, 
	diagnostic_report_id UUID, 
	condition_id UUID, 
	reason VARCHAR(40) NOT NULL, 
	held_by_user_id UUID NOT NULL, 
	held_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	lifted_at TIMESTAMP WITH TIME ZONE, 
	lifted_by_user_id UUID, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_release_hold PRIMARY KEY (id), 
	CONSTRAINT ck_release_hold_one_item CHECK (num_nonnulls(document_reference_id, diagnostic_report_id, condition_id) = 1), 
	CONSTRAINT ck_release_hold_lifted_by_whom CHECK ((lifted_at IS NULL) = (lifted_by_user_id IS NULL)), 
	CONSTRAINT ck_release_hold_lifted_after_held CHECK (lifted_at IS NULL OR lifted_at >= held_at), 
	CONSTRAINT fk_release_hold_patient_id_patient FOREIGN KEY(patient_id) REFERENCES clinical.patient (id), 
	CONSTRAINT fk_release_hold_document_reference_id_document_reference FOREIGN KEY(document_reference_id) REFERENCES clinical.document_reference (id), 
	CONSTRAINT fk_release_hold_diagnostic_report_id_diagnostic_report FOREIGN KEY(diagnostic_report_id) REFERENCES clinical.diagnostic_report (id), 
	CONSTRAINT fk_release_hold_condition_id_condition FOREIGN KEY(condition_id) REFERENCES clinical.condition (id), 
	CONSTRAINT fk_release_hold_held_by_user_id_app_user FOREIGN KEY(held_by_user_id) REFERENCES admin.app_user (id), 
	CONSTRAINT fk_release_hold_lifted_by_user_id_app_user FOREIGN KEY(lifted_by_user_id) REFERENCES admin.app_user (id), 
	CONSTRAINT fk_release_hold_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_release_hold_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_release_hold_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT ck_release_hold_reason_codes CHECK (reason IN ('risk-of-harm', 'patient-request'))
);

CREATE INDEX ix_release_hold_patient_id ON admin.release_hold (patient_id);
CREATE INDEX ix_release_hold_tenant_id ON admin.release_hold (tenant_id);
CREATE UNIQUE INDEX uq_release_hold_one_active_condition ON admin.release_hold (condition_id) WHERE lifted_at IS NULL AND condition_id IS NOT NULL;
CREATE UNIQUE INDEX uq_release_hold_one_active_document ON admin.release_hold (document_reference_id) WHERE lifted_at IS NULL AND document_reference_id IS NOT NULL;
CREATE UNIQUE INDEX uq_release_hold_one_active_report ON admin.release_hold (diagnostic_report_id) WHERE lifted_at IS NULL AND diagnostic_report_id IS NOT NULL;

-- Clinic-carrying and same-patient foreign keys (app/db/constraints.py).
ALTER TABLE admin.portal_invitation ADD CONSTRAINT fk_portal_invitation_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
ALTER TABLE admin.portal_account ADD CONSTRAINT fk_portal_account_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
ALTER TABLE admin.portal_account ADD CONSTRAINT fk_portal_account_suspended_by_merge_id_tenant FOREIGN KEY(tenant_id, suspended_by_merge_id) REFERENCES admin.patient_merge (tenant_id, id);
ALTER TABLE admin.portal_session ADD CONSTRAINT fk_portal_session_account_id_same_patient FOREIGN KEY(patient_id, account_id) REFERENCES admin.portal_account (patient_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE admin.portal_session ADD CONSTRAINT fk_portal_session_account_id_tenant FOREIGN KEY(tenant_id, account_id) REFERENCES admin.portal_account (tenant_id, id);
ALTER TABLE admin.portal_session ADD CONSTRAINT fk_portal_session_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
ALTER TABLE admin.portal_change_request ADD CONSTRAINT fk_portal_change_request_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
ALTER TABLE admin.portal_change_request ADD CONSTRAINT fk_portal_change_request_work_item_id_same_patient FOREIGN KEY(patient_id, work_item_id) REFERENCES admin.work_item (patient_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE admin.portal_change_request ADD CONSTRAINT fk_portal_change_request_work_item_id_tenant FOREIGN KEY(tenant_id, work_item_id) REFERENCES admin.work_item (tenant_id, id);
ALTER TABLE admin.online_bookable_type ADD CONSTRAINT fk_online_bookable_type_appointment_type_id_tenant FOREIGN KEY(tenant_id, appointment_type_id) REFERENCES admin.appointment_type (tenant_id, id);
ALTER TABLE admin.online_bookable_type ADD CONSTRAINT fk_online_bookable_type_facility_id_tenant FOREIGN KEY(tenant_id, facility_id) REFERENCES admin.facility (tenant_id, id);
ALTER TABLE admin.release_hold ADD CONSTRAINT fk_release_hold_condition_id_same_patient FOREIGN KEY(patient_id, condition_id) REFERENCES clinical.condition (subject_patient_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE admin.release_hold ADD CONSTRAINT fk_release_hold_condition_id_tenant FOREIGN KEY(tenant_id, condition_id) REFERENCES clinical.condition (tenant_id, id);
ALTER TABLE admin.release_hold ADD CONSTRAINT fk_release_hold_diagnostic_report_id_same_patient FOREIGN KEY(patient_id, diagnostic_report_id) REFERENCES clinical.diagnostic_report (subject_patient_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE admin.release_hold ADD CONSTRAINT fk_release_hold_diagnostic_report_id_tenant FOREIGN KEY(tenant_id, diagnostic_report_id) REFERENCES clinical.diagnostic_report (tenant_id, id);
ALTER TABLE admin.release_hold ADD CONSTRAINT fk_release_hold_document_reference_id_same_patient FOREIGN KEY(patient_id, document_reference_id) REFERENCES clinical.document_reference (subject_patient_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE admin.release_hold ADD CONSTRAINT fk_release_hold_document_reference_id_tenant FOREIGN KEY(tenant_id, document_reference_id) REFERENCES clinical.document_reference (tenant_id, id);
ALTER TABLE admin.release_hold ADD CONSTRAINT fk_release_hold_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
