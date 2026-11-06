"""Condition (problem list + encounter diagnoses + health concerns), AllergyIntolerance,
Observation (vitals, labs, social history incl. smoking status, survey), Procedure (incl.
surgical history), FamilyMemberHistory and Immunization (history only, P1).

FHIR invariants enforced as CHECKs are named ``ck_<table>_fhir_<invariant>``.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, Index, SmallInteger, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from shri.db.base import Base, ClinicalResourceMixin, FhirChildMixin, code_array_check
from shri.db.fhir_types import (boolean, cc, cc_code, children, code, code_list, date_time,
                                fdate, frange, instant, integer, parent, period, quantity, ref,
                                string)
from shri.models import systems
from shri.models.enums import (AllergyCategory, AllergyClinicalStatus, AllergyCriticality,
                               AllergyType, AllergyVerificationStatus, ConditionClinicalStatus,
                               ConditionVerificationStatus, EventStatus, FamilyHistoryStatus,
                               ImmunizationStatus, ObservationStatus, ReactionSeverity)

FINAL_RESULT = "('final', 'amended', 'corrected')"


def _coding_table(name: str, parent_table: str, parent_fk: str, element: str = "code"):
    """Additional codings (translations) of a resource's primary CodeableConcept."""
    attrs = {
        "__tablename__": name,
        "fhir_parent": (parent_fk,),
        "fhir_coding_of": element,
        "__extra_args__": (UniqueConstraint(parent_fk, "system", "code"),),
        parent_fk: parent(parent_table),
        "system": mapped_column(String(300), nullable=False),
        "code": mapped_column(String(64), nullable=False),
        "display": mapped_column(String(500)),
        "__annotations__": {parent_fk: Mapped[uuid.UUID], "system": Mapped[str],
                            "code": Mapped[str], "display": Mapped[str | None]},
    }
    return type("".join(p.title() for p in name.split("_")), (Base, FhirChildMixin), attrs)


# =========================================================================== Condition
class Condition(Base, ClinicalResourceMixin):
    """US Core Condition (problem list, encounter diagnosis, health concern)."""
    __tablename__ = "condition"
    fhir_type = "Condition"
    __fhir_choices__ = {
        "onset": (False, ["onsetDateTime", "onsetAge", "onsetPeriod", "onsetString"]),
        "abatement": (False, ["abatementDateTime", "abatementAge", "abatementPeriod",
                              "abatementString"]),
    }
    __extra_args__ = (
        # con-4: if abated, clinicalStatus must be inactive, resolved or remission
        CheckConstraint("(abatement_date_time IS NULL AND abatement_age_value IS NULL AND "
                        "abatement_period_start IS NULL AND abatement_string IS NULL) OR "
                        "clinical_status IN ('inactive', 'resolved', 'remission')",
                        name="fhir_con_4"),
        # con-5: clinicalStatus SHALL NOT be present if verificationStatus is entered-in-error
        CheckConstraint("verification_status IS DISTINCT FROM 'entered-in-error' OR "
                        "clinical_status IS NULL", name="fhir_con_5"),
        CheckConstraint(f"code_system IS NULL OR code_system IN ('{systems.ICD10CM}', "
                        f"'{systems.SNOMED}')", name="code_system_binding"),
        Index("ix_condition_patient_status", "subject_patient_id", "clinical_status"),
        Index("ix_condition_code", "tenant_id", "code_code"),
    )

    clinical_status: Mapped[str | None] = cc_code("clinicalStatus", ConditionClinicalStatus,
                                                  systems.CONDITION_CLINICAL)
    verification_status: Mapped[str | None] = cc_code(
        "verificationStatus", ConditionVerificationStatus, systems.CONDITION_VER_STATUS)
    severity_system, severity_code, severity_display, severity_text = cc("severity")
    code_system, code_code, code_display, code_text = cc("code", required=True)
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True)
    encounter_id: Mapped[uuid.UUID | None] = ref("encounter", "encounter", "Encounter")
    onset_date_time: Mapped[datetime | None] = date_time("onsetDateTime")
    (onset_age_value, onset_age_comparator, onset_age_unit, onset_age_system,
     onset_age_code) = quantity("onsetAge", fhir_type="Age")
    onset_period_start, onset_period_end = period("onsetPeriod")
    onset_string: Mapped[str | None] = string("onsetString", 200)
    abatement_date_time: Mapped[datetime | None] = date_time("abatementDateTime")
    (abatement_age_value, abatement_age_comparator, abatement_age_unit, abatement_age_system,
     abatement_age_code) = quantity("abatementAge", fhir_type="Age")
    abatement_period_start, abatement_period_end = period("abatementPeriod")
    abatement_string: Mapped[str | None] = string("abatementString", 200)
    recorded_date: Mapped[datetime | None] = date_time("recordedDate")
    recorder_practitioner_id: Mapped[uuid.UUID | None] = ref("recorder", "practitioner",
                                                             "Practitioner")
    recorder_patient_id: Mapped[uuid.UUID | None] = ref("recorder", "patient", "Patient")
    recorder_related_person_id: Mapped[uuid.UUID | None] = ref("recorder", "related_person",
                                                               "RelatedPerson")
    asserter_practitioner_id: Mapped[uuid.UUID | None] = ref("asserter", "practitioner",
                                                             "Practitioner")
    asserter_patient_id: Mapped[uuid.UUID | None] = ref("asserter", "patient", "Patient")
    asserter_related_person_id: Mapped[uuid.UUID | None] = ref("asserter", "related_person",
                                                               "RelatedPerson")

    category = children("ConditionCategory", "condition_id", None, spread=True)
    coding = children("ConditionCoding", "condition_id", None)
    body_site = children("ConditionBodySite", "condition_id", None, spread=True)
    note = children("Annotation", "condition_id", "note")


