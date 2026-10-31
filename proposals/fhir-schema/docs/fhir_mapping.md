# FHIR resource mapping

One table per FHIR R4 resource; repeating elements are child tables. FHIR invariants and datatype rules are CHECK constraints named `ck_<table>_fhir_*`.

| Resource | Table | Child tables | FHIR CHECKs |
|---|---|---|---|
| AllergyIntolerance | `allergy_intolerance` | 3 | 11 |
| Appointment | `appointment` | 2 | 11 |
| Composition | `composition` | 4 | 5 |
| Condition | `condition` | 4 | 17 |
| Consent | `consent` | 3 | 7 |
| Coverage | `coverage` | 5 | 5 |
| DetectedIssue | `detected_issue` | 2 | 2 |
| DiagnosticReport | `diagnostic_report` | 7 | 5 |
| DocumentReference | `document_reference` | 5 | 6 |
| Encounter | `encounter` | 7 | 5 |
| FamilyMemberHistory | `family_member_history` | 2 | 18 |
| Immunization | `immunization` | 1 | 13 |
| Location | `location` | 3 | 4 |
| Medication | `medication` | 1 | 5 |
| MedicationDispense | `medication_dispense` | 1 | 6 |
| MedicationRequest | `medication_request` | 3 | 14 |
| MedicationStatement | `medication_statement` | 3 | 10 |
| Observation | `observation` | 8 | 18 |
| Organization | `organization` | 3 | 2 |
| Patient | `patient` | 9 | 4 |
| Practitioner | `practitioner` | 5 | 0 |
| PractitionerRole | `practitioner_role` | 3 | 3 |
| Procedure | `procedure` | 5 | 15 |
| Provenance | `provenance` | 3 | 4 |
| RelatedPerson | `related_person` | 5 | 1 |
| Schedule | `schedule` | 1 | 7 |
| ServiceRequest | `service_request` | 7 | 10 |
| Specimen | `specimen` | 1 | 11 |

## AllergyIntolerance → `allergy_intolerance`

US Core AllergyIntolerance. 'No known allergies' is code SNOMED 716186003.

- `allergy_intolerance_coding`
- `allergy_intolerance_reaction`
  - `allergy_reaction_manifestation`
- `annotation` (shared datatype table)

Invariants / datatype rules: `ck_allergy_intolerance_fhir_ait_1`, `ck_allergy_intolerance_fhir_ait_2`, `ck_allergy_intolerance_fhir_asserter_arc`, `ck_allergy_intolerance_fhir_code_coding`, `ck_allergy_intolerance_fhir_code_display`, `ck_allergy_intolerance_fhir_code_required`, `ck_allergy_intolerance_fhir_onset_age_comparator`, `ck_allergy_intolerance_fhir_onset_age_qty_3`, `ck_allergy_intolerance_fhir_onset_period_per_1`, `ck_allergy_intolerance_fhir_onset_x`, `ck_allergy_intolerance_fhir_recorder_arc`

## Appointment → `appointment`

FHIR Appointment. ``subject_patient_id`` backports R5 Appointment.subject so patient consistency can be enforced with foreign keys; the patient is also a participant.

- `appointment_participant`
- `appointment_reason`

Invariants / datatype rules: `ck_appointment_fhir_app_2`, `ck_appointment_fhir_app_3`, `ck_appointment_fhir_app_4`, `ck_appointment_fhir_appointment_type_coding`, `ck_appointment_fhir_appointment_type_display`, `ck_appointment_fhir_cancelation_reason_coding`, `ck_appointment_fhir_cancelation_reason_display`, `ck_appointment_fhir_service_category_coding`, `ck_appointment_fhir_service_category_display`, `ck_appointment_fhir_service_type_coding`, `ck_appointment_fhir_service_type_display`

## Composition → `composition`

A clinical note (progress note, H&P, after-visit summary ...).

- `composition_attester`
- `composition_author`
- `composition_relates_to`
- `composition_section`
  - `composition_section_entry`

Invariants / datatype rules: `ck_composition_fhir_category_coding`, `ck_composition_fhir_category_display`, `ck_composition_fhir_type_coding`, `ck_composition_fhir_type_display`, `ck_composition_fhir_type_required`

## Condition → `condition`

US Core Condition (problem list, encounter diagnosis, health concern).

- `annotation` (shared datatype table)
- `condition_body_site`
- `condition_category`
- `condition_coding`

