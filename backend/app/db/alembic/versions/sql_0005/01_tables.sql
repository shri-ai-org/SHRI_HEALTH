-- Generated from the models (app/db/models/admin/runtime.py) for migration 0005: Thulasi's
-- core runtime tables (issue #13, follow-up a). Frozen: schema changes are new revisions.

CREATE TABLE admin.app_session (
	user_id UUID NOT NULL, 
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
	CONSTRAINT pk_app_session PRIMARY KEY (id), 
	CONSTRAINT uq_app_session_token_hash UNIQUE (token_hash), 
	CONSTRAINT ck_app_session_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'), 
	CONSTRAINT ck_app_session_idle_within_absolute CHECK (idle_expires_at <= expires_at), 
	CONSTRAINT ck_app_session_tokens_encrypted CHECK (keycloak_access_token_enc ~ '^vault:v[0-9]+:' AND keycloak_refresh_token_enc ~ '^vault:v[0-9]+:'), 
	CONSTRAINT fk_app_session_user_id_app_user FOREIGN KEY(user_id) REFERENCES admin.app_user (id), 
	CONSTRAINT fk_app_session_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_app_session_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_app_session_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL
);

CREATE INDEX ix_app_session_expires ON admin.app_session (expires_at);
CREATE INDEX ix_app_session_keycloak_sid ON admin.app_session (keycloak_sid);
CREATE INDEX ix_app_session_tenant_id ON admin.app_session (tenant_id);
CREATE INDEX ix_app_session_user ON admin.app_session (tenant_id, user_id);

CREATE TABLE admin.idempotency_record (
	user_id UUID NOT NULL, 
	method VARCHAR(10) NOT NULL, 
	path VARCHAR(500) NOT NULL, 
	key VARCHAR(255) NOT NULL, 
	request_hash VARCHAR(64) NOT NULL, 
	state VARCHAR(40) NOT NULL, 
	response_status SMALLINT, 
	response_headers JSONB, 
	response_body_enc TEXT, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_idempotency_record PRIMARY KEY (id), 
	CONSTRAINT uq_idempotency_record_tenant_id_user_id_method_path_key UNIQUE (tenant_id, user_id, method, path, key), 
	CONSTRAINT ck_idempotency_record_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'), 
	CONSTRAINT ck_idempotency_record_unsafe_method CHECK (method IN ('POST', 'PUT', 'PATCH')), 
	CONSTRAINT ck_idempotency_record_done_has_response CHECK (state <> 'done' OR response_status IS NOT NULL), 
	CONSTRAINT ck_idempotency_record_stored_status CHECK (response_status IS NULL OR (response_status BETWEEN 200 AND 499 AND response_status <> 429)), 
	CONSTRAINT ck_idempotency_record_response_body_encrypted CHECK (response_body_enc IS NULL OR response_body_enc ~ '^vault:v[0-9]+:'), 
	CONSTRAINT fk_idempotency_record_user_id_app_user FOREIGN KEY(user_id) REFERENCES admin.app_user (id), 
	CONSTRAINT fk_idempotency_record_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_idempotency_record_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_idempotency_record_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT ck_idempotency_record_state_codes CHECK (state IN ('in-progress', 'done'))
);

CREATE INDEX ix_idempotency_record_expires ON admin.idempotency_record (expires_at);
CREATE INDEX ix_idempotency_record_tenant_id ON admin.idempotency_record (tenant_id);

CREATE TABLE admin.operation (
	created_by_user_id UUID NOT NULL, 
	kind VARCHAR(64) NOT NULL, 
	status VARCHAR(40) NOT NULL, 
	result_type VARCHAR(64), 
	result_id UUID, 
	error JSONB, 
	completed_at TIMESTAMP WITH TIME ZONE, 
	assigned_to_integration BOOLEAN DEFAULT false NOT NULL, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_operation PRIMARY KEY (id), 
	CONSTRAINT ck_operation_completed_when_final CHECK ((completed_at IS NOT NULL) = (status IN ('succeeded', 'failed', 'cancelled'))), 
	CONSTRAINT ck_operation_failure_has_error CHECK (status <> 'failed' OR error IS NOT NULL), 
	CONSTRAINT ck_operation_result_pair CHECK ((result_type IS NULL) = (result_id IS NULL)), 
	CONSTRAINT fk_operation_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_operation_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_operation_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT ck_operation_status_codes CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

CREATE INDEX ix_operation_created ON admin.operation (created_at);
CREATE INDEX ix_operation_creator ON admin.operation (tenant_id, created_by_user_id, created_at);
CREATE INDEX ix_operation_tenant_id ON admin.operation (tenant_id);

CREATE TABLE admin.event_log (
	seq BIGINT GENERATED ALWAYS AS IDENTITY, 
	facility_id UUID, 
	patient_id UUID, 
	target_user_id UUID, 
	target_role_code TEXT, 
	type VARCHAR(100) NOT NULL, 
	subject VARCHAR(200) NOT NULL, 
	data JSONB DEFAULT '{}'::jsonb NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	CONSTRAINT pk_event_log PRIMARY KEY (id), 
	CONSTRAINT ck_event_log_target_role_code_format CHECK (target_role_code ~ '^[A-Z]{2,10}$'), 
	CONSTRAINT uq_event_log_seq UNIQUE (seq), 
	CONSTRAINT fk_event_log_facility_id_facility FOREIGN KEY(facility_id) REFERENCES admin.facility (id), 
	CONSTRAINT fk_event_log_patient_id_patient FOREIGN KEY(patient_id) REFERENCES clinical.patient (id), 
	CONSTRAINT fk_event_log_target_user_id_app_user FOREIGN KEY(target_user_id) REFERENCES admin.app_user (id), 
	CONSTRAINT fk_event_log_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT
);

CREATE INDEX ix_event_log_created ON admin.event_log (created_at);
CREATE INDEX ix_event_log_replay ON admin.event_log (tenant_id, seq);
CREATE INDEX ix_event_log_tenant_id ON admin.event_log (tenant_id);

-- Clinic-carrying foreign keys (app/db/constraints.py).
ALTER TABLE admin.event_log ADD CONSTRAINT fk_event_log_facility_id_tenant FOREIGN KEY(tenant_id, facility_id) REFERENCES admin.facility (tenant_id, id);
ALTER TABLE admin.event_log ADD CONSTRAINT fk_event_log_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
