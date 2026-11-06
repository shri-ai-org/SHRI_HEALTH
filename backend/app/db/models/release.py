"""Release priority of every table (P0_SCHEMA_SCOPE.md): ``P0``, ``P0 stretch``, ``P1`` or ``P2``,
kept as ``Table.info["release"]`` and shown in the data dictionary (``gen_docs``).

``P0`` is what the pilot needs to go live; ``P0 stretch`` is wanted for it but not required; ``P1``
and ``P2`` come later. Every table is still built and locked the same way (D72): a tag changes
no schema, grant or policy, only what the dictionary says and what the pilot waits for.

Every resource and admin table is named once in ``TAGS``. A FHIR child or datatype table takes
its resource's tag, through its parent columns; one shared by several resources takes the
highest of theirs. A new table without a tag fails ``tests/test_release_tags.py``.

The calls not named in P0_SCHEMA_SCOPE.md, agreed with Anand on 5 Nov 2026:
``consumed_logout_token`` is P0 (staff back-channel logout, D94, a security control);
``openemr_column_map`` and ``ai_request_retrieved_chunk`` are P1 with the migration tooling and
RAG. ``pre_registration`` and the portal tables are P1 until Vimal's product call on #85.
"""
from __future__ import annotations

from typing import Any, Final

from sqlalchemy import Table

from app.db.constraints import referenced_table

P0: Final = "P0"
P0_STRETCH: Final = "P0 stretch"
P1: Final = "P1"
P2: Final = "P2"
#: Highest first: a shared child table takes the first of these its parents have.
RELEASES: Final = (P0, P0_STRETCH, P1, P2)