Invariants / datatype rules: `ck_condition_fhir_abatement_age_comparator`, `ck_condition_fhir_abatement_age_qty_3`, `ck_condition_fhir_abatement_period_per_1`, `ck_condition_fhir_abatement_x`, `ck_condition_fhir_asserter_arc`, `ck_condition_fhir_code_coding`, `ck_condition_fhir_code_display`, `ck_condition_fhir_code_required`, `ck_condition_fhir_con_4`, `ck_condition_fhir_con_5`, `ck_condition_fhir_onset_age_comparator`, `ck_condition_fhir_onset_age_qty_3`, `ck_condition_fhir_onset_period_per_1`, `ck_condition_fhir_onset_x`, `ck_condition_fhir_recorder_arc`, `ck_condition_fhir_severity_coding`, `ck_condition_fhir_severity_display`

## Consent → `consent`

Treatment consent, privacy-notice acknowledgement, ambient-recording consent (AI-01), telehealth, research ... ``ext_kind`` is the Shri consent category (also emitted as a category coding) and lets other tables pin the kind of consent they require.

- `consent_category`
- `consent_performer`
- `consent_verification`

Invariants / datatype rules: `ck_consent_fhir_policy_rule_coding`, `ck_consent_fhir_policy_rule_display`, `ck_consent_fhir_provision_period_per_1`, `ck_consent_fhir_scope_coding`, `ck_consent_fhir_scope_display`, `ck_consent_fhir_scope_required`, `ck_consent_fhir_source_x`

## Coverage → `coverage`

US Core Coverage: a patient's insurance, in priority order (``order``). Member ID is an identifier (type MB); group number and plan name are coverage_class rows. Card images (front / back) are coverage_card_image rows. entry_source 'ai-generated' when captured by card OCR (P1). At most one active coverage per patient per order.

- `coverage_card_image`
- `coverage_class`
- `coverage_cost_to_beneficiary`
- `coverage_payor`
- `identifier` (shared datatype table)

Invariants / datatype rules: `ck_coverage_fhir_period_per_1`, `ck_coverage_fhir_policy_holder_arc`, `ck_coverage_fhir_subscriber_arc`, `ck_coverage_fhir_type_coding`, `ck_coverage_fhir_type_display`

## DetectedIssue → `detected_issue`

A CDS alert shown at prescribing / ordering time: allergy, drug-drug interaction, duplicate therapy, dose range (layer 1, deterministic) or an AI suggestion (layer 3). Overrides are mitigations with a reason. A high-severity alert on a request that becomes active must have a mitigation (deferred trigger).

- `detected_issue_implicated`
- `detected_issue_mitigation`

Invariants / datatype rules: `ck_detected_issue_fhir_code_coding`, `ck_detected_issue_fhir_code_display`

## DiagnosticReport → `diagnostic_report`

US Core DiagnosticReport (lab, imaging report). Release to the patient is always a human action (released_by).

- `diagnostic_report_based_on`
- `diagnostic_report_category`
- `diagnostic_report_coding`
- `diagnostic_report_performer`
- `diagnostic_report_presented_form`
- `diagnostic_report_result`
- `diagnostic_report_specimen`

Invariants / datatype rules: `ck_diagnostic_report_fhir_code_coding`, `ck_diagnostic_report_fhir_code_display`, `ck_diagnostic_report_fhir_code_required`, `ck_diagnostic_report_fhir_effective_period_per_1`, `ck_diagnostic_report_fhir_effective_x`

## DocumentReference → `document_reference`

Unindexed inbound faxes have no subject yet (indexing queue); everything else must.

- `document_reference_author`
- `document_reference_category`
- `document_reference_content`
- `document_reference_relates_to`
- `identifier` (shared datatype table)

Invariants / datatype rules: `ck_document_reference_fhir_context_period_per_1`, `ck_document_reference_fhir_context_practice_setting_coding`, `ck_document_reference_fhir_context_practice_setting_display`, `ck_document_reference_fhir_type_coding`, `ck_document_reference_fhir_type_display`, `ck_document_reference_fhir_type_required`

## Encounter → `encounter`

US Core Encounter. Rooming = an active encounter_location on an exam room; visit status history in encounter_status_history; diagnoses ranked for claims in encounter_diagnosis.

