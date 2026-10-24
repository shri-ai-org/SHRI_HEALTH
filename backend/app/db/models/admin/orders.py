"""Lab connectivity, compendium, requisitions, ABN / medical necessity, order status history,
result acknowledgement and the unmatched-result queue (FR-ORD-01, FR-ORD-02).

The clinical order itself is the FHIR ServiceRequest (one row per ordered test); the
requisition that groups tests for one lab is the admin ``lab_requisition``.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (Boolean, CheckConstraint, ForeignKey, ForeignKeyConstraint, Index, Integer, Numeric,
                        SmallInteger, String, Text, UniqueConstraint, text)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import AdminMixin, Base, TenantMixin, VersionedMixin, enum_type
from app.db.models.enums import (AbnOption, AnswerType, BillTo, CollectionMode,
                               LabConnectionType, MedicalNecessityOutcome,
                               OrderFulfillmentStatus, PayerType, ResultAckAction,
                               UnmatchedReason, UnmatchedResultStatus)


class LabProvider(Base, AdminMixin, VersionedMixin):
    """A performing lab connected to this practice (Quest, Labcorp, regional lab)."""
    __tablename__ = "lab_provider"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code"),
        CheckConstraint("clia_number IS NULL OR clia_number ~ '^[0-9]{2}D[0-9]{7}$'",
                        name="clia_format"),
    )

    code: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    organization_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.organization.id"))
    connection_type: Mapped[LabConnectionType] = mapped_column(enum_type(LabConnectionType),
                                                               nullable=False)
    integration_endpoint_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.integration_endpoint.id"))
    clia_number: Mapped[str | None] = mapped_column(String(10))
    local_code_system: Mapped[str | None] = mapped_column(
        ForeignKey("admin.code_system.uri", onupdate="CASCADE"))   # lab's own order/result codes
    supports_electronic_orders: Mapped[bool] = mapped_column(Boolean, nullable=False,
                                                             default=True)
    supports_electronic_results: Mapped[bool] = mapped_column(Boolean, nullable=False,
                                                              default=True)
    requisition_format: Mapped[str | None] = mapped_column(String(40))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class LabAccount(Base, AdminMixin, VersionedMixin):
    """Client account number at a lab, per facility."""
    __tablename__ = "lab_account"
    __table_args__ = (UniqueConstraint("lab_provider_id", "facility_id", "account_number"),
                      Index("uq_lab_account_one_default", "lab_provider_id", "facility_id",
                            unique=True, postgresql_where=text("is_default")))

    lab_provider_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.lab_provider.id"),
                                                       nullable=False)
    facility_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.facility.id"), nullable=False)
    account_number: Mapped[str] = mapped_column(String(40), nullable=False)
    business_unit: Mapped[str | None] = mapped_column(String(40))
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class LabAccountBillTo(Base, TenantMixin):
    """Bill-to types allowed on an account (replaces an array column)."""
    __tablename__ = "lab_account_bill_to"

    lab_account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.lab_account.id", ondelete="CASCADE"), primary_key=True)
    bill_to: Mapped[BillTo] = mapped_column(enum_type(BillTo), primary_key=True)


class CompendiumTest(Base, AdminMixin):
    """Orderable test from a lab's compendium (refreshed on a schedule)."""
    __tablename__ = "compendium_test"
    __table_args__ = (
        UniqueConstraint("lab_provider_id", "business_unit", "test_code"),
        CheckConstraint("effective_to IS NULL OR effective_from IS NULL "
                        "OR effective_to >= effective_from", name="period"),
        Index("ix_compendium_test_name_trgm", "test_name", postgresql_using="gin",
              postgresql_ops={"test_name": "gin_trgm_ops"}),
    )

    lab_provider_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.lab_provider.id"),
                                                       nullable=False)
    business_unit: Mapped[str] = mapped_column(String(40), nullable=False, default="*",
                                               server_default="*")
    test_code: Mapped[str] = mapped_column(String(40), nullable=False)
    test_name: Mapped[str] = mapped_column(String(300), nullable=False)
    is_panel: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    specimen_type: Mapped[str | None] = mapped_column(String(100))
    container: Mapped[str | None] = mapped_column(String(100))
    transport_temperature: Mapped[str | None] = mapped_column(String(40))
    requires_fasting: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    compendium_version: Mapped[str | None] = mapped_column(String(40))
    effective_from: Mapped[date | None]
    effective_to: Mapped[date | None]
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class CompendiumTestCode(Base, AdminMixin):
    """Standard codes for a test (LOINC result codes, CPT billing codes)."""
    __tablename__ = "compendium_test_code"
    __table_args__ = (UniqueConstraint("compendium_test_id", "code_system", "code"),)

    compendium_test_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.compendium_test.id", ondelete="CASCADE"), nullable=False)
    code_system: Mapped[str] = mapped_column(ForeignKey("admin.code_system.uri", onupdate="CASCADE"),
                                             nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    display: Mapped[str | None] = mapped_column(String(500))


class CompendiumPanelMember(Base, AdminMixin):
    __tablename__ = "compendium_panel_member"
    __table_args__ = (
        UniqueConstraint("panel_test_id", "member_test_id"),
        CheckConstraint("panel_test_id <> member_test_id", name="not_self"),
    )

    panel_test_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.compendium_test.id", ondelete="CASCADE"), nullable=False)
    member_test_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.compendium_test.id"),
                                                      nullable=False)
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)