class ConditionCategory(Base, FhirChildMixin):
    """US Core: problem-list-item | encounter-diagnosis | health-concern (+ sdoh)."""
    __tablename__ = "condition_category"
    fhir_parent = ("condition_id",)
    __extra_args__ = (UniqueConstraint("condition_id", "category_system", "category_code"),
                      Index("ix_condition_category_code", "category_code", "condition_id"))

    condition_id: Mapped[uuid.UUID] = parent("condition")
    category_system, category_code, category_display, category_text = cc(
        "category", required=True, many=True)


ConditionCoding = _coding_table("condition_coding", "condition", "condition_id")


class ConditionBodySite(Base, FhirChildMixin):
    __tablename__ = "condition_body_site"
    fhir_parent = ("condition_id",)

    condition_id: Mapped[uuid.UUID] = parent("condition")
    body_site_system, body_site_code, body_site_display, body_site_text = cc(
        "bodySite", required=True, many=True)


# =========================================================================== AllergyIntolerance
class AllergyIntolerance(Base, ClinicalResourceMixin):
    """US Core AllergyIntolerance. 'No known allergies' is code SNOMED 716186003."""
    __tablename__ = "allergy_intolerance"
    fhir_type = "AllergyIntolerance"
    __fhir_choices__ = {"onset": (False, ["onsetDateTime", "onsetAge", "onsetPeriod",
                                          "onsetString"])}
    __extra_args__ = (
        # ait-1: clinicalStatus SHALL be present if verificationStatus is not entered-in-error
        CheckConstraint("verification_status = 'entered-in-error' OR clinical_status IS NOT NULL",
                        name="fhir_ait_1"),
        # ait-2: clinicalStatus SHALL NOT be present if verificationStatus is entered-in-error
        CheckConstraint("verification_status IS DISTINCT FROM 'entered-in-error' OR "
                        "clinical_status IS NULL", name="fhir_ait_2"),
        code_array_check("category", AllergyCategory, "category_codes"),
        Index("ix_allergy_intolerance_patient_status", "patient_id", "clinical_status"),
    )

    clinical_status: Mapped[str | None] = cc_code("clinicalStatus", AllergyClinicalStatus,
                                                  systems.ALLERGY_CLINICAL)
    verification_status: Mapped[str | None] = cc_code(
        "verificationStatus", AllergyVerificationStatus, systems.ALLERGY_VERIFICATION)
    type: Mapped[str | None] = code("type", AllergyType)
    category: Mapped[list[str]] = code_list("category")
    criticality: Mapped[str | None] = code("criticality", AllergyCriticality)
    code_system, code_code, code_display, code_text = cc("code", required=True)
    patient_id: Mapped[uuid.UUID] = ref("patient", "patient", "Patient", required=True)
    encounter_id: Mapped[uuid.UUID | None] = ref("encounter", "encounter", "Encounter")
    onset_date_time: Mapped[datetime | None] = date_time("onsetDateTime")
    (onset_age_value, onset_age_comparator, onset_age_unit, onset_age_system,
     onset_age_code) = quantity("onsetAge", fhir_type="Age")
    onset_period_start, onset_period_end = period("onsetPeriod")
    onset_string: Mapped[str | None] = string("onsetString", 200)
    recorded_date: Mapped[datetime | None] = date_time("recordedDate")
    recorder_practitioner_id: Mapped[uuid.UUID | None] = ref("recorder", "practitioner",
                                                             "Practitioner")
    recorder_patient_id: Mapped[uuid.UUID | None] = ref("recorder", "patient", "Patient")
    asserter_practitioner_id: Mapped[uuid.UUID | None] = ref("asserter", "practitioner",
                                                             "Practitioner")
    asserter_patient_id: Mapped[uuid.UUID | None] = ref("asserter", "patient", "Patient")
    asserter_related_person_id: Mapped[uuid.UUID | None] = ref("asserter", "related_person",
                                                               "RelatedPerson")
    last_occurrence: Mapped[datetime | None] = date_time("lastOccurrence")

    coding = children("AllergyIntoleranceCoding", "allergy_intolerance_id", None)
    reaction = children("AllergyIntoleranceReaction", "allergy_intolerance_id", "reaction")
    note = children("Annotation", "allergy_intolerance_id", "note")


