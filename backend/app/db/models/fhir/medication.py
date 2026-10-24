"""Medication, MedicationRequest (prescriptions), MedicationStatement (the reconciled list),
MedicationDispense (fill history from the eRx network) and DetectedIssue (rule-based safety
alerts with override reasons; AI suggestions are kept apart by ext_rule_source)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    Base,
    ClinicalResourceMixin,
    FhirChildMixin,
    FhirResourceMixin,
    code_array_check,
    enum_type,
)
from app.db.fhir_types import (
    boolean,
    cc,
    children,
    code,
    code_list,
    date_time,
    integer,
    parent,
    period,
    prim,
    quantity,
    ref,
    string,
)
from app.db.models import systems
from app.db.models.enums import (
    DeaSchedule,
    DetectedIssueSeverity,
    DetectedIssueStatus,
    MedicationDispenseStatus,
    MedicationRequestCategory,
    MedicationRequestIntent,
    MedicationRequestStatus,
    MedicationStatementStatus,
    MedicationStatus,
    RequestPriority,
    RuleSource,
)

MED_SYSTEMS = f"('{systems.RXNORM}', '{systems.NDC}')"
SIGNED_OR_EXEMPT = ("status IN ('draft', 'cancelled', 'entered-in-error') OR "
                    "entry_source IN ('imported', 'interface') OR "
                    "(ext_signed_at IS NOT NULL AND ext_signed_by_practitioner_id IS NOT NULL)")


class Medication(Base, FhirResourceMixin):
    """Used when a coded RxNorm concept is not enough (compounds, specific NDC packages)."""
    __tablename__ = "medication"
    fhir_type = "Medication"

    code_system, code_code, code_display, code_text = cc("code", required=True)
    status: Mapped[str | None] = code("status", MedicationStatus)
    manufacturer_organization_id: Mapped[uuid.UUID | None] = ref(
        "manufacturer", "organization", "Organization")
    form_system, form_code, form_display, form_text = cc("form")

    ingredient = children("MedicationIngredient", "medication_id", "ingredient")


class MedicationIngredient(Base, FhirChildMixin):
    __tablename__ = "medication_ingredient"
    fhir_parent = ("medication_id",)
    __fhir_choices__ = {"item": (True, ["itemCodeableConcept", "itemReference"])}

    medication_id: Mapped[uuid.UUID] = parent("medication")
    (item_codeable_concept_system, item_codeable_concept_code, item_codeable_concept_display,
     item_codeable_concept_text) = cc("itemCodeableConcept")
    item_medication_id: Mapped[uuid.UUID | None] = ref("itemReference", "medication",
                                                       "Medication")
    is_active: Mapped[bool | None] = boolean("isActive")
    (strength_numerator_value, strength_numerator_unit, strength_numerator_system,
     strength_numerator_code) = quantity("strength.numerator", comparator=False)
    (strength_denominator_value, strength_denominator_unit, strength_denominator_system,
     strength_denominator_code) = quantity("strength.denominator", comparator=False)


# =========================================================================== MedicationRequest
class MedicationRequest(Base, ClinicalResourceMixin):
    """US Core MedicationRequest (a prescription). Beyond draft it must be signed by a
    practitioner; once signed its clinical content is frozen (trigger) and every version is in
    fhir_resource_history. Amendments are a new request with priorPrescription. AI output can
    never become a prescription without the signing clinician (FR-MED-02)."""
    __tablename__ = "medication_request"
    fhir_type = "MedicationRequest"
    __fhir_choices__ = {
        "reported": (False, ["reportedBoolean", "reportedReference"]),
        "medication": (True, ["medicationCodeableConcept", "medicationReference"]),
    }
    __extra_args__ = (
        CheckConstraint(SIGNED_OR_EXEMPT, name="active_requires_signature"),
        CheckConstraint(f"medication_codeable_concept_system IS NULL OR "
                        f"medication_codeable_concept_system IN {MED_SYSTEMS}",
                        name="medication_code_binding"),
        CheckConstraint("dispense_request_number_of_repeats_allowed IS NULL OR "
                        "dispense_request_number_of_repeats_allowed BETWEEN 0 AND 11",
                        name="repeats_range"),
        # 21 CFR 1306: no refills on Schedule II; at most 5 on Schedules III-V
        CheckConstraint("ext_dea_schedule IS DISTINCT FROM 'CII' OR "
                        "coalesce(dispense_request_number_of_repeats_allowed, 0) = 0",
                        name="cii_no_refills"),
        CheckConstraint("ext_dea_schedule NOT IN ('CIII', 'CIV', 'CV') OR "
                        "coalesce(dispense_request_number_of_repeats_allowed, 0) <= 5",
                        name="ciii_v_max_5_refills"),
        CheckConstraint("dispense_request_quantity_value IS NULL OR "
                        "dispense_request_quantity_value > 0", name="quantity_positive"),
        CheckConstraint("prior_prescription_id IS DISTINCT FROM id", name="not_prior_of_self"),
        code_array_check("category", MedicationRequestCategory, "category_codes"),
        Index("ix_medication_request_patient_status", "subject_patient_id", "status"),
    )

    status: Mapped[str] = code("status", MedicationRequestStatus, required=True,
                               default=MedicationRequestStatus.DRAFT)
    status_reason_system, status_reason_code, status_reason_display, status_reason_text = cc(
        "statusReason")
    intent: Mapped[str] = code("intent", MedicationRequestIntent, required=True,
                               default=MedicationRequestIntent.ORDER)
    category: Mapped[list[str]] = code_list("category", fixed_system=systems.MEDREQ_CATEGORY)
    priority: Mapped[str | None] = code("priority", RequestPriority)
    do_not_perform: Mapped[bool | None] = boolean("doNotPerform")
    reported_boolean: Mapped[bool | None] = boolean("reportedBoolean")
    reported_practitioner_id: Mapped[uuid.UUID | None] = ref("reportedReference",
                                                             "practitioner", "Practitioner")
    (medication_codeable_concept_system, medication_codeable_concept_code,
     medication_codeable_concept_display, medication_codeable_concept_text) = cc(
        "medicationCodeableConcept")
    medication_medication_id: Mapped[uuid.UUID | None] = ref("medicationReference",
                                                             "medication", "Medication")
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True)
    encounter_id: Mapped[uuid.UUID | None] = ref("encounter", "encounter", "Encounter")
    authored_on: Mapped[datetime | None] = date_time("authoredOn")
    requester_practitioner_id: Mapped[uuid.UUID | None] = ref(
        "requester", "practitioner", "Practitioner", required=True)
    requester_practitioner_role_id: Mapped[uuid.UUID | None] = ref(
        "requester", "practitioner_role", "PractitionerRole", required=True)
    requester_organization_id: Mapped[uuid.UUID | None] = ref(
        "requester", "organization", "Organization", required=True)
    requester_patient_id: Mapped[uuid.UUID | None] = ref("requester", "patient", "Patient",
                                                         required=True)
    recorder_practitioner_id: Mapped[uuid.UUID | None] = ref("recorder", "practitioner",
                                                             "Practitioner")
    (course_of_therapy_type_system, course_of_therapy_type_code,
     course_of_therapy_type_display, course_of_therapy_type_text) = cc("courseOfTherapyType")
    (dispense_request_validity_period_start,
     dispense_request_validity_period_end) = period("dispenseRequest.validityPeriod")
    dispense_request_number_of_repeats_allowed: Mapped[int | None] = integer(
        "dispenseRequest.numberOfRepeatsAllowed", fhir_type="unsignedInt")
    (dispense_request_quantity_value, dispense_request_quantity_unit,
     dispense_request_quantity_system, dispense_request_quantity_code) = quantity(
        "dispenseRequest.quantity", comparator=False, fhir_type="SimpleQuantity")
    (dispense_request_expected_supply_duration_value,
     dispense_request_expected_supply_duration_unit,
     dispense_request_expected_supply_duration_system,
     dispense_request_expected_supply_duration_code) = quantity(
        "dispenseRequest.expectedSupplyDuration", comparator=False, fhir_type="Duration")
    dispense_request_performer_pharmacy_id: Mapped[uuid.UUID | None] = ref(
        "dispenseRequest.performer", "pharmacy", "Organization")
    substitution_allowed_boolean: Mapped[bool | None] = boolean("substitution.allowedBoolean")
    (substitution_reason_system, substitution_reason_code, substitution_reason_display,
     substitution_reason_text) = cc("substitution.reason")
    prior_prescription_id: Mapped[uuid.UUID | None] = ref(
        "priorPrescription", "medication_request", "MedicationRequest")
    # Shri extensions
    ext_dea_schedule: Mapped[str | None] = mapped_column(enum_type(DeaSchedule, 4))
    ext_note_to_pharmacist: Mapped[str | None] = mapped_column(String(210))  # NCPDP limit
    ext_signed_at: Mapped[datetime | None]
    ext_signed_by_practitioner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.practitioner.id"))
    ext_signed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))

    reason = children("MedicationRequestReason", "medication_request_id", None, spread=True)
    dosage_instruction = children("Dosage", "medication_request_id", "dosageInstruction",
                                  order_by="sequence")
    note = children("Annotation", "medication_request_id", "note")


class MedicationRequestReason(Base, FhirChildMixin):
    __tablename__ = "medication_request_reason"
    __fhir_choices__ = {"reason": (True, ["reasonCode", "reasonReference"])}
    fhir_parent = ("medication_request_id",)

    medication_request_id: Mapped[uuid.UUID] = parent("medication_request")
    reason_code_system, reason_code_code, reason_code_display, reason_code_text = cc(
        "reasonCode", many=True)
    condition_id: Mapped[uuid.UUID | None] = ref("reasonReference", "condition", "Condition")
    observation_id: Mapped[uuid.UUID | None] = ref("reasonReference", "observation",
                                                   "Observation")


# =========================================================================== MedicationStatement
class MedicationStatement(Base, ClinicalResourceMixin):
    """The reconciled medication list (FR-MED-01), incl. external medication history."""
    __tablename__ = "medication_statement"
    fhir_type = "MedicationStatement"
    __fhir_choices__ = {
        "medication": (True, ["medicationCodeableConcept", "medicationReference"]),
        "effective": (False, ["effectiveDateTime", "effectivePeriod"]),
    }
    __extra_args__ = (
        CheckConstraint(f"medication_codeable_concept_system IS NULL OR "
                        f"medication_codeable_concept_system IN {MED_SYSTEMS}",
                        name="medication_code_binding"),
        CheckConstraint("status NOT IN ('stopped', 'completed') "
                        "OR effective_period_end IS NOT NULL "
                        "OR effective_date_time IS NOT NULL OR status_reason_text IS NOT NULL "
                        "OR status_reason_code IS NOT NULL", name="stopped_has_end_or_reason"),
        Index("ix_medication_statement_patient_status", "subject_patient_id", "status"),
    )

    status: Mapped[str] = code("status", MedicationStatementStatus, required=True)
    status_reason_system, status_reason_code, status_reason_display, status_reason_text = cc(
        "statusReason", many=True)
    category_system, category_code, category_display, category_text = cc("category")
    (medication_codeable_concept_system, medication_codeable_concept_code,
     medication_codeable_concept_display, medication_codeable_concept_text) = cc(
        "medicationCodeableConcept")
    medication_medication_id: Mapped[uuid.UUID | None] = ref("medicationReference",
                                                             "medication", "Medication")
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True)
    context_encounter_id: Mapped[uuid.UUID | None] = ref("context", "encounter", "Encounter")
    based_on_medication_request_id: Mapped[uuid.UUID | None] = ref(
        "basedOn", "medication_request", "MedicationRequest", many=True)
    effective_date_time: Mapped[datetime | None] = date_time("effectiveDateTime")
    effective_period_start, effective_period_end = period("effectivePeriod")
    date_asserted: Mapped[datetime | None] = date_time("dateAsserted")
    information_source_patient_id: Mapped[uuid.UUID | None] = ref(
        "informationSource", "patient", "Patient")
    information_source_practitioner_id: Mapped[uuid.UUID | None] = ref(
        "informationSource", "practitioner", "Practitioner")
    information_source_related_person_id: Mapped[uuid.UUID | None] = ref(
        "informationSource", "related_person", "RelatedPerson")
    information_source_organization_id: Mapped[uuid.UUID | None] = ref(
        "informationSource", "organization", "Organization")
    ext_last_reconciled_at: Mapped[datetime | None]
    ext_last_reconciled_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.app_user.id"))

    reason = children("MedicationStatementReason", "medication_statement_id", None,
                      spread=True)
    dosage = children("Dosage", "medication_statement_id", "dosage", order_by="sequence")
    note = children("Annotation", "medication_statement_id", "note")


class MedicationStatementReason(Base, FhirChildMixin):
    __tablename__ = "medication_statement_reason"
    __fhir_choices__ = {"reason": (True, ["reasonCode", "reasonReference"])}
    fhir_parent = ("medication_statement_id",)

    medication_statement_id: Mapped[uuid.UUID] = parent("medication_statement")
    reason_code_system, reason_code_code, reason_code_display, reason_code_text = cc(
        "reasonCode", many=True)
    condition_id: Mapped[uuid.UUID | None] = ref("reasonReference", "condition", "Condition")
    observation_id: Mapped[uuid.UUID | None] = ref("reasonReference", "observation",
                                                   "Observation")


# =========================================================================== MedicationDispense
class MedicationDispense(Base, ClinicalResourceMixin):
    """Fill history from the eRx network (RxFill / medication history). No in-house dispensing."""
    __tablename__ = "medication_dispense"
    fhir_type = "MedicationDispense"
    __fhir_choices__ = {"medication": (True, ["medicationCodeableConcept",
                                              "medicationReference"])}
    __extra_args__ = (
        CheckConstraint("when_handed_over IS NULL OR when_prepared IS NULL OR "
                        "when_handed_over >= when_prepared", name="fhir_mdd_1"),
        CheckConstraint(f"medication_codeable_concept_system IS NULL OR "
                        f"medication_codeable_concept_system IN {MED_SYSTEMS}",
                        name="medication_code_binding"),
        Index("ix_medication_dispense_patient_time", "subject_patient_id", "when_handed_over"),
    )

    status: Mapped[str] = code("status", MedicationDispenseStatus, required=True)
    (medication_codeable_concept_system, medication_codeable_concept_code,
     medication_codeable_concept_display, medication_codeable_concept_text) = cc(
        "medicationCodeableConcept")
    medication_medication_id: Mapped[uuid.UUID | None] = ref("medicationReference",
                                                             "medication", "Medication")
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True)
    context_encounter_id: Mapped[uuid.UUID | None] = ref("context", "encounter", "Encounter")
    authorizing_prescription_id: Mapped[uuid.UUID | None] = ref(
        "authorizingPrescription", "medication_request", "MedicationRequest", many=True)
    (quantity_value, quantity_unit, quantity_system, quantity_code) = quantity(
        "quantity", comparator=False, fhir_type="SimpleQuantity")
    (days_supply_value, days_supply_unit, days_supply_system, days_supply_code) = quantity(
        "daysSupply", comparator=False, fhir_type="SimpleQuantity")
    when_prepared: Mapped[datetime | None] = date_time("whenPrepared")
    when_handed_over: Mapped[datetime | None] = date_time("whenHandedOver")
    ext_pharmacy_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.pharmacy.id"))

    dosage_instruction = children("Dosage", "medication_dispense_id", "dosageInstruction",
                                  order_by="sequence")


# =========================================================================== DetectedIssue
class DetectedIssue(Base, ClinicalResourceMixin):
    """A CDS alert shown at prescribing / ordering time: allergy, drug-drug interaction,
    duplicate therapy, dose range (layer 1, deterministic) or an AI suggestion (layer 3).
    Overrides are mitigations with a reason. A high-severity alert on a request that becomes
    active must have a mitigation (deferred trigger)."""
    __tablename__ = "detected_issue"
    fhir_type = "DetectedIssue"
    __extra_args__ = (
        CheckConstraint("ext_rule_source <> 'ai' OR ai_suggestion_id IS NOT NULL",
                        name="ai_alert_has_suggestion"),
        CheckConstraint("ext_rule_source <> 'deterministic' OR ext_cds_rule_id IS NOT NULL",
                        name="rule_alert_has_rule"),
        Index("ix_detected_issue_patient_time", "patient_id", "identified_date_time"),
    )

    status: Mapped[str] = code("status", DetectedIssueStatus, required=True)
    code_system, code_code, code_display, code_text = cc("code")   # v3 ActCode DRG, ALGY ...
    severity: Mapped[str | None] = code("severity", DetectedIssueSeverity)
    patient_id: Mapped[uuid.UUID] = ref("patient", "patient", "Patient", required=True)
    identified_date_time: Mapped[datetime | None] = date_time("identifiedDateTime")
    author_practitioner_id: Mapped[uuid.UUID | None] = ref("author", "practitioner",
                                                           "Practitioner")
    detail: Mapped[str | None] = string("detail", None)
    reference: Mapped[str | None] = prim("reference", String(500), "uri")
    ext_rule_source: Mapped[str] = mapped_column(enum_type(RuleSource), nullable=False,
                                                 default=RuleSource.DETERMINISTIC.value)
    ext_cds_rule_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.cds_rule.id"))
    ext_knowledge_base_version: Mapped[str | None] = mapped_column(String(60))

    implicated = children("DetectedIssueImplicated", "detected_issue_id", None, spread=True)
    mitigation = children("DetectedIssueMitigation", "detected_issue_id", "mitigation")


class DetectedIssueImplicated(Base, FhirChildMixin):
    __tablename__ = "detected_issue_implicated"
    fhir_parent = ("detected_issue_id",)
    __extra_args__ = (Index("ix_detected_issue_implicated_medreq", "medication_request_id"),)

    detected_issue_id: Mapped[uuid.UUID] = parent("detected_issue")
    medication_request_id: Mapped[uuid.UUID | None] = ref(
        "implicated", "medication_request", "MedicationRequest", required=True)
    medication_statement_id: Mapped[uuid.UUID | None] = ref(
        "implicated", "medication_statement", "MedicationStatement", required=True)
    allergy_intolerance_id: Mapped[uuid.UUID | None] = ref(
        "implicated", "allergy_intolerance", "AllergyIntolerance", required=True)
    condition_id: Mapped[uuid.UUID | None] = ref("implicated", "condition", "Condition",
                                                 required=True)
    observation_id: Mapped[uuid.UUID | None] = ref("implicated", "observation", "Observation",
                                                   required=True)
    service_request_id: Mapped[uuid.UUID | None] = ref(
        "implicated", "service_request", "ServiceRequest", required=True)


class DetectedIssueMitigation(Base, FhirChildMixin):
    """Clinician response: override with reason, therapy changed, alert acknowledged."""
    __tablename__ = "detected_issue_mitigation"
    fhir_parent = ("detected_issue_id",)
    __extra_args__ = (CheckConstraint("length(trim(ext_reason)) >= 3", name="reason_stated"),)

    detected_issue_id: Mapped[uuid.UUID] = parent("detected_issue")
    action_system, action_code, action_display, action_text = cc("action", required=True)
    date: Mapped[datetime | None] = date_time("date")
    author_practitioner_id: Mapped[uuid.UUID | None] = ref("author", "practitioner",
                                                           "Practitioner", required=True)
    ext_reason: Mapped[str] = mapped_column(String(500), nullable=False)