class CompendiumAoeQuestion(Base, AdminMixin):
    """Ask-at-order-entry question for a test."""
    __tablename__ = "compendium_aoe_question"
    __table_args__ = (UniqueConstraint("compendium_test_id", "question_code"),
                      UniqueConstraint("id", "answer_type"))   # answer type pinned on answers

    compendium_test_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.compendium_test.id", ondelete="CASCADE"), nullable=False)
    question_code: Mapped[str] = mapped_column(String(40), nullable=False)
    prompt: Mapped[str] = mapped_column(String(500), nullable=False)
    answer_type: Mapped[AnswerType] = mapped_column(enum_type(AnswerType), nullable=False)
    loinc_code: Mapped[str | None] = mapped_column(String(20))
    is_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)


class CompendiumAoeOption(Base, AdminMixin):
    __tablename__ = "compendium_aoe_option"
    __table_args__ = (UniqueConstraint("question_id", "code"),
                      UniqueConstraint("id", "question_id"))

    question_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.compendium_aoe_question.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    display: Mapped[str] = mapped_column(String(300), nullable=False)
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)


class CompendiumCoveredDiagnosis(Base, AdminMixin):
    """Medical-necessity rules: diagnoses that support coverage of a test under a policy
    (Medicare NCD / LCD). Used for the ABN prompt."""
    __tablename__ = "compendium_covered_diagnosis"
    __table_args__ = (UniqueConstraint("compendium_test_id", "policy_id", "icd10_code"),)

    compendium_test_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.compendium_test.id", ondelete="CASCADE"), nullable=False)
    payer_type: Mapped[PayerType] = mapped_column(enum_type(PayerType), nullable=False,
                                                  default=PayerType.MEDICARE.value)
    policy_id: Mapped[str] = mapped_column(String(40), nullable=False)    # NCD 190.23, L34914
    icd10_code: Mapped[str] = mapped_column(String(10), nullable=False)
    frequency_limit: Mapped[str | None] = mapped_column(String(100))