AllergyIntoleranceCoding = _coding_table("allergy_intolerance_coding", "allergy_intolerance",
                                         "allergy_intolerance_id")


class AllergyIntoleranceReaction(Base, FhirChildMixin):
    __tablename__ = "allergy_intolerance_reaction"
    fhir_parent = ("allergy_intolerance_id",)

    allergy_intolerance_id: Mapped[uuid.UUID] = parent("allergy_intolerance")
    substance_system, substance_code, substance_display, substance_text = cc("substance")
    description: Mapped[str | None] = string("description", 1000)
    onset: Mapped[datetime | None] = date_time("onset")
    severity: Mapped[str | None] = code("severity", ReactionSeverity)
    exposure_route_system, exposure_route_code, exposure_route_display, exposure_route_text = \
        cc("exposureRoute")

    manifestation = children("AllergyReactionManifestation", "reaction_id", None, spread=True)


class AllergyReactionManifestation(Base, FhirChildMixin):
    """reaction.manifestation (1..*): hives, anaphylaxis ... (SNOMED)."""
    __tablename__ = "allergy_reaction_manifestation"
    fhir_parent = ("reaction_id",)

    reaction_id: Mapped[uuid.UUID] = parent("allergy_intolerance_reaction")
    manifestation_system, manifestation_code, manifestation_display, manifestation_text = cc(
        "manifestation", required=True, many=True)


