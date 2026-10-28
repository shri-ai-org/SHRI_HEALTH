"""Consent, Coverage, Provenance and the FHIR version history store."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    Base,
    ClinicalResourceMixin,
    FhirChildMixin,
    FhirResourceMixin,
    TenantMixin,
    enum_type,
)
from app.db.fhir_types import (
    attachment,
    boolean,
    cc,
    children,
    code,
    date_period,
    date_time,
    instant,
    integer,
    money,
    parent,
    period,
    prim,
    ref,
    string,
)
from app.db.models import systems
from app.db.models.enums import (
    ConsentKind,
    ConsentProvisionType,
    ConsentState,
    CoverageClassType,
    FinancialResourceStatus,
    ProvenanceEntityRole,
    SignatureMethod,
    SubscriberRelationship,
)


# =========================================================================== Consent
class Consent(Base, ClinicalResourceMixin):
    """Treatment consent, privacy-notice acknowledgement, ambient-recording consent (AI-01),
    telehealth, research ... ``ext_kind`` is the Shri consent category (also emitted as a
    category coding) and lets other tables pin the kind of consent they require."""
    __tablename__ = "consent"
    fhir_type = "Consent"
    __fhir_choices__ = {"source": (False, ["sourceAttachment", "sourceReference"])}
    __extra_args__ = (
        UniqueConstraint("id", "ext_kind"),
        CheckConstraint("status <> 'active' OR date_time IS NOT NULL", name="active_has_date"),
        CheckConstraint("provision_period_end IS NULL OR provision_period_start IS NULL OR "
                        "provision_period_end >= provision_period_start", name="period_order"),
        CheckConstraint("status <> 'active' OR ext_signature_method IS NOT NULL",
                        name="active_has_method"),
        Index("ix_consent_patient_kind", "patient_id", "ext_kind", "status"),
    )

    status: Mapped[str] = code("status", ConsentState, required=True)
    scope_system, scope_code, scope_display, scope_text = cc("scope", required=True)
    patient_id: Mapped[uuid.UUID] = ref("patient", "patient", "Patient", required=True)
    date_time: Mapped[datetime | None] = date_time("dateTime")
    (source_attachment_content_type, source_attachment_binary_object_id,
     source_attachment_title, source_attachment_creation) = attachment("sourceAttachment")
    source_document_reference_id: Mapped[uuid.UUID | None] = ref(
        "sourceReference", "document_reference", "DocumentReference")
    policy_rule_system, policy_rule_code, policy_rule_display, policy_rule_text = cc(
        "policyRule")
    provision_type: Mapped[str | None] = code("provision.type", ConsentProvisionType,
                                              default=ConsentProvisionType.PERMIT)
    provision_period_start, provision_period_end = period("provision.period")
    ext_kind: Mapped[str] = mapped_column(enum_type(ConsentKind), nullable=False)
    ext_signature_method: Mapped[str | None] = mapped_column(enum_type(SignatureMethod))
    ext_policy_version: Mapped[str | None] = mapped_column(String(40))
    ext_grantor_related_person_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.related_person.id"))       # guardian consenting for a minor

    category = children("ConsentCategory", "consent_id", None, spread=True)
    performer = children("ConsentPerformer", "consent_id", None, spread=True)
    verification = children("ConsentVerification", "consent_id", "verification")


class ConsentCategory(Base, FhirChildMixin):
    __tablename__ = "consent_category"
    fhir_parent = ("consent_id",)
    __extra_args__ = (UniqueConstraint("consent_id", "category_system", "category_code"),)

    consent_id: Mapped[uuid.UUID] = parent("consent")
    category_system, category_code, category_display, category_text = cc(
        "category", required=True, many=True)


class ConsentPerformer(Base, FhirChildMixin):
    __tablename__ = "consent_performer"
    fhir_parent = ("consent_id",)

    consent_id: Mapped[uuid.UUID] = parent("consent")
    patient_id: Mapped[uuid.UUID | None] = ref("performer", "patient", "Patient", required=True)
    related_person_id: Mapped[uuid.UUID | None] = ref("performer", "related_person",
                                                      "RelatedPerson", required=True)
    practitioner_id: Mapped[uuid.UUID | None] = ref("performer", "practitioner",
                                                    "Practitioner", required=True)
    organization_id: Mapped[uuid.UUID | None] = ref("performer", "organization",
                                                    "Organization", required=True)


class ConsentVerification(Base, FhirChildMixin):
    __tablename__ = "consent_verification"
    fhir_parent = ("consent_id",)

    consent_id: Mapped[uuid.UUID] = parent("consent")
    verified: Mapped[bool] = boolean("verified", required=True)
    verified_with_patient_id: Mapped[uuid.UUID | None] = ref("verifiedWith", "patient",
                                                             "Patient")
    verified_with_related_person_id: Mapped[uuid.UUID | None] = ref(
        "verifiedWith", "related_person", "RelatedPerson")
    verification_date: Mapped[datetime | None] = date_time("verificationDate")


# =========================================================================== Coverage
class Coverage(Base, ClinicalResourceMixin):
    """US Core Coverage: a patient's insurance, in priority order (``order``). Member ID is an
    identifier (type MB); group number and plan name are coverage_class rows. Card images
    (front / back) are coverage_card_image rows. entry_source 'ai-generated' when captured by
    card OCR (P1). At most one active coverage per patient per order."""
    __tablename__ = "coverage"
    fhir_type = "Coverage"
    __extra_args__ = (
        CheckConstraint('"order" IS NULL OR "order" BETWEEN 1 AND 9', name="order_range"),
        Index("uq_coverage_active_order", "beneficiary_patient_id", "order", unique=True,
              postgresql_where=text("status = 'active'")),
        CheckConstraint("relationship_code <> 'self' OR subscriber_related_person_id IS NULL",
                        name="self_has_no_related_subscriber"),
        CheckConstraint("period_end IS NULL OR period_start IS NULL OR period_end >= period_start",
                        name="period_order"),
    )

    status: Mapped[str] = code("status", FinancialResourceStatus, required=True)
    type_system, type_code, type_display, type_text = cc("type")   # SOP payer typology
    policy_holder_patient_id: Mapped[uuid.UUID | None] = ref("policyHolder", "patient",
                                                             "Patient")
    policy_holder_related_person_id: Mapped[uuid.UUID | None] = ref(
        "policyHolder", "related_person", "RelatedPerson")
    subscriber_patient_id: Mapped[uuid.UUID | None] = ref("subscriber", "patient", "Patient")
    subscriber_related_person_id: Mapped[uuid.UUID | None] = ref(
        "subscriber", "related_person", "RelatedPerson")
    subscriber_id: Mapped[str | None] = string("subscriberId", 80)
    beneficiary_patient_id: Mapped[uuid.UUID] = ref("beneficiary", "patient", "Patient",
                                                    required=True)
    dependent: Mapped[str | None] = string("dependent", 20)
    relationship_code: Mapped[str | None] = mapped_column(
        enum_type(SubscriberRelationship),
        info={"fhir": "relationship", "fhir_type": "CodeableConcept", "part": "code",
              "fixed_system": systems.SUBSCRIBER_RELATIONSHIP})
    period_start, period_end = date_period("period")
    order: Mapped[int | None] = integer("order", fhir_type="positiveInt")
    network: Mapped[str | None] = string("network", 200)
    ext_accept_assignment: Mapped[bool] = mapped_column(nullable=False, default=True,
                                                        server_default=text("true"))

    identifier = children("Identifier", "coverage_id", "identifier")
    payor = children("CoveragePayor", "coverage_id", None, spread=True)
    class_ = children("CoverageClass", "coverage_id", "class")
    cost_to_beneficiary = children("CoverageCostToBeneficiary", "coverage_id",
                                   "costToBeneficiary")
    card_image = children("CoverageCardImage", "coverage_id", None)


class CoveragePayor(Base, FhirChildMixin):
    """Coverage.payor (1..*): the payer, or the patient / related person for self-pay."""
    __tablename__ = "coverage_payor"
    fhir_parent = ("coverage_id",)

    coverage_id: Mapped[uuid.UUID] = parent("coverage")
    payer_id: Mapped[uuid.UUID | None] = ref("payor", "payer", "Organization", required=True)
    organization_id: Mapped[uuid.UUID | None] = ref("payor", "organization", "Organization",
                                                    required=True)
    patient_id: Mapped[uuid.UUID | None] = ref("payor", "patient", "Patient", required=True)
    related_person_id: Mapped[uuid.UUID | None] = ref("payor", "related_person",
                                                      "RelatedPerson", required=True)


class CoverageClass(Base, FhirChildMixin):
    __tablename__ = "coverage_class"
    fhir_parent = ("coverage_id",)
    __extra_args__ = (UniqueConstraint("coverage_id", "type"),)

    coverage_id: Mapped[uuid.UUID] = parent("coverage")
    type: Mapped[str] = mapped_column(
        enum_type(CoverageClassType), nullable=False,
        info={"fhir": "type", "fhir_type": "CodeableConcept", "part": "code", "required": True,
              "fixed_system": systems.COVERAGE_CLASS})
    value: Mapped[str] = string("value", 80, required=True)
    name: Mapped[str | None] = string("name", 200)


class CoverageCostToBeneficiary(Base, FhirChildMixin):
    """Copay / coinsurance known from the card or the last eligibility response."""
    __tablename__ = "coverage_cost_to_beneficiary"
    fhir_parent = ("coverage_id",)
    __extra_args__ = (CheckConstraint("value_money_value IS NULL OR value_money_value >= 0",
                                      name="money_non_negative"),)

    coverage_id: Mapped[uuid.UUID] = parent("coverage")
    type_system, type_code, type_display, type_text = cc("type")   # coverage-copay-type
    value_money_value, value_money_currency = money("valueMoney", required=True)


class CoverageCardImage(Base, FhirChildMixin):
    """Insurance card images (FR-PAT-01: both sides)."""
    __tablename__ = "coverage_card_image"
    fhir_parent = ("coverage_id",)
    __extra_args__ = (UniqueConstraint("coverage_id", "side"),
                      CheckConstraint("side IN ('front', 'back')", name="side_code"))

    coverage_id: Mapped[uuid.UUID] = parent("coverage")
    side: Mapped[str] = mapped_column(String(5), nullable=False)
    binary_object_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.binary_object.id"),
                                                        nullable=False)


# =========================================================================== Provenance
class Provenance(Base, FhirResourceMixin):
    """FHIR Provenance for significant activities: sign, co-sign, amend, import, AI accept.
    ``target_*`` names a resource version; existence of the target is checked by trigger
    (a polymorphic target cannot be a plain FK)."""
    __tablename__ = "provenance"
    fhir_type = "Provenance"
    __extra_args__ = (
        CheckConstraint("target_resource_type ~ '^[A-Z][A-Za-z]{2,63}$'",
                        name="target_type_format"),
        Index("ix_provenance_target", "target_resource_type", "target_id"),
    )

    target_resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    target_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    target_version_id: Mapped[int | None] = mapped_column(Integer)
    occurred_date_time: Mapped[datetime | None] = date_time("occurredDateTime")
    recorded: Mapped[datetime] = instant("recorded", required=True)
    location_id: Mapped[uuid.UUID | None] = ref("location", "location", "Location")
    activity_system, activity_code, activity_display, activity_text = cc("activity")
    reason_system, reason_code, reason_display, reason_text = cc("reason", many=True)
    ext_ai_suggestion_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.ai_suggestion.id", use_alter=True))
    ext_migration_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.migration_run.id"))

    agent = children("ProvenanceAgent", "provenance_id", "agent")
    entity = children("ProvenanceEntity", "provenance_id", "entity")
    signature = children("ProvenanceSignature", "provenance_id", "signature")


class ProvenanceAgent(Base, FhirChildMixin):
    __tablename__ = "provenance_agent"
    fhir_parent = ("provenance_id",)
    __extra_args__ = (CheckConstraint(
        "num_nonnulls(who_practitioner_id, who_practitioner_role_id, who_organization_id, "
        "who_patient_id, who_related_person_id, who_display) >= 1", name="has_who"),)

    provenance_id: Mapped[uuid.UUID] = parent("provenance")
    type_system, type_code, type_display, type_text = cc("type")   # author, verifier ...
    who_practitioner_id: Mapped[uuid.UUID | None] = ref("who", "practitioner", "Practitioner")
    who_practitioner_role_id: Mapped[uuid.UUID | None] = ref("who", "practitioner_role",
                                                             "PractitionerRole")
    who_organization_id: Mapped[uuid.UUID | None] = ref("who", "organization", "Organization")
    who_patient_id: Mapped[uuid.UUID | None] = ref("who", "patient", "Patient")
    who_related_person_id: Mapped[uuid.UUID | None] = ref("who", "related_person",
                                                          "RelatedPerson")
    who_display: Mapped[str | None] = mapped_column(
        String(300), info={"fhir": "who", "fhir_type": "Reference", "part": "display"})
    on_behalf_of_organization_id: Mapped[uuid.UUID | None] = ref("onBehalfOf", "organization",
                                                                 "Organization")


class ProvenanceEntity(Base, FhirChildMixin):
    __tablename__ = "provenance_entity"
    fhir_parent = ("provenance_id",)

    provenance_id: Mapped[uuid.UUID] = parent("provenance")
    role: Mapped[str] = code("role", ProvenanceEntityRole, required=True)
    what_resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    what_id: Mapped[str] = mapped_column(String(64), nullable=False)
    what_version_id: Mapped[int | None] = mapped_column(Integer)


class ProvenanceSignature(Base, FhirChildMixin):
    """Signature evidence (hash of the signed content; EPCS two-factor evidence in P1)."""
    __tablename__ = "provenance_signature"
    fhir_parent = ("provenance_id",)
    __extra_args__ = (CheckConstraint("data_sha256 ~ '^[0-9a-f]{64}$'", name="sha256_format"),)

    provenance_id: Mapped[uuid.UUID] = parent("provenance")
    type_code: Mapped[str] = mapped_column(
        String(64), nullable=False,
        info={"fhir": "type", "fhir_type": "Coding", "part": "code", "many": True,
              "fixed_system": "urn:iso-astm:E1762-95:2013"})
    when: Mapped[datetime] = instant("when", required=True)
    who_practitioner_id: Mapped[uuid.UUID] = ref("who", "practitioner", "Practitioner",
                                                 required=True)
    sig_format: Mapped[str | None] = prim("sigFormat", String(100), "code")
    data_sha256: Mapped[str] = mapped_column(String(64), nullable=False)


# =========================================================================== history
class FhirResourceHistory(Base, TenantMixin):
    """One row per FHIR resource version (``meta.versionId``), written at commit by a
    SECURITY DEFINER trigger function with the full row + child rows as JSON. Backs
    ``vread`` and ``_history``. The API role can read but never write or change it."""
    __tablename__ = "fhir_resource_history"
    __table_args__ = (
        UniqueConstraint("resource_type", "resource_id", "version_id"),
        Index("ix_fhir_resource_history_time", "tenant_id", "recorded_at"),
        CheckConstraint("version_id >= 1", name="version_positive"),
        # A version is written by a staff user or, in a portal session, by the patient (ADR-0013
        # §6), never both.
        CheckConstraint("recorded_by_user_id IS NULL OR recorded_by_patient_id IS NULL",
                        name="one_author"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    version_id: Mapped[int] = mapped_column(Integer, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    recorded_by_user_id: Mapped[uuid.UUID | None]   # app.current_user_id (no FK: append-only)
    #: app.current_patient_id, for a version written in a portal session (no FK: append-only).
    recorded_by_patient_id: Mapped[uuid.UUID | None]
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
