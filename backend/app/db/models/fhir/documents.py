"""DocumentReference (files: scans, faxes, outside records, C-CDA, lab PDFs, AVS) and
Composition (clinical notes, FR-ENC-01).

Clinical notes are Compositions:
* status preliminary = draft (editable), final = signed (frozen by trigger), amended,
  entered-in-error.
* Signature = a 'legal' attester; co-signature (NP / PA supervision) = a second attester row
  added after signing. A final note must have a legal attester (deferred trigger).
* Addendum = a new Composition with relatesTo 'appends' -> original; a corrected version =
  relatesTo 'replaces'. The original is never edited.
* Sections (CC, HPI, ROS, exam, A/P ...) carry their own AI provenance.
The US Core DocumentReference view of a note is produced by the facade.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, ClinicalResourceMixin, FhirChildMixin, ProvenanceMixin, enum_type
from app.db.fhir_types import (
    attachment,
    cc,
    children,
    code,
    coding,
    date_time,
    instant,
    parent,
    period,
    ref,
    string,
)
from app.db.models.enums import (
    CompositionAttestationMode,
    CompositionStatus,
    DocumentOrigin,
    DocumentReferenceStatus,
    DocumentRelationshipType,
    IndexingStatus,
)


# =========================================================================== DocumentReference
class DocumentReference(Base, ClinicalResourceMixin):
    """Unindexed inbound faxes have no subject yet (indexing queue); everything else must."""
    __tablename__ = "document_reference"
    fhir_type = "DocumentReference"
    __extra_args__ = (
        CheckConstraint("subject_patient_id IS NOT NULL OR ext_indexing_status IN "
                        "('pending', 'rejected') OR ext_origin = 'generated'",
                        name="subject_unless_unindexed"),
        CheckConstraint("ext_indexing_status <> 'indexed' OR subject_patient_id IS NOT NULL",
                        name="indexed_has_subject"),
        Index("ix_document_reference_patient_date", "subject_patient_id", "date"),
        Index("ix_document_reference_indexing", "tenant_id", "ext_indexing_status",
              postgresql_where=text("ext_indexing_status = 'pending'")),
    )

    status: Mapped[str] = code("status", DocumentReferenceStatus, required=True,
                               default=DocumentReferenceStatus.CURRENT)
    doc_status: Mapped[str | None] = code("docStatus", CompositionStatus)
    type_system, type_code, type_display, type_text = cc("type", required=True)   # LOINC
    subject_patient_id: Mapped[uuid.UUID | None] = ref("subject", "patient", "Patient")
    date: Mapped[datetime | None] = instant("date")
    authenticator_practitioner_id: Mapped[uuid.UUID | None] = ref(
        "authenticator", "practitioner", "Practitioner")
    custodian_organization_id: Mapped[uuid.UUID | None] = ref("custodian", "organization",
                                                              "Organization")
    description: Mapped[str | None] = string("description", 1000)
    context_encounter_id: Mapped[uuid.UUID | None] = ref("context.encounter", "encounter",
                                                         "Encounter", many=True)
    context_period_start, context_period_end = period("context.period")
    (context_practice_setting_system, context_practice_setting_code,
     context_practice_setting_display, context_practice_setting_text) = cc(
        "context.practiceSetting")
    # Shri extensions
    ext_origin: Mapped[str] = mapped_column(enum_type(DocumentOrigin), nullable=False,
                                            default=DocumentOrigin.UPLOAD.value)
    ext_indexing_status: Mapped[str] = mapped_column(
        enum_type(IndexingStatus), nullable=False, default=IndexingStatus.NOT_REQUIRED.value,
        server_default=IndexingStatus.NOT_REQUIRED.value)
    ext_composition_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.composition.id"))       # rendered note / after-visit summary

    identifier = children("Identifier", "document_reference_id", "identifier")
    category = children("DocumentReferenceCategory", "document_reference_id", None,
                        spread=True)
    author = children("DocumentReferenceAuthor", "document_reference_id", None, spread=True)
    relates_to = children("DocumentReferenceRelatesTo", "document_reference_id", "relatesTo")
    content = children("DocumentReferenceContent", "document_reference_id", "content")


class DocumentReferenceCategory(Base, FhirChildMixin):
    __tablename__ = "document_reference_category"
    fhir_parent = ("document_reference_id",)
    __extra_args__ = (UniqueConstraint("document_reference_id", "category_system",
                                       "category_code"),)

    document_reference_id: Mapped[uuid.UUID] = parent("document_reference")
    category_system, category_code, category_display, category_text = cc(
        "category", required=True, many=True)


class DocumentReferenceAuthor(Base, FhirChildMixin):
    __tablename__ = "document_reference_author"
    fhir_parent = ("document_reference_id",)

    document_reference_id: Mapped[uuid.UUID] = parent("document_reference")
    practitioner_id: Mapped[uuid.UUID | None] = ref("author", "practitioner", "Practitioner",
                                                    required=True)
    practitioner_role_id: Mapped[uuid.UUID | None] = ref("author", "practitioner_role",
                                                         "PractitionerRole", required=True)
    organization_id: Mapped[uuid.UUID | None] = ref("author", "organization", "Organization",
                                                    required=True)
    patient_id: Mapped[uuid.UUID | None] = ref("author", "patient", "Patient", required=True)
    related_person_id: Mapped[uuid.UUID | None] = ref("author", "related_person",
                                                      "RelatedPerson", required=True)


class DocumentReferenceRelatesTo(Base, FhirChildMixin):
    __tablename__ = "document_reference_relates_to"
    fhir_parent = ("document_reference_id",)
    __extra_args__ = (CheckConstraint("target_document_reference_id <> document_reference_id",
                                      name="not_self"),)

    document_reference_id: Mapped[uuid.UUID] = parent("document_reference")
    code: Mapped[str] = code("code", DocumentRelationshipType, required=True)
    target_document_reference_id: Mapped[uuid.UUID] = ref(
        "target", "document_reference", "DocumentReference", required=True)


class DocumentReferenceContent(Base, FhirChildMixin):
    __tablename__ = "document_reference_content"
    fhir_parent = ("document_reference_id",)

    document_reference_id: Mapped[uuid.UUID] = parent("document_reference")
    (attachment_content_type, attachment_binary_object_id, attachment_title,
     attachment_creation) = attachment("attachment", required=True)
    format_system, format_code, format_display = coding("format", system_fk=False)


# =========================================================================== Composition
class Composition(Base, ClinicalResourceMixin):
    """A clinical note (progress note, H&P, after-visit summary ...)."""
    __tablename__ = "composition"
    fhir_type = "Composition"
    __extra_args__ = (
        Index("ix_composition_patient_date", "subject_patient_id", "date"),
        Index("ix_composition_unsigned", "tenant_id", "status",
              postgresql_where=text("status = 'preliminary'")),
        UniqueConstraint("id", "status"),     # attester / section guards pin parent state
    )

    status: Mapped[str] = code("status", CompositionStatus, required=True,
                               default=CompositionStatus.PRELIMINARY)
    type_system, type_code, type_display, type_text = cc("type", required=True)  # LOINC
    category_system, category_code, category_display, category_text = cc("category",
                                                                         many=True)
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True)
    encounter_id: Mapped[uuid.UUID | None] = ref("encounter", "encounter", "Encounter",
                                                 index=True)
    date: Mapped[datetime] = date_time("date", required=True)
    title: Mapped[str] = string("title", 300, required=True)
    confidentiality: Mapped[str | None] = mapped_column(
        String(1), info={"fhir": "confidentiality", "fhir_type": "code"})
    custodian_organization_id: Mapped[uuid.UUID | None] = ref("custodian", "organization",
                                                              "Organization")
    ext_template_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.note_template.id"))
    ext_is_ai_assisted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                                     server_default=text("false"))

    author = children("CompositionAuthor", "composition_id", None, spread=True)
    attester = children("CompositionAttester", "composition_id", "attester", order_by="time")
    relates_to = children("CompositionRelatesTo", "composition_id", "relatesTo")
    section = children("CompositionSection", "composition_id", "section", order_by="sequence")


class CompositionAuthor(Base, FhirChildMixin):
    __tablename__ = "composition_author"
    fhir_parent = ("composition_id",)

    composition_id: Mapped[uuid.UUID] = parent("composition")
    practitioner_id: Mapped[uuid.UUID | None] = ref("author", "practitioner", "Practitioner",
                                                    required=True)
    practitioner_role_id: Mapped[uuid.UUID | None] = ref("author", "practitioner_role",
                                                         "PractitionerRole", required=True)
    organization_id: Mapped[uuid.UUID | None] = ref("author", "organization", "Organization",
                                                    required=True)


class CompositionAttester(Base, FhirChildMixin):
    """Signature (legal) and co-signature (professional / legal by the supervisor).
    Insert-only; one attestation per mode and party."""
    __tablename__ = "composition_attester"
    fhir_parent = ("composition_id",)
    __extra_args__ = (UniqueConstraint("composition_id", "mode", "party_practitioner_id"),)

    composition_id: Mapped[uuid.UUID] = parent("composition")
    mode: Mapped[str] = code("mode", CompositionAttestationMode, required=True)
    time: Mapped[datetime] = date_time("time", required=True)
    party_practitioner_id: Mapped[uuid.UUID] = ref("party", "practitioner", "Practitioner",
                                                   required=True)
    ext_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.app_user.id"), nullable=False)
    ext_content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)


class CompositionRelatesTo(Base, FhirChildMixin):
    __tablename__ = "composition_relates_to"
    fhir_parent = ("composition_id",)
    __extra_args__ = (
        CheckConstraint("target_composition_id <> composition_id", name="not_self"),
        UniqueConstraint("composition_id", "code", "target_composition_id"),
        Index("ix_composition_relates_to_target", "target_composition_id"),
    )

    composition_id: Mapped[uuid.UUID] = parent("composition")
    code: Mapped[str] = code("code", DocumentRelationshipType, required=True)
    target_composition_id: Mapped[uuid.UUID] = ref("targetReference", "composition",
                                                   "Composition", required=True)


class CompositionSection(Base, FhirChildMixin, ProvenanceMixin):
    """Note section. ``text_div`` is the XHTML narrative; ``ext_structured`` keeps the
    template's structured answers. AI-drafted sections carry ai_suggestion_id."""
    __tablename__ = "composition_section"
    fhir_parent = ("composition_id",)
    __extra_args__ = (
        UniqueConstraint("composition_id", "sequence"),
        CheckConstraint("parent_section_id IS DISTINCT FROM id", name="not_own_parent"),
        # cmp-1: a section must contain at least one of text, entries, or sub-sections; we
        # require narrative or an emptyReason at the row level.
        CheckConstraint("text_div IS NOT NULL OR empty_reason_code IS NOT NULL OR "
                        "parent_section_id IS NULL", name="fhir_cmp_1"),
    )

    composition_id: Mapped[uuid.UUID] = parent("composition")
    parent_section_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.composition_section.id", ondelete="CASCADE"))
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    title: Mapped[str | None] = string("title", 200)
    code_system, code_code, code_display, code_text = cc("code")   # LOINC section codes
    text_status: Mapped[str | None] = mapped_column(
        String(20), info={"fhir": "text.status", "fhir_type": "code"})
    text_div: Mapped[str | None] = mapped_column(
        Text, info={"fhir": "text.div", "fhir_type": "xhtml"})
    (empty_reason_system, empty_reason_code, empty_reason_display,
     empty_reason_text) = cc("emptyReason")

    entry = children("CompositionSectionEntry", "section_id", None, spread=True,
                     order_by="sequence")