- `encounter_diagnosis`
- `encounter_location`
- `encounter_participant`
- `encounter_reason`
- `encounter_status_history`
- `encounter_type`
- `identifier` (shared datatype table)

Invariants / datatype rules: `ck_encounter_fhir_period_per_1`, `ck_encounter_fhir_priority_coding`, `ck_encounter_fhir_priority_display`, `ck_encounter_fhir_service_type_coding`, `ck_encounter_fhir_service_type_display`

## FamilyMemberHistory → `family_member_history`

FR-PAT-03 family history (FHIR FamilyMemberHistory).

- `annotation` (shared datatype table)
- `family_member_history_condition`

Invariants / datatype rules: `ck_family_member_history_fhir_age_age_comparator`, `ck_family_member_history_fhir_age_age_qty_3`, `ck_family_member_history_fhir_age_range_rng_2`, `ck_family_member_history_fhir_age_x`, `ck_family_member_history_fhir_born_period_per_1`, `ck_family_member_history_fhir_born_x`, `ck_family_member_history_fhir_data_absent_reason_coding`, `ck_family_member_history_fhir_data_absent_reason_display`, `ck_family_member_history_fhir_deceased_age_comparator`, `ck_family_member_history_fhir_deceased_age_qty_3`, `ck_family_member_history_fhir_deceased_x`, `ck_family_member_history_fhir_fhs_1`, `ck_family_member_history_fhir_fhs_2`, `ck_family_member_history_fhir_relationship_coding`, `ck_family_member_history_fhir_relationship_display`, `ck_family_member_history_fhir_relationship_required`, `ck_family_member_history_fhir_sex_coding`, `ck_family_member_history_fhir_sex_display`

## Immunization → `immunization`

US Core Immunization - history only (P1); no inventory or administration workflow.

- `annotation` (shared datatype table)

Invariants / datatype rules: `ck_immunization_fhir_dose_quantity_qty_3`, `ck_immunization_fhir_occurrence_x`, `ck_immunization_fhir_report_origin_coding`, `ck_immunization_fhir_report_origin_display`, `ck_immunization_fhir_route_coding`, `ck_immunization_fhir_route_display`, `ck_immunization_fhir_site_coding`, `ck_immunization_fhir_site_display`, `ck_immunization_fhir_status_reason_coding`, `ck_immunization_fhir_status_reason_display`, `ck_immunization_fhir_vaccine_code_coding`, `ck_immunization_fhir_vaccine_code_display`, `ck_immunization_fhir_vaccine_code_required`

## Location → `location`

Sites, buildings and exam rooms (rooming). A site's billing attributes are in the admin ``facility`` table.

- `address` (shared datatype table)
- `contact_point` (shared datatype table)
- `identifier` (shared datatype table)

Invariants / datatype rules: `ck_location_fhir_physical_type_coding`, `ck_location_fhir_physical_type_display`, `ck_location_fhir_type_coding`, `ck_location_fhir_type_display`

## Medication → `medication`

Used when a coded RxNorm concept is not enough (compounds, specific NDC packages).

- `medication_ingredient`

Invariants / datatype rules: `ck_medication_fhir_code_coding`, `ck_medication_fhir_code_display`, `ck_medication_fhir_code_required`, `ck_medication_fhir_form_coding`, `ck_medication_fhir_form_display`

## MedicationDispense → `medication_dispense`

Fill history from the eRx network (RxFill / medication history). No in-house dispensing.

- `dosage` (shared datatype table)

Invariants / datatype rules: `ck_medication_dispense_fhir_days_supply_qty_3`, `ck_medication_dispense_fhir_mdd_1`, `ck_medication_dispense_fhir_medication_codeable_concept_coding`, `ck_medication_dispense_fhir_medication_codeable_concept_display`, `ck_medication_dispense_fhir_medication_x`, `ck_medication_dispense_fhir_quantity_qty_3`

## MedicationRequest → `medication_request`

US Core MedicationRequest (a prescription). Beyond draft it must be signed by a practitioner; once signed its clinical content is frozen (trigger) and every version is in fhir_resource_history. Amendments are a new request with priorPrescription. AI output can never become a prescription without the signing clinician (FR-MED-02).

- `annotation` (shared datatype table)
- `dosage` (shared datatype table)
- `medication_request_reason`