# =========================================================================== Observation
class Observation(Base, ClinicalResourceMixin):
    """US Core Observation profiles: vital signs (BP as components), laboratory results,
    smoking status and other social history, surveys, exam findings, point-of-care tests.
    A final result is corrected in place with status 'corrected' / 'amended'; every earlier
    version is kept in fhir_resource_history."""
    __tablename__ = "observation"
    fhir_type = "Observation"
    __fhir_choices__ = {
        "effective": (False, ["effectiveDateTime", "effectivePeriod", "effectiveInstant"]),
        "value": (False, ["valueQuantity", "valueCodeableConcept", "valueString",
                          "valueBoolean", "valueInteger", "valueRange", "valueDateTime"]),
    }
    __extra_args__ = (
        # obs-6: dataAbsentReason SHALL only be present if value[x] is not present
        CheckConstraint("data_absent_reason_code IS NULL OR (value_quantity_value IS NULL AND "
                        "value_codeable_concept_code IS NULL AND value_codeable_concept_text "
                        "IS NULL AND value_string IS NULL AND value_boolean IS NULL AND "
                        "value_integer IS NULL AND value_range_low_value IS NULL AND "
                        "value_range_high_value IS NULL AND value_date_time IS NULL)",
                        name="fhir_obs_6"),
        CheckConstraint(f"status NOT IN {FINAL_RESULT} OR effective_date_time IS NOT NULL OR "
                        "effective_period_start IS NOT NULL OR effective_instant IS NOT NULL",
                        name="final_has_effective"),
        Index("ix_observation_patient_code_time", "subject_patient_id", "code_code",
              "effective_date_time"),
        Index("ix_observation_encounter", "encounter_id"),
    )

    status: Mapped[str] = code("status", ObservationStatus, required=True)
    code_system, code_code, code_display, code_text = cc("code", required=True)
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True)
    encounter_id: Mapped[uuid.UUID | None] = ref("encounter", "encounter", "Encounter")
    based_on_service_request_id: Mapped[uuid.UUID | None] = ref(
        "basedOn", "service_request", "ServiceRequest", index=True, many=True)
    effective_date_time: Mapped[datetime | None] = date_time("effectiveDateTime")
    effective_period_start, effective_period_end = period("effectivePeriod")
    effective_instant: Mapped[datetime | None] = instant("effectiveInstant")
    issued: Mapped[datetime | None] = instant("issued")
    (value_quantity_value, value_quantity_comparator, value_quantity_unit,
     value_quantity_system, value_quantity_code) = quantity("valueQuantity")
    (value_codeable_concept_system, value_codeable_concept_code,
     value_codeable_concept_display, value_codeable_concept_text) = cc("valueCodeableConcept")
    value_string: Mapped[str | None] = string("valueString", None)
    value_boolean: Mapped[bool | None] = boolean("valueBoolean")
    value_integer: Mapped[int | None] = integer("valueInteger")
    (value_range_low_value, value_range_low_unit, value_range_low_code, value_range_high_value,
     value_range_high_unit, value_range_high_code) = frange("valueRange")
    value_date_time: Mapped[datetime | None] = date_time("valueDateTime")
    (data_absent_reason_system, data_absent_reason_code, data_absent_reason_display,
     data_absent_reason_text) = cc("dataAbsentReason")
    body_site_system, body_site_code, body_site_display, body_site_text = cc("bodySite")
    method_system, method_code, method_display, method_text = cc("method")
    specimen_id: Mapped[uuid.UUID | None] = ref("specimen", "specimen", "Specimen")

    category = children("ObservationCategory", "observation_id", None, spread=True)
    coding = children("ObservationCoding", "observation_id", None)
    performer = children("ObservationPerformer", "observation_id", None, spread=True)
    interpretation = children("ObservationInterpretation", "observation_id", None, spread=True)
    reference_range = children("ObservationReferenceRange", "observation_id", "referenceRange")
    has_member = children("ObservationHasMember", "observation_id", None, spread=True,
                          order_by="sequence")
    component = children("ObservationComponent", "observation_id", "component",
                         order_by="sequence")
    note = children("Annotation", "observation_id", "note")


class ObservationCategory(Base, FhirChildMixin):
    """vital-signs | laboratory | social-history | survey | exam | imaging | procedure ..."""
    __tablename__ = "observation_category"
    fhir_parent = ("observation_id",)
    __extra_args__ = (UniqueConstraint("observation_id", "category_system", "category_code"),
                      Index("ix_observation_category_code", "category_code", "observation_id"))

    observation_id: Mapped[uuid.UUID] = parent("observation")
    category_system, category_code, category_display, category_text = cc(
        "category", required=True, many=True)


ObservationCoding = _coding_table("observation_coding", "observation", "observation_id")


