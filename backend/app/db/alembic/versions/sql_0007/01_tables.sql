-- Generated from the models (app/db/models/admin/core.py MrnCounter, rcm.py Employer) for
-- migration 0007 (A45). Frozen: schema changes are new revisions.

CREATE TABLE admin.mrn_counter (
	prefix VARCHAR(10) NOT NULL, 
	system VARCHAR(300) NOT NULL, 
	next_value BIGINT DEFAULT 1 NOT NULL, 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_mrn_counter PRIMARY KEY (id), 
	CONSTRAINT uq_mrn_counter_tenant_id UNIQUE (tenant_id), 
	CONSTRAINT ck_mrn_counter_prefix_format CHECK (prefix ~ '^[A-Z0-9]{1,10}$'), 
	CONSTRAINT ck_mrn_counter_system_uri CHECK (system ~ '^(urn:|https?://)'), 
	CONSTRAINT ck_mrn_counter_next_value_positive CHECK (next_value >= 1), 
	CONSTRAINT fk_mrn_counter_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_mrn_counter_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_mrn_counter_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL
);

CREATE INDEX ix_mrn_counter_tenant_id ON admin.mrn_counter (tenant_id);

CREATE TABLE admin.employer (
	patient_id UUID, 
	related_person_id UUID, 
	name VARCHAR(200) NOT NULL, 
	phone VARCHAR(16), 
	address_lines VARCHAR(100)[], 
	address_city VARCHAR(60), 
	address_state VARCHAR(2), 
	address_postal_code VARCHAR(10), 
	address_country VARCHAR(2), 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	created_by_user_id UUID, 
	updated_by_user_id UUID, 
	CONSTRAINT pk_employer PRIMARY KEY (id), 
	CONSTRAINT ck_employer_one_person CHECK (num_nonnulls(patient_id, related_person_id) = 1), 
	CONSTRAINT uq_employer_patient_id UNIQUE (patient_id), 
	CONSTRAINT uq_employer_related_person_id UNIQUE (related_person_id), 
	CONSTRAINT ck_employer_name_given CHECK (length(trim(name)) >= 1), 
	CONSTRAINT ck_employer_phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'), 
	CONSTRAINT ck_employer_address_whole CHECK (num_nonnulls(address_lines, address_city, address_state, address_postal_code, address_country) IN (0, 5)), 
	CONSTRAINT ck_employer_address_lines_count CHECK (address_lines IS NULL OR cardinality(address_lines) BETWEEN 1 AND 3), 
	CONSTRAINT ck_employer_address_state_format CHECK (address_state IS NULL OR address_state ~ '^[A-Z]{2}$'), 
	CONSTRAINT ck_employer_address_postal_code_format CHECK (address_postal_code IS NULL OR address_postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'), 
	CONSTRAINT ck_employer_address_country_us CHECK (address_country IS NULL OR address_country = 'US'), 
	CONSTRAINT fk_employer_patient_id_patient FOREIGN KEY(patient_id) REFERENCES clinical.patient (id) ON DELETE CASCADE, 
	CONSTRAINT fk_employer_related_person_id_related_person FOREIGN KEY(related_person_id) REFERENCES clinical.related_person (id) ON DELETE CASCADE, 
	CONSTRAINT fk_employer_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT fk_employer_created_by_user_id_app_user FOREIGN KEY(created_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL, 
	CONSTRAINT fk_employer_updated_by_user_id_app_user FOREIGN KEY(updated_by_user_id) REFERENCES admin.app_user (id) ON DELETE SET NULL
);

CREATE INDEX ix_employer_tenant_id ON admin.employer (tenant_id);

-- Clinic-carrying and same-patient foreign keys (app/db/constraints.py).
ALTER TABLE admin.employer ADD CONSTRAINT fk_employer_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
ALTER TABLE admin.employer ADD CONSTRAINT fk_employer_related_person_id_same_patient FOREIGN KEY(patient_id, related_person_id) REFERENCES clinical.related_person (patient_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE admin.employer ADD CONSTRAINT fk_employer_related_person_id_tenant FOREIGN KEY(tenant_id, related_person_id) REFERENCES clinical.related_person (tenant_id, id);