class CompositionSectionEntry(Base, FhirChildMixin):
    """Section.entry: the structured records a section cites (problem, med, vital ...)."""
    __tablename__ = "composition_section_entry"
    fhir_parent = ("section_id",)
    __extra_args__ = (UniqueConstraint("section_id", "sequence"),)

    section_id: Mapped[uuid.UUID] = parent("composition_section")
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    condition_id: Mapped[uuid.UUID | None] = ref("entry", "condition", "Condition",
                                                 required=True)
    observation_id: Mapped[uuid.UUID | None] = ref("entry", "observation", "Observation",
                                                   required=True)
    allergy_intolerance_id: Mapped[uuid.UUID | None] = ref(
        "entry", "allergy_intolerance", "AllergyIntolerance", required=True)
    medication_request_id: Mapped[uuid.UUID | None] = ref(
        "entry", "medication_request", "MedicationRequest", required=True)
    medication_statement_id: Mapped[uuid.UUID | None] = ref(
        "entry", "medication_statement", "MedicationStatement", required=True)
    procedure_id: Mapped[uuid.UUID | None] = ref("entry", "procedure", "Procedure",
                                                 required=True)
    service_request_id: Mapped[uuid.UUID | None] = ref("entry", "service_request",
                                                       "ServiceRequest", required=True)
    diagnostic_report_id: Mapped[uuid.UUID | None] = ref("entry", "diagnostic_report",
                                                         "DiagnosticReport", required=True)
    family_member_history_id: Mapped[uuid.UUID | None] = ref(
        "entry", "family_member_history", "FamilyMemberHistory", required=True)
    immunization_id: Mapped[uuid.UUID | None] = ref("entry", "immunization", "Immunization",
                                                    required=True)