class LabRequisition(Base, AdminMixin):
    """One requisition sent to one lab; groups the ServiceRequests (tests) it carries via
    ``service_request.requisition_value``/``ext_lab_requisition_id``."""
    __tablename__ = "lab_requisition"
    __table_args__ = (
        UniqueConstraint("tenant_id", "requisition_number"),
        UniqueConstraint("tenant_id", "idempotency_key"),
        UniqueConstraint("id", "patient_id"),
        CheckConstraint("bill_to <> 'insurance' OR coverage_id IS NOT NULL",
                        name="insurance_needs_coverage"),
        CheckConstraint("transmitted_at IS NULL OR acknowledged_at IS NULL "
                        "OR acknowledged_at >= transmitted_at", name="ack_after_send"),
    )

    requisition_number: Mapped[str] = mapped_column(String(40), nullable=False)  # placer group
    lab_provider_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.lab_provider.id"),
                                                       nullable=False)
    lab_account_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.lab_account.id"))
    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"), nullable=False,
                                                  index=True)
    encounter_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.encounter.id"))
    ordering_practitioner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.practitioner.id"),
                                                                nullable=False)
    facility_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.facility.id"), nullable=False)
    bill_to: Mapped[BillTo] = mapped_column(enum_type(BillTo), nullable=False,
                                            default=BillTo.INSURANCE.value)
    coverage_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.coverage.id"))
    collection_mode: Mapped[CollectionMode] = mapped_column(enum_type(CollectionMode),
                                                            nullable=False,
                                                            default=CollectionMode.IN_OFFICE.value)
    is_fasting: Mapped[bool | None] = mapped_column(Boolean)
    scheduled_collection_at: Mapped[datetime | None]
    fulfillment_status: Mapped[OrderFulfillmentStatus] = mapped_column(
        enum_type(OrderFulfillmentStatus), nullable=False,
        default=OrderFulfillmentStatus.NOT_SENT.value,
        server_default=OrderFulfillmentStatus.NOT_SENT.value)
    transmitted_at: Mapped[datetime | None]
    acknowledged_at: Mapped[datetime | None]
    outbound_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.integration_message.id"))
    requisition_document_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.document_reference.id"))
    idempotency_key: Mapped[str | None] = mapped_column(String(100))


class ServiceRequestAoeAnswer(Base, AdminMixin):
    """Answer to an AOE question on one ordered test. The answer column must match the
    question's answer type (composite FK pins the type; CHECK picks the column)."""
    __tablename__ = "service_request_aoe_answer"
    __table_args__ = (
        UniqueConstraint("service_request_id", "question_id"),
        CheckConstraint(
            "num_nonnulls(value_string, value_decimal, value_integer, value_date, value_boolean, "
            "value_option_id) = 1", name="one_value"),
        CheckConstraint(
            "(answer_type = 'string' AND value_string IS NOT NULL) OR "
            "(answer_type = 'decimal' AND value_decimal IS NOT NULL) OR "
            "(answer_type = 'integer' AND value_integer IS NOT NULL) OR "
            "(answer_type = 'date' AND value_date IS NOT NULL) OR "
            "(answer_type = 'boolean' AND value_boolean IS NOT NULL) OR "
            "(answer_type = 'choice' AND value_option_id IS NOT NULL)", name="value_matches_type"),
        ForeignKeyConstraint(["question_id", "answer_type"],
                             ["admin.compendium_aoe_question.id", "admin.compendium_aoe_question.answer_type"],
                             name="fk_service_request_aoe_answer_question_type"),
        ForeignKeyConstraint(["value_option_id", "question_id"],
                             ["admin.compendium_aoe_option.id", "admin.compendium_aoe_option.question_id"],
                             name="fk_service_request_aoe_answer_option_question"),
    )

    service_request_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clinical.service_request.id", ondelete="CASCADE"), nullable=False, index=True)
    question_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.compendium_aoe_question.id"),
                                                   nullable=False)
    answer_type: Mapped[AnswerType] = mapped_column(enum_type(AnswerType), nullable=False)
    value_string: Mapped[str | None] = mapped_column(String(500))
    value_decimal: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    value_integer: Mapped[int | None] = mapped_column(Integer)
    value_date: Mapped[date | None]
    value_boolean: Mapped[bool | None] = mapped_column(Boolean)
    value_option_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.compendium_aoe_option.id"))


class MedicalNecessityCheck(Base, AdminMixin):
    """Result of checking a test's diagnoses against coverage policy (Medicare)."""
    __tablename__ = "medical_necessity_check"

    service_request_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clinical.service_request.id"), nullable=False, index=True)
    coverage_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.coverage.id"))
    outcome: Mapped[MedicalNecessityOutcome] = mapped_column(enum_type(MedicalNecessityOutcome),
                                                             nullable=False)
    policy_id: Mapped[str | None] = mapped_column(String(40))
    message: Mapped[str | None] = mapped_column(String(500))
    checked_at: Mapped[datetime] = mapped_column(nullable=False)


