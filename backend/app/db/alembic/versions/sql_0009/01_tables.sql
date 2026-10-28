-- Generated from the models (app/db/models/admin/core.py PreRegistration) for
-- migration 0009 (D96, A51). Frozen: schema changes are new revisions.

CREATE TABLE admin.pre_registration (
	idempotency_key UUID NOT NULL, 
	request_hash VARCHAR(64) NOT NULL, 
	details JSONB NOT NULL, 
	contact_consent BOOLEAN NOT NULL, 
	entry_source VARCHAR(40) DEFAULT 'patient-reported' NOT NULL, 
	status VARCHAR(40) DEFAULT 'pending' NOT NULL, 
	decided_at TIMESTAMP WITH TIME ZONE, 
	decided_by_user_id UUID, 
	patient_id UUID, 
	id_document_type VARCHAR(40), 
	rejection_reason_code VARCHAR(40), 
	rejection_reason_text VARCHAR(500), 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_pre_registration PRIMARY KEY (id), 
	CONSTRAINT uq_pre_registration_tenant_id_idempotency_key UNIQUE (tenant_id, idempotency_key), 
	CONSTRAINT ck_pre_registration_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'), 
	CONSTRAINT ck_pre_registration_details_shape CHECK (jsonb_typeof(details) = 'object' AND details -> 'name' IS NOT NULL AND details -> 'birthDate' IS NOT NULL AND (details -> 'phones' IS NOT NULL OR details -> 'email' IS NOT NULL)), 
	CONSTRAINT ck_pre_registration_details_size CHECK (octet_length(details::text) <= 32768), 
	CONSTRAINT ck_pre_registration_patient_reported CHECK (entry_source = 'patient-reported'), 
	CONSTRAINT ck_pre_registration_decision_matches_status CHECK ((status = 'pending' AND decided_at IS NULL AND decided_by_user_id IS NULL AND patient_id IS NULL AND id_document_type IS NULL AND rejection_reason_code IS NULL AND rejection_reason_text IS NULL) OR (status = 'accepted' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL AND patient_id IS NOT NULL AND id_document_type IS NOT NULL AND rejection_reason_code IS NULL AND rejection_reason_text IS NULL) OR (status = 'rejected' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL AND patient_id IS NULL AND id_document_type IS NULL AND rejection_reason_code IS NOT NULL)), 
	CONSTRAINT ck_pre_registration_other_reason_has_text CHECK (rejection_reason_code IS DISTINCT FROM 'other' OR coalesce(length(trim(rejection_reason_text)), 0) > 0), 
	CONSTRAINT fk_pre_registration_decided_by_user_id_app_user FOREIGN KEY(decided_by_user_id) REFERENCES admin.app_user (id), 
	CONSTRAINT fk_pre_registration_patient_id_patient FOREIGN KEY(patient_id) REFERENCES clinical.patient (id), 
	CONSTRAINT fk_pre_registration_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_pre_registration_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_pre_registration_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT ck_pre_registration_entry_source_codes CHECK (entry_source IN ('clinician', 'imported', 'patient-reported', 'ai-generated', 'device', 'interface')), 
	CONSTRAINT ck_pre_registration_status_codes CHECK (status IN ('pending', 'accepted', 'rejected')), 
	CONSTRAINT ck_pre_registration_id_document_type_codes CHECK (id_document_type IN ('drivers-license', 'state-id', 'passport', 'military-id', 'other')), 
	CONSTRAINT ck_pre_registration_rejection_reason_code_codes CHECK (rejection_reason_code IN ('duplicate', 'incomplete', 'not-our-practice', 'spam', 'other'))
);

CREATE INDEX ix_pre_registration_patient_id ON admin.pre_registration (patient_id);
CREATE INDEX ix_pre_registration_queue ON admin.pre_registration (tenant_id, status, created_at);
CREATE INDEX ix_pre_registration_tenant_id ON admin.pre_registration (tenant_id);

-- Clinic-carrying foreign keys (app/db/constraints.py).
ALTER TABLE admin.pre_registration ADD CONSTRAINT fk_pre_registration_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