class ObservationPerformer(Base, FhirChildMixin):
    __tablename__ = "observation_performer"
    fhir_parent = ("observation_id",)

    observation_id: Mapped[uuid.UUID] = parent("observation")
    practitioner_id: Mapped[uuid.UUID | None] = ref("performer", "practitioner", "Practitioner",
                                                    required=True)
    practitioner_role_id: Mapped[uuid.UUID | None] = ref("performer", "practitioner_role",
                                                         "PractitionerRole", required=True)
    organization_id: Mapped[uuid.UUID | None] = ref("performer", "organization",
                                                    "Organization", required=True)
    patient_id: Mapped[uuid.UUID | None] = ref("performer", "patient", "Patient", required=True)
    related_person_id: Mapped[uuid.UUID | None] = ref("performer", "related_person",
                                                      "RelatedPerson", required=True)


class ObservationInterpretation(Base, FhirChildMixin):
    """N, L, H, LL, HH, A, AA ... (v3 ObservationInterpretation). LL / HH / AA = critical."""
    __tablename__ = "observation_interpretation"
    fhir_parent = ("observation_id",)
    __extra_args__ = (UniqueConstraint("observation_id", "interpretation_code"),
                      Index("ix_observation_interpretation_critical", "observation_id",
                            postgresql_where=text("interpretation_code IN ('LL', 'HH', 'AA')")))

    observation_id: Mapped[uuid.UUID] = parent("observation")
    (interpretation_system, interpretation_code, interpretation_display,
     interpretation_text) = cc("interpretation", required=True, many=True)


class ObservationReferenceRange(Base, FhirChildMixin):
    __tablename__ = "observation_reference_range"
    fhir_parent = ("observation_id",)
    __extra_args__ = (
        # obs-3: must have at least a low or a high or text
        CheckConstraint("low_value IS NOT NULL OR high_value IS NOT NULL OR text IS NOT NULL",
                        name="fhir_obs_3"),
        CheckConstraint("low_value IS NULL OR high_value IS NULL OR low_value <= high_value",
                        name="low_le_high"),
    )

    observation_id: Mapped[uuid.UUID] = parent("observation")
    low_value, low_unit, low_system, low_code = quantity("low", comparator=False,
                                                         fhir_type="SimpleQuantity")
    high_value, high_unit, high_system, high_code = quantity("high", comparator=False,
                                                             fhir_type="SimpleQuantity")
    type_system, type_code, type_display, type_text = cc("type")
    (age_low_value, age_low_unit, age_low_code, age_high_value, age_high_unit,
     age_high_code) = frange("age")
    text: Mapped[str | None] = string("text", 500)


class ObservationHasMember(Base, FhirChildMixin):
    """Panel members (vital-signs panel, lab panels)."""
    __tablename__ = "observation_has_member"
    fhir_parent = ("observation_id",)
    __extra_args__ = (UniqueConstraint("observation_id", "member_observation_id"),
                      CheckConstraint("member_observation_id <> observation_id",
                                      name="not_self"))

    observation_id: Mapped[uuid.UUID] = parent("observation")
    member_observation_id: Mapped[uuid.UUID] = ref("hasMember", "observation", "Observation",
                                                   required=True)
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)


class ObservationComponent(Base, FhirChildMixin):
    """Components (systolic / diastolic BP, multi-part results). One interpretation and one
    reference range are modelled per component."""
    __tablename__ = "observation_component"
    fhir_parent = ("observation_id",)
    __fhir_choices__ = {"value": (False, ["valueQuantity", "valueCodeableConcept",
                                          "valueString", "valueBoolean", "valueInteger"])}
    __fhir_lists__ = {"referenceRange"}
    __extra_args__ = (
        UniqueConstraint("observation_id", "code_system", "code_code"),
        CheckConstraint("data_absent_reason_code IS NULL OR (value_quantity_value IS NULL AND "
                        "value_codeable_concept_code IS NULL AND value_string IS NULL AND "
                        "value_boolean IS NULL AND value_integer IS NULL)", name="fhir_obs_6"),
    )

    observation_id: Mapped[uuid.UUID] = parent("observation")
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    code_system, code_code, code_display, code_text = cc("code", required=True)
    (value_quantity_value, value_quantity_comparator, value_quantity_unit,
     value_quantity_system, value_quantity_code) = quantity("valueQuantity")
    (value_codeable_concept_system, value_codeable_concept_code,
     value_codeable_concept_display, value_codeable_concept_text) = cc("valueCodeableConcept")
    value_string: Mapped[str | None] = string("valueString", 2000)
    value_boolean: Mapped[bool | None] = boolean("valueBoolean")
    value_integer: Mapped[int | None] = integer("valueInteger")
    (data_absent_reason_system, data_absent_reason_code, data_absent_reason_display,
     data_absent_reason_text) = cc("dataAbsentReason")
    (interpretation_system, interpretation_code, interpretation_display,
     interpretation_text) = cc("interpretation", many=True)
    (reference_range_low_value, reference_range_low_unit, reference_range_low_system,
     reference_range_low_code) = quantity("referenceRange.low", comparator=False,
                                          fhir_type="SimpleQuantity")
    (reference_range_high_value, reference_range_high_unit, reference_range_high_system,
     reference_range_high_code) = quantity("referenceRange.high", comparator=False,
                                           fhir_type="SimpleQuantity")
    reference_range_text: Mapped[str | None] = string("referenceRange.text", 500)


