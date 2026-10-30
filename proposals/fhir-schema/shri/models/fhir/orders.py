"""ServiceRequest (lab, imaging, procedure and referral orders), Specimen, DiagnosticReport.

One ServiceRequest per ordered test (FHIR style); tests sent together share a
``requisition`` identifier and the admin ``lab_requisition`` row. Lab workflow status
(transmitted, collected, partial, final) is ``ext_fulfillment_status`` with history in
``service_request_status_event``. Corrected reports are new versions of the same
DiagnosticReport (status corrected / amended), never silent edits of a final report.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, SmallInteger, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from shri.db.base import Base, ClinicalResourceMixin, FhirChildMixin, enum_type
from shri.db.fhir_types import (attachment, boolean, cc, children, code, date_time, identifier,
                                instant, parent, period, quantity, ref, string)
from shri.models.enums import (DiagnosticReportStatus, OrderFulfillmentStatus, RequestIntent,
                               RequestPriority, RequestStatus, SpecimenStatus)

SIGNED_OR_EXEMPT = ("status IN ('draft', 'revoked', 'entered-in-error') OR "
                    "entry_source IN ('imported', 'interface') OR "
                    "(ext_signed_at IS NOT NULL AND ext_signed_by_practitioner_id IS NOT NULL)")


# =========================================================================== ServiceRequest
class ServiceRequest(Base, ClinicalResourceMixin):
    """US Core ServiceRequest. category laboratory / imaging / procedure / referral (P1)."""
    __tablename__ = "service_request"
    fhir_type = "ServiceRequest"
    __fhir_choices__ = {"occurrence": (False, ["occurrenceDateTime", "occurrencePeriod"])}
    __extra_args__ = (
        CheckConstraint(SIGNED_OR_EXEMPT, name="active_requires_signature"),
        CheckConstraint("status <> 'revoked' OR ext_cancel_reason IS NOT NULL",
                        name="revoked_has_reason"),
        CheckConstraint("ext_duplicate_override_reason IS NULL OR "
                        "length(trim(ext_duplicate_override_reason)) >= 3",
                        name="duplicate_override_reason"),
        UniqueConstraint("tenant_id", "ext_idempotency_key"),
        Index("ix_service_request_patient_status", "subject_patient_id", "status"),
        Index("ix_service_request_requisition", "tenant_id", "requisition_value"),
        Index("ix_service_request_pending", "tenant_id", "ext_fulfillment_status",
              "requester_practitioner_id"),
    )

    status: Mapped[str] = code("status", RequestStatus, required=True,
                               default=RequestStatus.DRAFT)
    intent: Mapped[str] = code("intent", RequestIntent, required=True,
                               default=RequestIntent.ORDER)
    priority: Mapped[str | None] = code("priority", RequestPriority,
                                        default=RequestPriority.ROUTINE)
    do_not_perform: Mapped[bool | None] = boolean("doNotPerform")
    code_system, code_code, code_display, code_text = cc("code", required=True)
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True)
    encounter_id: Mapped[uuid.UUID | None] = ref("encounter", "encounter", "Encounter")
    requisition_system, requisition_value = identifier("requisition")   # placer group number
    occurrence_date_time: Mapped[datetime | None] = date_time("occurrenceDateTime")
    occurrence_period_start, occurrence_period_end = period("occurrencePeriod")
    authored_on: Mapped[datetime | None] = date_time("authoredOn")
    requester_practitioner_id: Mapped[uuid.UUID | None] = ref(
        "requester", "practitioner", "Practitioner", required=True)
    requester_practitioner_role_id: Mapped[uuid.UUID | None] = ref(
        "requester", "practitioner_role", "PractitionerRole", required=True)
    requester_organization_id: Mapped[uuid.UUID | None] = ref(
        "requester", "organization", "Organization", required=True)
    performer_type_system, performer_type_code, performer_type_display, performer_type_text = \
        cc("performerType")
    body_site_system, body_site_code, body_site_display, body_site_text = cc("bodySite",
                                                                             many=True)
    patient_instruction: Mapped[str | None] = string("patientInstruction", 2000)
    # Shri extensions: lab workflow and logistics
    ext_lab_requisition_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("lab_requisition.id"), index=True)
    ext_compendium_test_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("compendium_test.id"))
    ext_fulfillment_status: Mapped[str] = mapped_column(
        enum_type(OrderFulfillmentStatus), nullable=False,
        default=OrderFulfillmentStatus.NOT_SENT.value,
        server_default=OrderFulfillmentStatus.NOT_SENT.value)
    ext_filler_order_number: Mapped[str | None] = mapped_column(String(60))
    ext_signed_at: Mapped[datetime | None]
    ext_signed_by_practitioner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("practitioner.id"))
    ext_signed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
    ext_cancel_reason: Mapped[str | None] = mapped_column(String(500))
    ext_duplicate_override_reason: Mapped[str | None] = mapped_column(String(500))
    ext_idempotency_key: Mapped[str | None] = mapped_column(String(100))

    category = children("ServiceRequestCategory", "service_request_id", None, spread=True)
    coding = children("ServiceRequestCoding", "service_request_id", None)
    performer = children("ServiceRequestPerformer", "service_request_id", None, spread=True)
    reason = children("ServiceRequestReason", "service_request_id", None, spread=True,
                      order_by="rank")
    insurance = children("ServiceRequestInsurance", "service_request_id", None, spread=True)
    specimen = children("ServiceRequestSpecimen", "service_request_id", None, spread=True)
    note = children("Annotation", "service_request_id", "note")


class ServiceRequestCategory(Base, FhirChildMixin):
    """SNOMED 108252007 laboratory, 363679005 imaging, 387713003 procedure, 3457005 referral."""
    __tablename__ = "service_request_category"
    fhir_parent = ("service_request_id",)
    __extra_args__ = (UniqueConstraint("service_request_id", "category_system",
                                       "category_code"),)

    service_request_id: Mapped[uuid.UUID] = parent("service_request")
    category_system, category_code, category_display, category_text = cc(
        "category", required=True, many=True)


class ServiceRequestCoding(Base, FhirChildMixin):
    """Extra codings of ServiceRequest.code (lab order code + LOINC + CPT)."""
    __tablename__ = "service_request_coding"
    fhir_parent = ("service_request_id",)
    fhir_coding_of = "code"
    __extra_args__ = (UniqueConstraint("service_request_id", "system", "code"),)

    service_request_id: Mapped[uuid.UUID] = parent("service_request")
    system: Mapped[str] = mapped_column(String(300), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    display: Mapped[str | None] = mapped_column(String(500))


class ServiceRequestPerformer(Base, FhirChildMixin):
    __tablename__ = "service_request_performer"
    fhir_parent = ("service_request_id",)

    service_request_id: Mapped[uuid.UUID] = parent("service_request")
    organization_id: Mapped[uuid.UUID | None] = ref("performer", "organization",
                                                    "Organization", required=True)
    practitioner_id: Mapped[uuid.UUID | None] = ref("performer", "practitioner",
                                                    "Practitioner", required=True)
    practitioner_role_id: Mapped[uuid.UUID | None] = ref("performer", "practitioner_role",
                                                         "PractitionerRole", required=True)


class ServiceRequestReason(Base, FhirChildMixin):
    """Supporting diagnoses (sent as DG1 in rank order) - drive medical necessity / ABN."""
    __tablename__ = "service_request_reason"
    __fhir_choices__ = {"reason": (True, ["reasonCode", "reasonReference"])}
    fhir_parent = ("service_request_id",)
    __extra_args__ = (UniqueConstraint("service_request_id", "rank"),
                      CheckConstraint("rank BETWEEN 1 AND 12", name="rank_range"))

    service_request_id: Mapped[uuid.UUID] = parent("service_request")
    rank: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    reason_code_system, reason_code_code, reason_code_display, reason_code_text = cc(
        "reasonCode", many=True)
    condition_id: Mapped[uuid.UUID | None] = ref("reasonReference", "condition", "Condition")
    observation_id: Mapped[uuid.UUID | None] = ref("reasonReference", "observation",
                                                   "Observation")


class ServiceRequestInsurance(Base, FhirChildMixin):
    __tablename__ = "service_request_insurance"
    fhir_parent = ("service_request_id",)
    __extra_args__ = (UniqueConstraint("service_request_id", "coverage_id"),)

    service_request_id: Mapped[uuid.UUID] = parent("service_request")
    coverage_id: Mapped[uuid.UUID] = ref("insurance", "coverage", "Coverage", required=True)


class ServiceRequestSpecimen(Base, FhirChildMixin):
    __tablename__ = "service_request_specimen"
    fhir_parent = ("service_request_id",)
    __extra_args__ = (UniqueConstraint("service_request_id", "specimen_id"),)

    service_request_id: Mapped[uuid.UUID] = parent("service_request")
    specimen_id: Mapped[uuid.UUID] = ref("specimen", "specimen", "Specimen", required=True)


# =========================================================================== Specimen
class Specimen(Base, ClinicalResourceMixin):
    """Collected specimen; label barcode unique per tenant (requisition labels)."""
    __tablename__ = "specimen"
    fhir_type = "Specimen"
    __fhir_choices__ = {"collection.collected": (False, ["collection.collectedDateTime",
                                                         "collection.collectedPeriod"])}
    __extra_args__ = (
        UniqueConstraint("tenant_id", "ext_label_barcode"),
        CheckConstraint("ext_container_count IS NULL OR ext_container_count >= 1",
                        name="container_count"),
        CheckConstraint("status IS DISTINCT FROM 'available' OR "
                        "collection_collected_date_time IS NOT NULL OR "
                        "collection_collected_period_start IS NOT NULL", name="available_collected"),
    )

    accession_identifier_system, accession_identifier_value = identifier("accessionIdentifier")
    status: Mapped[str | None] = code("status", SpecimenStatus)
    type_system, type_code, type_display, type_text = cc("type")
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True,
                                                index=True)
    received_time: Mapped[datetime | None] = date_time("receivedTime")
    collection_collector_practitioner_id: Mapped[uuid.UUID | None] = ref(
        "collection.collector", "practitioner", "Practitioner")
    collection_collected_date_time: Mapped[datetime | None] = date_time(
        "collection.collectedDateTime")
    (collection_collected_period_start,
     collection_collected_period_end) = period("collection.collectedPeriod")
    (collection_quantity_value, collection_quantity_unit, collection_quantity_system,
     collection_quantity_code) = quantity("collection.quantity", comparator=False,
                                          fhir_type="SimpleQuantity")
    (collection_method_system, collection_method_code, collection_method_display,
     collection_method_text) = cc("collection.method")
    (collection_body_site_system, collection_body_site_code, collection_body_site_display,
     collection_body_site_text) = cc("collection.bodySite")
    (collection_fasting_status_system, collection_fasting_status_code,
     collection_fasting_status_display, collection_fasting_status_text) = cc(
        "collection.fastingStatusCodeableConcept")
    ext_label_barcode: Mapped[str | None] = mapped_column(String(60))
    ext_container_count: Mapped[int | None] = mapped_column(SmallInteger)
    ext_manifest_number: Mapped[str | None] = mapped_column(String(40))

    note = children("Annotation", "specimen_id", "note")


# =========================================================================== DiagnosticReport
class DiagnosticReport(Base, ClinicalResourceMixin):
    """US Core DiagnosticReport (lab, imaging report). Release to the patient is always a
    human action (released_by)."""
    __tablename__ = "diagnostic_report"
    fhir_type = "DiagnosticReport"
    __fhir_choices__ = {"effective": (False, ["effectiveDateTime", "effectivePeriod"])}
    __extra_args__ = (
        CheckConstraint("ext_released_to_patient_at IS NULL OR "
                        "ext_released_by_user_id IS NOT NULL", name="release_has_releaser"),
        CheckConstraint("status NOT IN ('final', 'amended', 'corrected', 'appended') OR "
                        "issued IS NOT NULL", name="final_has_issued"),
        Index("ix_diagnostic_report_patient_issued", "subject_patient_id", "issued"),
        Index("ix_diagnostic_report_filler", "tenant_id", "ext_filler_order_number"),
    )

    status: Mapped[str] = code("status", DiagnosticReportStatus, required=True)
    code_system, code_code, code_display, code_text = cc("code", required=True)
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True)
    encounter_id: Mapped[uuid.UUID | None] = ref("encounter", "encounter", "Encounter")
    effective_date_time: Mapped[datetime | None] = date_time("effectiveDateTime")
    effective_period_start, effective_period_end = period("effectivePeriod")
    issued: Mapped[datetime | None] = instant("issued")
    conclusion: Mapped[str | None] = string("conclusion", None)
    # Shri extensions
    ext_lab_provider_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("lab_provider.id"))
    ext_filler_order_number: Mapped[str | None] = mapped_column(String(60))
    ext_released_to_patient_at: Mapped[datetime | None]
    ext_released_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
    ext_inbound_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("integration_message.id"))

    category = children("DiagnosticReportCategory", "diagnostic_report_id", None, spread=True)
    coding = children("DiagnosticReportCoding", "diagnostic_report_id", None)
    based_on = children("DiagnosticReportBasedOn", "diagnostic_report_id", None, spread=True)
    performer = children("DiagnosticReportPerformer", "diagnostic_report_id", None,
                         spread=True)
    specimen = children("DiagnosticReportSpecimen", "diagnostic_report_id", None, spread=True)
    result = children("DiagnosticReportResult", "diagnostic_report_id", None, spread=True,
                      order_by="sequence")
    presented_form = children("DiagnosticReportPresentedForm", "diagnostic_report_id",
                              "presentedForm")


class DiagnosticReportCategory(Base, FhirChildMixin):
    """v2-0074 LAB / RAD ..., LOINC note categories."""
    __tablename__ = "diagnostic_report_category"
    fhir_parent = ("diagnostic_report_id",)
    __extra_args__ = (UniqueConstraint("diagnostic_report_id", "category_system",
                                       "category_code"),)

    diagnostic_report_id: Mapped[uuid.UUID] = parent("diagnostic_report")
    category_system, category_code, category_display, category_text = cc(
        "category", required=True, many=True)


class DiagnosticReportCoding(Base, FhirChildMixin):
    __tablename__ = "diagnostic_report_coding"
    fhir_parent = ("diagnostic_report_id",)
    fhir_coding_of = "code"
    __extra_args__ = (UniqueConstraint("diagnostic_report_id", "system", "code"),)

    diagnostic_report_id: Mapped[uuid.UUID] = parent("diagnostic_report")
    system: Mapped[str] = mapped_column(String(300), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    display: Mapped[str | None] = mapped_column(String(500))


class DiagnosticReportBasedOn(Base, FhirChildMixin):
    __tablename__ = "diagnostic_report_based_on"
    fhir_parent = ("diagnostic_report_id",)
    __extra_args__ = (UniqueConstraint("diagnostic_report_id", "service_request_id"),
                      Index("ix_diagnostic_report_based_on_sr", "service_request_id"))

    diagnostic_report_id: Mapped[uuid.UUID] = parent("diagnostic_report")
    service_request_id: Mapped[uuid.UUID] = ref("basedOn", "service_request", "ServiceRequest",
                                                required=True)


class DiagnosticReportPerformer(Base, FhirChildMixin):
    """performer and resultsInterpreter (``ext_is_interpreter``)."""
    __tablename__ = "diagnostic_report_performer"
    fhir_parent = ("diagnostic_report_id",)

    diagnostic_report_id: Mapped[uuid.UUID] = parent("diagnostic_report")
    organization_id: Mapped[uuid.UUID | None] = ref("performer", "organization",
                                                    "Organization", required=True)
    practitioner_id: Mapped[uuid.UUID | None] = ref("performer", "practitioner",
                                                    "Practitioner", required=True)
    practitioner_role_id: Mapped[uuid.UUID | None] = ref("performer", "practitioner_role",
                                                         "PractitionerRole", required=True)


class DiagnosticReportSpecimen(Base, FhirChildMixin):
    __tablename__ = "diagnostic_report_specimen"
    fhir_parent = ("diagnostic_report_id",)
    __extra_args__ = (UniqueConstraint("diagnostic_report_id", "specimen_id"),)

    diagnostic_report_id: Mapped[uuid.UUID] = parent("diagnostic_report")
    specimen_id: Mapped[uuid.UUID] = ref("specimen", "specimen", "Specimen", required=True)


class DiagnosticReportResult(Base, FhirChildMixin):
    """Result observations in report order (OBX sequence)."""
    __tablename__ = "diagnostic_report_result"
    fhir_parent = ("diagnostic_report_id",)
    __extra_args__ = (UniqueConstraint("diagnostic_report_id", "observation_id"),
                      Index("ix_diagnostic_report_result_obs", "observation_id"))

    diagnostic_report_id: Mapped[uuid.UUID] = parent("diagnostic_report")
    observation_id: Mapped[uuid.UUID] = ref("result", "observation", "Observation",
                                            required=True)
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)


class DiagnosticReportPresentedForm(Base, FhirChildMixin):
    """The lab's PDF / rendered report."""
    __tablename__ = "diagnostic_report_presented_form"
    fhir_parent = ("diagnostic_report_id",)

    diagnostic_report_id: Mapped[uuid.UUID] = parent("diagnostic_report")
    content_type, binary_object_id, title, creation = attachment(".", required=True)