TAGS: dict[str, str] = {
    # admin.ai
    "ai_feature_setting": P0,
    "ai_request": P0,
    "ai_request_input_ref": P0,
    "ai_request_retrieved_chunk": P1,
    "ai_suggestion": P0,
    "ai_suggestion_evidence": P0,
    "ai_suggestion_unknown": P0,
    "audio_recording": P0,
    "knowledge_chunk": P1,
    "knowledge_source": P1,
    "knowledge_source_role": P1,
    "prompt_template": P0,
    "transcript": P0,
    # admin.comms
    "binary_object": P0,
    "communication_preference": P0,
    "fax_transmission": P0,
    "message_template": P0,
    "outbound_communication": P0,
    "outbound_communication_param": P0,
    # admin.core
    "app_user": P0,
    "care_team_member": P0,
    "code_system": P0,
    "concept": P0,
    "concept_property": P0,
    "cosign_rule": P0,
    "facility": P0,
    "mrn_counter": P0,
    "permission": P0,
    "picklist": P0,
    "picklist_item": P0,
    "pre_registration": P1,
    "role": P0,
    "role_permission": P0,
    "setting_definition": P0,
    "tenant": P0,
    "tenant_setting": P0,
    "user_role": P0,
    # admin.medication
    "erx_transaction": P0,
    "patient_pharmacy": P0,
    "pharmacy": P0,
    "pharmacy_service_level": P0,
    # admin.orders
    "abn_notice": P0,
    "compendium_aoe_option": P0,
    "compendium_aoe_question": P0,
    "compendium_covered_diagnosis": P0,
    "compendium_panel_member": P0,
    "compendium_test": P0,
    "compendium_test_code": P0,
    "lab_account": P0,
    "lab_account_bill_to": P0,
    "lab_provider": P0,
    "lab_requisition": P0,
    "medical_necessity_check": P0,
    "result_acknowledgement": P0,
    "service_request_aoe_answer": P0,
    "service_request_status_event": P0,
    "unmatched_result": P0,
    "unmatched_result_candidate": P0,
    # admin.platform
    "audit_event": P0,
    "break_glass_access": P0,
    "duplicate_candidate": P0,
    "duplicate_match_evidence": P0,
    "integration_endpoint": P0,
    "integration_endpoint_setting": P0,
    "integration_message": P0,
    "migration_issue": P1,
    "migration_reconciliation": P1,
    "migration_record_map": P1,
    "migration_run": P1,
    "openemr_column_map": P1,
    "patient_merge": P0,
    # admin.portal
    "consumed_logout_token": P0,
    "online_bookable_type": P1,
    "online_booking_setting": P1,
    "portal_account": P1,
    "portal_change_request": P1,
    "portal_invitation": P1,
    "portal_session": P1,
    "release_hold": P1,
    # admin.practice
    "appointment_type": P0,
    "availability_rule_appointment_type": P0,
    "cds_rule": P0,
    "consent_requirement": P0,
    "note_template": P0,
    "note_template_section": P0,
    "order_set": P0,
    "order_set_item": P0,
    "prescription_favorite": P0,
    "schedule_availability_rule": P0,
    "schedule_exception": P0,
    "smart_phrase": P0,
    "user_alert_suppression": P0,
    "user_favorite": P0,
    "visit_flow_event": P0,
    "work_item": P0,
    "work_item_event": P0,
    # admin.rcm
    "charge": P0,
    "charge_diagnosis_pointer": P0,
    "charge_modifier": P0,
    "claim": P0,
    "claim_diagnosis": P0,
    "claim_line": P0,
    "claim_line_diagnosis_pointer": P0,
    "claim_line_modifier": P0,
    "claim_status_event": P0,
    "eligibility_benefit": P0,
    "eligibility_check": P0,
    "eligibility_service_type": P0,
    "employer": P0,
    "fee_schedule": P0,
    "fee_schedule_item": P0,
    "patient_payment": P0,
    "payer": P0,
    "payer_clearinghouse_id": P0,
    "payer_enrollment": P0,
    "practice_payer": P0,
    "remittance": P0_STRETCH,
    "remittance_adjustment": P0_STRETCH,
    "remittance_claim": P0_STRETCH,
    "remittance_remark": P0_STRETCH,
    "remittance_service_line": P0_STRETCH,
    "superbill": P0,
    # admin.runtime
    "app_session": P0,
    "event_log": P0,
    "idempotency_record": P0,
    "operation": P0,
    # fhir.clinical
    "allergy_intolerance": P0,
    "condition": P0,
    "family_member_history": P0,
    "immunization": P1,
    "observation": P0,
    "procedure": P0,
    # fhir.directory
    "location": P0,
    "organization": P0,
    "patient": P0,
    "practitioner": P0,
    "practitioner_role": P0,
    "related_person": P0,
    # fhir.documents
    "composition": P0,
    "document_reference": P0,
    # fhir.medication
    "detected_issue": P0,
    "medication": P0,
    "medication_dispense": P0,
    "medication_request": P0,
    "medication_statement": P1,
    # fhir.orders
    "diagnostic_report": P0,
    "service_request": P0,
    "specimen": P0,
    # fhir.records
    "consent": P0,
    "coverage": P0,
    "fhir_resource_history": P0,
    "provenance": P0,
    # fhir.workflow
    "appointment": P0,
    "encounter": P0,
    "schedule": P0,
}


def _tag(name: str, cls: type[Any], mappers: dict[str, type[Any]],
         seen: frozenset[str]) -> str | None:
    if name in TAGS:
        return TAGS[name]
    parents = [referenced_table(cls.__table__.c[col]).name
               for col in getattr(cls, "fhir_parent", ())]
    tags = {_tag(p, mappers[p], mappers, seen | {name}) for p in parents
            if p in mappers and p not in seen}
    return next((r for r in RELEASES if r in tags), None)


def apply_release_tags(mappers: dict[str, type[Any]]) -> None:
    """Sets ``info["release"]`` on every table that has a tag; an untagged one is left without
    it, so the test names it."""
    for name, cls in mappers.items():
        tag = _tag(name, cls, mappers, frozenset())
        table: Table = cls.__table__
        if tag is not None:
            table.info["release"] = tag