# =========================================================================== Procedure
class Procedure(Base, ClinicalResourceMixin):
    """US Core Procedure: procedures performed here and surgical history."""
    __tablename__ = "procedure"
    fhir_type = "Procedure"
    __fhir_choices__ = {"performed": (False, ["performedDateTime", "performedPeriod",
                                              "performedString", "performedAge"])}
    __extra_args__ = (
        CheckConstraint("status <> 'completed' OR performed_date_time IS NOT NULL OR "
                        "performed_period_start IS NOT NULL OR performed_string IS NOT NULL OR "
                        "performed_age_value IS NOT NULL", name="us_core_completed_performed"),
        Index("ix_procedure_patient_time", "subject_patient_id", "performed_date_time"),
    )

    status: Mapped[str] = code("status", EventStatus, required=True)
    status_reason_system, status_reason_code, status_reason_display, status_reason_text = cc(
        "statusReason")
    category_system, category_code, category_display, category_text = cc("category")
    code_system, code_code, code_display, code_text = cc("code", required=True)
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True)
    encounter_id: Mapped[uuid.UUID | None] = ref("encounter", "encounter", "Encounter")
    based_on_service_request_id: Mapped[uuid.UUID | None] = ref(
        "basedOn", "service_request", "ServiceRequest", many=True)
    performed_date_time: Mapped[datetime | None] = date_time("performedDateTime")
    performed_period_start, performed_period_end = period("performedPeriod")
    performed_string: Mapped[str | None] = string("performedString", 200)
    (performed_age_value, performed_age_comparator, performed_age_unit, performed_age_system,
     performed_age_code) = quantity("performedAge", fhir_type="Age")
    recorder_practitioner_id: Mapped[uuid.UUID | None] = ref("recorder", "practitioner",
                                                             "Practitioner")
    recorder_patient_id: Mapped[uuid.UUID | None] = ref("recorder", "patient", "Patient")
    asserter_practitioner_id: Mapped[uuid.UUID | None] = ref("asserter", "practitioner",
                                                             "Practitioner")
    asserter_patient_id: Mapped[uuid.UUID | None] = ref("asserter", "patient", "Patient")
    location_id: Mapped[uuid.UUID | None] = ref("location", "location", "Location")
    outcome_system, outcome_code, outcome_display, outcome_text = cc("outcome")

    coding = children("ProcedureCoding", "procedure_id", None)
    performer = children("ProcedurePerformer", "procedure_id", "performer")
    reason = children("ProcedureReason", "procedure_id", None, spread=True)
    body_site = children("ProcedureBodySite", "procedure_id", None, spread=True)
    note = children("Annotation", "procedure_id", "note")


ProcedureCoding = _coding_table("procedure_coding", "procedure", "procedure_id")


class ProcedurePerformer(Base, FhirChildMixin):
    __tablename__ = "procedure_performer"
    fhir_parent = ("procedure_id",)

    procedure_id: Mapped[uuid.UUID] = parent("procedure")
    function_system, function_code, function_display, function_text = cc("function")
    actor_practitioner_id: Mapped[uuid.UUID | None] = ref("actor", "practitioner",
                                                          "Practitioner", required=True)
    actor_practitioner_role_id: Mapped[uuid.UUID | None] = ref(
        "actor", "practitioner_role", "PractitionerRole", required=True)
    actor_organization_id: Mapped[uuid.UUID | None] = ref("actor", "organization",
                                                          "Organization", required=True)
    actor_patient_id: Mapped[uuid.UUID | None] = ref("actor", "patient", "Patient",
                                                     required=True)
    on_behalf_of_organization_id: Mapped[uuid.UUID | None] = ref("onBehalfOf", "organization",
                                                                 "Organization")