class AbnNotice(Base, AdminMixin):
    """Advance Beneficiary Notice (CMS-R-131) for a test that may not be covered."""
    __tablename__ = "abn_notice"
    __table_args__ = (
        CheckConstraint("(signed_at IS NULL) = (option_selected IS NULL)",
                        name="signed_has_option"),
        CheckConstraint("signed_at IS NULL OR signed_document_id IS NOT NULL OR "
                        "patient_refused_to_sign", name="signed_has_document"),
    )

    service_request_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clinical.service_request.id"), nullable=False, unique=True)
    medical_necessity_check_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.medical_necessity_check.id"))
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    estimated_cost: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    option_selected: Mapped[AbnOption | None] = mapped_column(enum_type(AbnOption))
    signed_at: Mapped[datetime | None]
    patient_refused_to_sign: Mapped[bool] = mapped_column(Boolean, nullable=False,
                                                          default=False)
    signed_document_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.document_reference.id"))


class ServiceRequestStatusEvent(Base, AdminMixin):
    """Order status history (transmitted, acknowledged, collected, partial, final ...)."""
    __tablename__ = "service_request_status_event"
    __table_args__ = (Index("ix_sr_status_event_time", "service_request_id", "occurred_at"),)

    service_request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.service_request.id"),
                                                          nullable=False)
    fulfillment_status: Mapped[OrderFulfillmentStatus] = mapped_column(
        enum_type(OrderFulfillmentStatus), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(nullable=False)
    integration_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.integration_message.id"))
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    note: Mapped[str | None] = mapped_column(String(500))


class ResultAcknowledgement(Base, AdminMixin):
    """Clinician review of a report (several reviewers allowed; insert-only)."""
    __tablename__ = "result_acknowledgement"

    diagnostic_report_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.diagnostic_report.id"),
                                                            nullable=False, index=True)
    report_version_id: Mapped[int] = mapped_column(Integer, nullable=False)  # version reviewed
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.app_user.id"), nullable=False)
    action: Mapped[ResultAckAction] = mapped_column(enum_type(ResultAckAction), nullable=False)
    comment: Mapped[str | None] = mapped_column(Text)
    acknowledged_at: Mapped[datetime] = mapped_column(nullable=False)


class UnmatchedResult(Base, AdminMixin):
    """Inbound result not linked to a patient and/or order. Never filed automatically."""
    __tablename__ = "unmatched_result"
    __table_args__ = (
        Index("ix_unmatched_result_open", "tenant_id", "status"),
        CheckConstraint("status <> 'matched' OR (matched_patient_id IS NOT NULL AND "
                        "resulting_report_id IS NOT NULL)", name="matched_is_complete"),
        CheckConstraint("(status = 'open') = (resolved_at IS NULL)", name="resolved_time"),
        CheckConstraint("(resolved_at IS NULL) = (resolved_by_user_id IS NULL)",
                        name="resolved_by"),
    )

    inbound_message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.integration_message.id"),
                                                          nullable=False, unique=True)
    lab_provider_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.lab_provider.id"))
    reason: Mapped[UnmatchedReason] = mapped_column(enum_type(UnmatchedReason), nullable=False)
    received_family_name: Mapped[str | None] = mapped_column(String(100))
    received_given_name: Mapped[str | None] = mapped_column(String(100))
    received_birth_date: Mapped[date | None]
    received_sex: Mapped[str | None] = mapped_column(String(10))
    received_patient_identifier: Mapped[str | None] = mapped_column(String(100))
    received_placer_order_number: Mapped[str | None] = mapped_column(String(60))
    received_filler_order_number: Mapped[str | None] = mapped_column(String(60))
    status: Mapped[UnmatchedResultStatus] = mapped_column(
        enum_type(UnmatchedResultStatus), nullable=False,
        default=UnmatchedResultStatus.OPEN.value, server_default=UnmatchedResultStatus.OPEN.value)
    matched_patient_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.patient.id"))
    matched_service_request_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.service_request.id"))
    resulting_report_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.diagnostic_report.id"))
    resolved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    resolved_at: Mapped[datetime | None]
    resolution_note: Mapped[str | None] = mapped_column(String(500))


class UnmatchedResultCandidate(Base, AdminMixin):
    __tablename__ = "unmatched_result_candidate"
    __table_args__ = (
        UniqueConstraint("unmatched_result_id", "patient_id"),
        CheckConstraint("score BETWEEN 0 AND 1", name="score_range"),
    )

    unmatched_result_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.unmatched_result.id", ondelete="CASCADE"), nullable=False)
    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"), nullable=False)
    score: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False)