Invariants / datatype rules: `ck_medication_request_fhir_course_of_therapy_type_coding`, `ck_medication_request_fhir_course_of_therapy_type_display`, `ck_medication_request_fhir_dispense_request_expected_s_6a4f891e`, `ck_medication_request_fhir_dispense_request_quantity_qty_3`, `ck_medication_request_fhir_dispense_request_validity_p_4570777d`, `ck_medication_request_fhir_medication_codeable_concept_coding`, `ck_medication_request_fhir_medication_codeable_concept_display`, `ck_medication_request_fhir_medication_x`, `ck_medication_request_fhir_reported_x`, `ck_medication_request_fhir_requester_arc`, `ck_medication_request_fhir_status_reason_coding`, `ck_medication_request_fhir_status_reason_display`, `ck_medication_request_fhir_substitution_reason_coding`, `ck_medication_request_fhir_substitution_reason_display`

## MedicationStatement → `medication_statement`

The reconciled medication list (FR-MED-01), incl. external medication history.

- `annotation` (shared datatype table)
- `dosage` (shared datatype table)
- `medication_statement_reason`

Invariants / datatype rules: `ck_medication_statement_fhir_category_coding`, `ck_medication_statement_fhir_category_display`, `ck_medication_statement_fhir_effective_period_per_1`, `ck_medication_statement_fhir_effective_x`, `ck_medication_statement_fhir_information_source_arc`, `ck_medication_statement_fhir_medication_codeable_conce_ebef88ae`, `ck_medication_statement_fhir_medication_codeable_concept_coding`, `ck_medication_statement_fhir_medication_x`, `ck_medication_statement_fhir_status_reason_coding`, `ck_medication_statement_fhir_status_reason_display`

## Observation → `observation`

US Core Observation profiles: vital signs (BP as components), laboratory results, smoking status and other social history, surveys, exam findings, point-of-care tests. A final result is corrected in place with status 'corrected' / 'amended'; every earlier version is kept in fhir_resource_history.

- `annotation` (shared datatype table)
- `observation_category`
- `observation_coding`
- `observation_component`
- `observation_has_member`
- `observation_interpretation`
- `observation_performer`
- `observation_reference_range`

Invariants / datatype rules: `ck_observation_fhir_body_site_coding`, `ck_observation_fhir_body_site_display`, `ck_observation_fhir_code_coding`, `ck_observation_fhir_code_display`, `ck_observation_fhir_code_required`, `ck_observation_fhir_data_absent_reason_coding`, `ck_observation_fhir_data_absent_reason_display`, `ck_observation_fhir_effective_period_per_1`, `ck_observation_fhir_effective_x`, `ck_observation_fhir_method_coding`, `ck_observation_fhir_method_display`, `ck_observation_fhir_obs_6`, `ck_observation_fhir_value_codeable_concept_coding`, `ck_observation_fhir_value_codeable_concept_display`, `ck_observation_fhir_value_quantity_comparator`, `ck_observation_fhir_value_quantity_qty_3`, `ck_observation_fhir_value_range_rng_2`, `ck_observation_fhir_value_x`

## Organization → `organization`

The practice itself (tenant.organization_id), external practices, imaging centres, labs. Payers and pharmacies are platform directories (payer, pharmacy).

- `address` (shared datatype table)
- `contact_point` (shared datatype table)
- `identifier` (shared datatype table)

Invariants / datatype rules: `ck_organization_fhir_type_coding`, `ck_organization_fhir_type_display`

## Patient → `patient`

US Core Patient. MRN, driver's licence (AAMVA scan), payer member IDs and OpenEMR pubpid are rows in ``identifier``. A restricted / VIP chart is ``meta_security`` R or V (break-the-glass to open).

- `address` (shared datatype table)
- `contact_point` (shared datatype table)
- `human_name` (shared datatype table)
- `identifier` (shared datatype table)
- `patient_communication`
- `patient_contact`
  - `address`
  - `contact_point`
  - `human_name`
- `patient_general_practitioner`
- `patient_link`
- `patient_race_ethnicity`

Invariants / datatype rules: `ck_patient_fhir_deceased_x`, `ck_patient_fhir_marital_status_coding`, `ck_patient_fhir_marital_status_display`, `ck_patient_fhir_multiple_birth_x`

## Practitioner → `practitioner`

US Core Practitioner. NPI is an identifier (system us-npi), validated and unique per tenant. DEA numbers are OpenBao references only.