class ProcedureReason(Base, FhirChildMixin):
    __tablename__ = "procedure_reason"
    __fhir_choices__ = {"reason": (True, ["reasonCode", "reasonReference"])}
    fhir_parent = ("procedure_id",)

    procedure_id: Mapped[uuid.UUID] = parent("procedure")
    reason_code_system, reason_code_code, reason_code_display, reason_code_text = cc(
        "reasonCode", many=True)
    condition_id: Mapped[uuid.UUID | None] = ref("reasonReference", "condition", "Condition")
    observation_id: Mapped[uuid.UUID | None] = ref("reasonReference", "observation",
                                                   "Observation")


class ProcedureBodySite(Base, FhirChildMixin):
    __tablename__ = "procedure_body_site"
    fhir_parent = ("procedure_id",)

    procedure_id: Mapped[uuid.UUID] = parent("procedure")
    body_site_system, body_site_code, body_site_display, body_site_text = cc(
        "bodySite", required=True, many=True)


# =========================================================================== FamilyMemberHistory
class FamilyMemberHistory(Base, ClinicalResourceMixin):
    """FR-PAT-03 family history (FHIR FamilyMemberHistory)."""
    __tablename__ = "family_member_history"
    fhir_type = "FamilyMemberHistory"
    __fhir_choices__ = {
        "born": (False, ["bornPeriod", "bornDate", "bornString"]),
        "age": (False, ["ageAge", "ageRange", "ageString"]),
        "deceased": (False, ["deceasedBoolean", "deceasedAge", "deceasedDate",
                             "deceasedString"]),
    }
    __extra_args__ = (
        # fhs-1: can have age[x] or born[x], but not both
        CheckConstraint("NOT ((age_age_value IS NOT NULL OR age_range_low_value IS NOT NULL OR "
                        "age_range_high_value IS NOT NULL OR age_string IS NOT NULL) AND "
                        "(born_period_start IS NOT NULL OR born_date IS NOT NULL OR "
                        "born_string IS NOT NULL))", name="fhir_fhs_1"),
        # fhs-2: can only have estimatedAge if age[x] is present
        CheckConstraint("estimated_age IS NULL OR age_age_value IS NOT NULL OR "
                        "age_range_low_value IS NOT NULL OR age_range_high_value IS NOT NULL OR "
                        "age_string IS NOT NULL", name="fhir_fhs_2"),
    )

    status: Mapped[str] = code("status", FamilyHistoryStatus, required=True)
    (data_absent_reason_system, data_absent_reason_code, data_absent_reason_display,
     data_absent_reason_text) = cc("dataAbsentReason")
    patient_id: Mapped[uuid.UUID] = ref("patient", "patient", "Patient", required=True,
                                        index=True)
    date: Mapped[datetime | None] = date_time("date")
    name: Mapped[str | None] = string("name", 200)
    relationship_system, relationship_code, relationship_display, relationship_text = cc(
        "relationship", required=True)                 # v3 RoleCode: MTH, FTH, SIS ...
    sex_system, sex_code, sex_display, sex_text = cc("sex")
    born_period_start, born_period_end = period("bornPeriod")
    born_date: Mapped[date | None] = fdate("bornDate")
    born_string: Mapped[str | None] = string("bornString", 100)
    age_age_value, age_age_comparator, age_age_unit, age_age_system, age_age_code = quantity(
        "ageAge", fhir_type="Age")
    (age_range_low_value, age_range_low_unit, age_range_low_code, age_range_high_value,
     age_range_high_unit, age_range_high_code) = frange("ageRange")
    age_string: Mapped[str | None] = string("ageString", 100)
    estimated_age: Mapped[bool | None] = boolean("estimatedAge")
    deceased_boolean: Mapped[bool | None] = boolean("deceasedBoolean")
    (deceased_age_value, deceased_age_comparator, deceased_age_unit, deceased_age_system,
     deceased_age_code) = quantity("deceasedAge", fhir_type="Age")
    deceased_date: Mapped[date | None] = fdate("deceasedDate")
    deceased_string: Mapped[str | None] = string("deceasedString", 100)

    condition = children("FamilyMemberHistoryCondition", "family_member_history_id",
                         "condition")
    note = children("Annotation", "family_member_history_id", "note")


