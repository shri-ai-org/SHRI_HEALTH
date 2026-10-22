"""Baseline: every table, key, constraint and index.

The DDL is frozen in sql_0001/ (compiled from the models by tools/gen_db_rules.py when this
revision was written). Never edit it: schema changes are new revisions.

Revision ID: 0001
Revises:
Create Date: 2026-10-22
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0001")
TABLES = ['tenant', 'setting_definition', 'permission', 'code_system', 'pharmacy', 'openemr_column_map', 'payer', 'prompt_template', 'app_user', 'role', 'concept', 'pharmacy_service_level', 'cds_rule', 'payer_clearinghouse_id', 'fhir_resource_history', 'ai_feature_setting', 'binary_object', 'message_template', 'tenant_setting', 'role_permission', 'concept_property', 'picklist', 'integration_endpoint', 'note_template', 'smart_phrase', 'order_set', 'prescription_favorite', 'user_alert_suppression', 'fee_schedule', 'practitioner', 'organization', 'knowledge_source', 'cosign_rule', 'picklist_item', 'lab_provider', 'integration_endpoint_setting', 'integration_message', 'appointment_type', 'note_template_section', 'payer_enrollment', 'fee_schedule_item', 'patient', 'practitioner_qualification', 'practitioner_role', 'location', 'medication', 'knowledge_source_role', 'knowledge_chunk', 'communication_preference', 'facility', 'care_team_member', 'patient_pharmacy', 'compendium_test', 'audit_event', 'duplicate_candidate', 'remittance', 'family_member_history', 'patient_contact', 'patient_communication', 'patient_general_practitioner', 'patient_race_ethnicity', 'related_person', 'practitioner_role_specialty', 'practitioner_role_location', 'medication_ingredient', 'detected_issue', 'specimen', 'user_role', 'lab_account', 'compendium_test_code', 'compendium_panel_member', 'compendium_aoe_question', 'compendium_covered_diagnosis', 'break_glass_access', 'duplicate_match_evidence', 'patient_merge', 'order_set_item', 'user_favorite', 'family_member_history_condition', 'human_name', 'contact_point', 'address', 'patient_link', 'related_person_relationship', 'detected_issue_mitigation', 'coverage', 'schedule', 'lab_account_bill_to', 'compendium_aoe_option', 'patient_merge_record', 'schedule_availability_rule', 'schedule_exception', 'coverage_payor', 'coverage_class', 'coverage_cost_to_beneficiary', 'coverage_card_image', 'schedule_actor', 'appointment', 'outbound_communication', 'availability_rule_appointment_type', 'visit_flow_event', 'appointment_participant', 'encounter', 'ai_request', 'outbound_communication_param', 'eligibility_check', 'superbill', 'patient_payment', 'condition', 'allergy_intolerance', 'immunization', 'composition', 'medication_request', 'diagnostic_report', 'encounter_status_history', 'encounter_type', 'encounter_participant', 'encounter_location', 'ai_request_input_ref', 'ai_request_retrieved_chunk', 'ai_suggestion', 'erx_transaction', 'result_acknowledgement', 'eligibility_service_type', 'eligibility_benefit', 'claim', 'condition_category', 'condition_coding', 'condition_body_site', 'allergy_intolerance_coding', 'allergy_intolerance_reaction', 'document_reference', 'composition_author', 'composition_attester', 'composition_relates_to', 'composition_section', 'medication_statement', 'medication_dispense', 'diagnostic_report_category', 'diagnostic_report_coding', 'diagnostic_report_performer', 'diagnostic_report_specimen', 'diagnostic_report_presented_form', 'encounter_diagnosis', 'ai_suggestion_evidence', 'ai_suggestion_unknown', 'fax_transmission', 'lab_requisition', 'migration_run', 'claim_diagnosis', 'claim_status_event', 'remittance_claim', 'allergy_reaction_manifestation', 'identifier', 'dosage', 'document_reference_category', 'document_reference_author', 'document_reference_relates_to', 'document_reference_content', 'consent', 'audio_recording', 'migration_reconciliation', 'migration_record_map', 'migration_issue', 'service_request', 'consent_category', 'consent_performer', 'consent_verification', 'provenance', 'transcript', 'service_request_aoe_answer', 'medical_necessity_check', 'service_request_status_event', 'unmatched_result', 'observation', 'procedure', 'service_request_category', 'service_request_coding', 'service_request_performer', 'service_request_insurance', 'service_request_specimen', 'diagnostic_report_based_on', 'provenance_agent', 'provenance_entity', 'provenance_signature', 'abn_notice', 'unmatched_result_candidate', 'work_item', 'charge', 'observation_category', 'observation_coding', 'observation_performer', 'observation_interpretation', 'observation_reference_range', 'observation_has_member', 'observation_component', 'procedure_coding', 'procedure_performer', 'procedure_reason', 'procedure_body_site', 'annotation', 'composition_section_entry', 'medication_request_reason', 'medication_statement_reason', 'detected_issue_implicated', 'service_request_reason', 'diagnostic_report_result', 'appointment_reason', 'encounter_reason', 'work_item_event', 'charge_modifier', 'charge_diagnosis_pointer', 'claim_line', 'claim_line_modifier', 'claim_line_diagnosis_pointer', 'remittance_service_line', 'remittance_adjustment', 'remittance_remark']


def upgrade() -> None:
    op.execute((SQL_DIR / "05_prelude.sql").read_text())
    op.execute((SQL_DIR / "01_schema.sql").read_text())


def downgrade() -> None:
    # One table per statement outside the migration transaction: dropping ~220 tables and
    # their ~900 indexes in a single transaction exceeds max_locks_per_transaction.
    with op.get_context().autocommit_block():
        for table in reversed(TABLES):
            op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
        op.execute("DROP FUNCTION IF EXISTS shri_npi_valid(text)")