- `address` (shared datatype table)
- `contact_point` (shared datatype table)
- `human_name` (shared datatype table)
- `identifier` (shared datatype table)
- `practitioner_qualification`

## PractitionerRole → `practitioner_role`



- `contact_point` (shared datatype table)
- `practitioner_role_location`
- `practitioner_role_specialty`

Invariants / datatype rules: `ck_practitioner_role_fhir_code_coding`, `ck_practitioner_role_fhir_code_display`, `ck_practitioner_role_fhir_period_per_1`

## Procedure → `procedure`

US Core Procedure: procedures performed here and surgical history.

- `annotation` (shared datatype table)
- `procedure_body_site`
- `procedure_coding`
- `procedure_performer`
- `procedure_reason`

Invariants / datatype rules: `ck_procedure_fhir_asserter_arc`, `ck_procedure_fhir_category_coding`, `ck_procedure_fhir_category_display`, `ck_procedure_fhir_code_coding`, `ck_procedure_fhir_code_display`, `ck_procedure_fhir_code_required`, `ck_procedure_fhir_outcome_coding`, `ck_procedure_fhir_outcome_display`, `ck_procedure_fhir_performed_age_comparator`, `ck_procedure_fhir_performed_age_qty_3`, `ck_procedure_fhir_performed_period_per_1`, `ck_procedure_fhir_performed_x`, `ck_procedure_fhir_recorder_arc`, `ck_procedure_fhir_status_reason_coding`, `ck_procedure_fhir_status_reason_display`

## Provenance → `provenance`

FHIR Provenance for significant activities: sign, co-sign, amend, import, AI accept. ``target_*`` names a resource version; existence of the target is checked by trigger (a polymorphic target cannot be a plain FK).

- `provenance_agent`
- `provenance_entity`
- `provenance_signature`

Invariants / datatype rules: `ck_provenance_fhir_activity_coding`, `ck_provenance_fhir_activity_display`, `ck_provenance_fhir_reason_coding`, `ck_provenance_fhir_reason_display`

## RelatedPerson → `related_person`

Emergency contacts, guarantors (GUAR), guardians, insurance subscribers.

- `address` (shared datatype table)
- `contact_point` (shared datatype table)
- `human_name` (shared datatype table)
- `identifier` (shared datatype table)
- `related_person_relationship`

Invariants / datatype rules: `ck_related_person_fhir_period_per_1`

## Schedule → `schedule`



- `schedule_actor`

Invariants / datatype rules: `ck_schedule_fhir_planning_horizon_per_1`, `ck_schedule_fhir_service_category_coding`, `ck_schedule_fhir_service_category_display`, `ck_schedule_fhir_service_type_coding`, `ck_schedule_fhir_service_type_display`, `ck_schedule_fhir_specialty_coding`, `ck_schedule_fhir_specialty_display`

## ServiceRequest → `service_request`

US Core ServiceRequest. category laboratory / imaging / procedure / referral (P1).

- `annotation` (shared datatype table)
- `service_request_category`
- `service_request_coding`
- `service_request_insurance`
- `service_request_performer`
- `service_request_reason`
- `service_request_specimen`

Invariants / datatype rules: `ck_service_request_fhir_body_site_coding`, `ck_service_request_fhir_body_site_display`, `ck_service_request_fhir_code_coding`, `ck_service_request_fhir_code_display`, `ck_service_request_fhir_code_required`, `ck_service_request_fhir_occurrence_period_per_1`, `ck_service_request_fhir_occurrence_x`, `ck_service_request_fhir_performer_type_coding`, `ck_service_request_fhir_performer_type_display`, `ck_service_request_fhir_requester_arc`

## Specimen → `specimen`

Collected specimen; label barcode unique per tenant (requisition labels).

- `annotation` (shared datatype table)

Invariants / datatype rules: `ck_specimen_fhir_collection_body_site_coding`, `ck_specimen_fhir_collection_body_site_display`, `ck_specimen_fhir_collection_collected_period_per_1`, `ck_specimen_fhir_collection_collected_x`, `ck_specimen_fhir_collection_fasting_status_codeable_co_005d621d`, `ck_specimen_fhir_collection_fasting_status_codeable_co_94879370`, `ck_specimen_fhir_collection_method_coding`, `ck_specimen_fhir_collection_method_display`, `ck_specimen_fhir_collection_quantity_qty_3`, `ck_specimen_fhir_type_coding`, `ck_specimen_fhir_type_display`

