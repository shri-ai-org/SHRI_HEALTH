-- Generated from the models (app/db/models/fhir/workflow.py EncounterFollowUp) for
-- migration 0010 (D98, A52). Frozen: schema changes are new revisions.

CREATE TABLE clinical.encounter_follow_up (
	encounter_id UUID NOT NULL, 
	patient_id UUID NOT NULL, 
	interval_value INTEGER NOT NULL, 
	interval_unit VARCHAR(40) NOT NULL, 
	appointment_type_id UUID, 
	practitioner_id UUID, 
	note VARCHAR(500), 
	status VARCHAR(40) DEFAULT 'open' NOT NULL, 
	requested_by_user_id UUID NOT NULL, 
	requested_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	booked_appointment_id UUID, 
	status_reason VARCHAR(500), 
	id UUID NOT NULL, 
	tenant_id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	CONSTRAINT pk_encounter_follow_up PRIMARY KEY (id), 
	CONSTRAINT uq_encounter_follow_up_encounter_id UNIQUE (encounter_id), 
	CONSTRAINT uq_encounter_follow_up_booked_appointment_id UNIQUE (booked_appointment_id), 
	CONSTRAINT ck_encounter_follow_up_interval_range CHECK (interval_value BETWEEN 1 AND 365), 
	CONSTRAINT ck_encounter_follow_up_booked_has_appointment CHECK ((status = 'booked') = (booked_appointment_id IS NOT NULL)), 
	CONSTRAINT ck_encounter_follow_up_reason_matches_status CHECK (CASE WHEN status IN ('declined', 'withdrawn') THEN coalesce(length(trim(status_reason)), 0) > 0 ELSE status_reason IS NULL END), 
	CONSTRAINT fk_encounter_follow_up_encounter_id_encounter FOREIGN KEY(encounter_id) REFERENCES clinical.encounter (id) ON DELETE CASCADE, 
	CONSTRAINT fk_encounter_follow_up_patient_id_patient FOREIGN KEY(patient_id) REFERENCES clinical.patient (id), 
	CONSTRAINT fk_encounter_follow_up_appointment_type_id_appointment_type FOREIGN KEY(appointment_type_id) REFERENCES admin.appointment_type (id), 
	CONSTRAINT fk_encounter_follow_up_practitioner_id_practitioner FOREIGN KEY(practitioner_id) REFERENCES clinical.practitioner (id), 
	CONSTRAINT fk_encounter_follow_up_requested_by_user_id_app_user FOREIGN KEY(requested_by_user_id) REFERENCES admin.app_user (id), 
	CONSTRAINT fk_encounter_follow_up_booked_appointment_id_appointment FOREIGN KEY(booked_appointment_id) REFERENCES clinical.appointment (id), 
	CONSTRAINT fk_encounter_follow_up_tenant_id_tenant FOREIGN KEY(tenant_id) REFERENCES admin.tenant (id) ON DELETE RESTRICT, 
	CONSTRAINT ck_encounter_follow_up_interval_unit_codes CHECK (interval_unit IN ('day', 'week', 'month')), 
	CONSTRAINT ck_encounter_follow_up_status_codes CHECK (status IN ('open', 'booked', 'declined', 'withdrawn'))
);

CREATE INDEX ix_encounter_follow_up_encounter_id ON clinical.encounter_follow_up (encounter_id);
CREATE INDEX ix_encounter_follow_up_patient_id ON clinical.encounter_follow_up (patient_id);
CREATE INDEX ix_encounter_follow_up_tenant_id ON clinical.encounter_follow_up (tenant_id);

-- Clinic-carrying and same-patient foreign keys (app/db/constraints.py).
ALTER TABLE clinical.encounter_follow_up ADD CONSTRAINT fk_encounter_follow_up_appointment_type_id_tenant FOREIGN KEY(tenant_id, appointment_type_id) REFERENCES admin.appointment_type (tenant_id, id);
ALTER TABLE clinical.encounter_follow_up ADD CONSTRAINT fk_encounter_follow_up_booked_appointment_id_same_patient FOREIGN KEY(patient_id, booked_appointment_id) REFERENCES clinical.appointment (subject_patient_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE clinical.encounter_follow_up ADD CONSTRAINT fk_encounter_follow_up_booked_appointment_id_tenant FOREIGN KEY(tenant_id, booked_appointment_id) REFERENCES clinical.appointment (tenant_id, id);
ALTER TABLE clinical.encounter_follow_up ADD CONSTRAINT fk_encounter_follow_up_encounter_id_same_patient FOREIGN KEY(patient_id, encounter_id) REFERENCES clinical.encounter (subject_patient_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE clinical.encounter_follow_up ADD CONSTRAINT fk_encounter_follow_up_encounter_id_tenant FOREIGN KEY(tenant_id, encounter_id) REFERENCES clinical.encounter (tenant_id, id);
ALTER TABLE clinical.encounter_follow_up ADD CONSTRAINT fk_encounter_follow_up_patient_id_tenant FOREIGN KEY(tenant_id, patient_id) REFERENCES clinical.patient (tenant_id, id);
ALTER TABLE clinical.encounter_follow_up ADD CONSTRAINT fk_encounter_follow_up_practitioner_id_tenant FOREIGN KEY(tenant_id, practitioner_id) REFERENCES clinical.practitioner (tenant_id, id);