class FamilyMemberHistoryCondition(Base, FhirChildMixin):
    __tablename__ = "family_member_history_condition"
    fhir_parent = ("family_member_history_id",)
    __fhir_choices__ = {"onset": (False, ["onsetAge", "onsetRange", "onsetPeriod",
                                          "onsetString"])}

    family_member_history_id: Mapped[uuid.UUID] = parent("family_member_history")
    code_system, code_code, code_display, code_text = cc("code", required=True)
    outcome_system, outcome_code, outcome_display, outcome_text = cc("outcome")
    contributed_to_death: Mapped[bool | None] = boolean("contributedToDeath")
    onset_age_value, onset_age_comparator, onset_age_unit, onset_age_system, onset_age_code = \
        quantity("onsetAge", fhir_type="Age")
    (onset_range_low_value, onset_range_low_unit, onset_range_low_code, onset_range_high_value,
     onset_range_high_unit, onset_range_high_code) = frange("onsetRange")
    onset_period_start, onset_period_end = period("onsetPeriod")
    onset_string: Mapped[str | None] = string("onsetString", 100)


# =========================================================================== Immunization
class Immunization(Base, ClinicalResourceMixin):
    """US Core Immunization - history only (P1); no inventory or administration workflow."""
    __tablename__ = "immunization"
    fhir_type = "Immunization"
    __fhir_choices__ = {"occurrence": (True, ["occurrenceDateTime", "occurrenceString"])}
    __extra_args__ = (
        CheckConstraint("status = 'not-done' OR status_reason_code IS NULL",
                        name="status_reason_only_not_done"),
        CheckConstraint(f"vaccine_code_system IS NULL OR vaccine_code_system IN "
                        f"('{systems.CVX}', '{systems.NDC}', '{systems.V3_NULL_FLAVOR}')",
                        name="vaccine_code_binding"),
        Index("ix_immunization_patient_time", "patient_id", "occurrence_date_time"),
    )

    status: Mapped[str] = code("status", ImmunizationStatus, required=True)
    status_reason_system, status_reason_code, status_reason_display, status_reason_text = cc(
        "statusReason")
    vaccine_code_system, vaccine_code_code, vaccine_code_display, vaccine_code_text = cc(
        "vaccineCode", required=True)
    patient_id: Mapped[uuid.UUID] = ref("patient", "patient", "Patient", required=True)
    encounter_id: Mapped[uuid.UUID | None] = ref("encounter", "encounter", "Encounter")
    occurrence_date_time: Mapped[datetime | None] = date_time("occurrenceDateTime")
    occurrence_string: Mapped[str | None] = string("occurrenceString", 100)
    recorded: Mapped[datetime | None] = date_time("recorded")
    primary_source: Mapped[bool | None] = boolean("primarySource")
    report_origin_system, report_origin_code, report_origin_display, report_origin_text = cc(
        "reportOrigin")
    location_id: Mapped[uuid.UUID | None] = ref("location", "location", "Location")
    manufacturer_organization_id: Mapped[uuid.UUID | None] = ref(
        "manufacturer", "organization", "Organization")
    lot_number: Mapped[str | None] = string("lotNumber", 40)
    expiration_date: Mapped[date | None] = fdate("expirationDate")
    site_system, site_code, site_display, site_text = cc("site")
    route_system, route_code, route_display, route_text = cc("route")
    (dose_quantity_value, dose_quantity_unit, dose_quantity_system,
     dose_quantity_code) = quantity("doseQuantity", comparator=False, fhir_type="SimpleQuantity")

    note = children("Annotation", "immunization_id", "note")
