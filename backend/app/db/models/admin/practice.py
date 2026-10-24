"""Scheduling configuration, visit flow, templates, favourites, CDS rules and the inbox."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Computed,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    AdminMixin,
    Base,
    OptionalTenantMixin,
    TenantMixin,
    TimestampMixin,
    UUIDPKMixin,
    VersionedMixin,
    enum_type,
)
from app.db.models.enums import (
    DaysOfWeek,
    DetectedIssueSeverity,
    FavoriteKind,
    RuleSource,
    VisitFlowStep,
    WorkItemStatus,
    WorkItemType,
)


# =========================================================================== scheduling config
class AppointmentType(Base, AdminMixin, VersionedMixin):
    """Exposed in FHIR as Appointment.appointmentType (Shri appointment-type CodeSystem)."""
    __tablename__ = "appointment_type"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code"),
        CheckConstraint("default_duration_minutes BETWEEN 5 AND 480", name="duration"),
        CheckConstraint("color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'", name="color_hex"),
        CheckConstraint("max_overbook >= 0", name="max_overbook"),
    )

    code: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    default_duration_minutes: Mapped[int] = mapped_column(SmallInteger, nullable=False,
                                                          default=15)
    color: Mapped[str | None] = mapped_column(String(7))
    allow_overlap: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                                server_default=text("false"))
    max_overbook: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0,
                                              server_default=text("0"))
    requires_eligibility_check: Mapped[bool] = mapped_column(Boolean, nullable=False,
                                                             default=True)
    is_telehealth: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_new_patient: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    default_note_template_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.note_template.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class ScheduleAvailabilityRule(Base, AdminMixin):
    """Weekly template for a FHIR Schedule; Slots are computed from rules + exceptions."""
    __tablename__ = "schedule_availability_rule"
    __table_args__ = (
        CheckConstraint("end_time > start_time", name="time_order"),
        CheckConstraint("slot_minutes BETWEEN 5 AND 240", name="slot_minutes"),
        CheckConstraint("effective_to IS NULL OR effective_to >= effective_from", name="period"),
    )

    schedule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.schedule.id",
                                                              ondelete="CASCADE"),
                                                   nullable=False, index=True)
    day_of_week: Mapped[DaysOfWeek] = mapped_column(enum_type(DaysOfWeek), nullable=False)
    start_time: Mapped[time] = mapped_column(nullable=False)
    end_time: Mapped[time] = mapped_column(nullable=False)
    slot_minutes: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=15)
    location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.location.id"))
    effective_from: Mapped[date] = mapped_column(nullable=False)
    effective_to: Mapped[date | None]


class AvailabilityRuleAppointmentType(Base, TenantMixin):
    """Which appointment types a rule accepts (none listed = all)."""
    __tablename__ = "availability_rule_appointment_type"

    rule_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.schedule_availability_rule.id", ondelete="CASCADE"), primary_key=True)
    appointment_type_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.appointment_type.id", ondelete="CASCADE"), primary_key=True)


class ScheduleException(Base, AdminMixin):
    """Blocks (leave, meetings) or extra availability on a schedule."""
    __tablename__ = "schedule_exception"
    __table_args__ = (CheckConstraint("end_at > start_at", name="time_order"),)

    schedule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.schedule.id",
                                                              ondelete="CASCADE"),
                                                   nullable=False, index=True)
    start_at: Mapped[datetime] = mapped_column(nullable=False)
    end_at: Mapped[datetime] = mapped_column(nullable=False)
    is_available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    reason: Mapped[str | None] = mapped_column(String(200))


class VisitFlowEvent(Base, AdminMixin):
    """FR-SCH-02 status board: arrived -> checked in -> roomed -> with provider -> checked out.
    One row per step, insert-only (A42/issue #13: no UNIQUE(appointment_id, step) - a patient
    moved to a second room must be able to be 'roomed' again); the board reads the latest step
    per appointment from ``ix_visit_flow_event_appointment``."""
    __tablename__ = "visit_flow_event"
    __table_args__ = (
        Index("ix_visit_flow_event_appointment", "appointment_id", "created_at"),
        CheckConstraint("step <> 'roomed' OR location_id IS NOT NULL", name="roomed_has_room"),
    )

    appointment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.appointment.id"),
                                                      nullable=False, index=True)
    step: Mapped[VisitFlowStep] = mapped_column(enum_type(VisitFlowStep), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.location.id"))


# =========================================================================== templates
class NoteTemplate(Base, AdminMixin, VersionedMixin):
    """FR-ENC-04 specialty note templates; sections in note_template_section."""
    __tablename__ = "note_template"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code", "version"),
        CheckConstraint("version >= 1", name="version_positive"),
    )

    code: Mapped[str] = mapped_column(String(60), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    specialty_code: Mapped[str | None] = mapped_column(String(10))    # NUCC taxonomy
    note_type_loinc: Mapped[str] = mapped_column(String(20), nullable=False, default="11506-3")
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class NoteTemplateSection(Base, AdminMixin):
    __tablename__ = "note_template_section"
    __table_args__ = (
        UniqueConstraint("template_id", "sequence"),
        UniqueConstraint("template_id", "section_code"),
    )

    template_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.note_template.id", ondelete="CASCADE"), nullable=False)
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    section_code: Mapped[str] = mapped_column(String(20), nullable=False)   # LOINC section
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    default_text: Mapped[str | None] = mapped_column(Text)
    is_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class SmartPhrase(Base, AdminMixin):
    """Reusable text phrases; owner_user_id NULL = practice-wide."""
    __tablename__ = "smart_phrase"
    __table_args__ = (
        UniqueConstraint("tenant_id", "owner_user_id", "abbreviation",
                         postgresql_nulls_not_distinct=True),
        CheckConstraint("abbreviation ~ '^[.]?[A-Za-z0-9_-]{2,40}$'", name="abbreviation_format"),
    )

    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id",
                                                                       ondelete="CASCADE"))
    abbreviation: Mapped[str] = mapped_column(String(41), nullable=False)
    expansion: Mapped[str] = mapped_column(Text, nullable=False)


class OrderSet(Base, AdminMixin):
    __tablename__ = "order_set"
    __table_args__ = (UniqueConstraint("tenant_id", "owner_user_id", "code",
                                       postgresql_nulls_not_distinct=True),)

    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id",
                                                                       ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(60), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class OrderSetItem(Base, AdminMixin):
    """A lab test from a compendium, or a coded non-lab order (imaging, procedure, referral)."""
    __tablename__ = "order_set_item"
    __table_args__ = (
        UniqueConstraint("order_set_id", "sequence"),
        CheckConstraint("num_nonnulls(compendium_test_id, code) = 1", name="one_orderable"),
        CheckConstraint("(code IS NULL) = (code_system IS NULL)", name="coding_pair"),
    )

    order_set_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.order_set.id",
                                                               ondelete="CASCADE"),
                                                    nullable=False)
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    compendium_test_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.compendium_test.id"))
    code_system: Mapped[str | None] = mapped_column(ForeignKey("admin.code_system.uri",
                                                               onupdate="CASCADE"))
    code: Mapped[str | None] = mapped_column(String(64))
    display: Mapped[str | None] = mapped_column(String(500))


class PrescriptionFavorite(Base, AdminMixin):
    """Saved prescription (drug + sig) for quick prescribing; owner NULL = practice-wide."""
    __tablename__ = "prescription_favorite"
    __table_args__ = (
        CheckConstraint("refills BETWEEN 0 AND 11", name="refills"),
        CheckConstraint("dispense_quantity IS NULL OR dispense_quantity > 0", name="quantity"),
        CheckConstraint("days_supply IS NULL OR days_supply BETWEEN 1 AND 365", name="days"),
    )

    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id",
                                                                       ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    rxnorm_code: Mapped[str] = mapped_column(String(20), nullable=False)
    medication_display: Mapped[str] = mapped_column(String(500), nullable=False)
    sig_text: Mapped[str] = mapped_column(String(1000), nullable=False)
    dispense_quantity: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    dispense_unit: Mapped[str | None] = mapped_column(String(40))
    days_supply: Mapped[int | None] = mapped_column(SmallInteger)
    refills: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)


class UserFavorite(Base, AdminMixin):
    """FR-ENC-04 per-provider favourites. Exactly the column matching ``kind`` is set."""
    __tablename__ = "user_favorite"
    __table_args__ = (
        CheckConstraint(
            "num_nonnulls(note_template_id, diagnosis_code, compendium_test_id, order_set_id, "
            "prescription_favorite_id, smart_phrase_id) = 1", name="one_target"),
        CheckConstraint(
            "(kind = 'note-template' AND note_template_id IS NOT NULL) OR "
            "(kind = 'diagnosis' AND diagnosis_code IS NOT NULL) OR "
            "(kind = 'order' AND compendium_test_id IS NOT NULL) OR "
            "(kind = 'order-set' AND order_set_id IS NOT NULL) OR "
            "(kind = 'prescription' AND prescription_favorite_id IS NOT NULL) OR "
            "(kind = 'phrase' AND smart_phrase_id IS NOT NULL)", name="kind_matches_target"),
        CheckConstraint("(diagnosis_code IS NULL) = (diagnosis_system IS NULL)",
                        name="diagnosis_pair"),
        Index("ix_user_favorite_user_kind", "user_id", "kind", "sequence"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.app_user.id", ondelete="CASCADE"),
                                               nullable=False)
    kind: Mapped[FavoriteKind] = mapped_column(enum_type(FavoriteKind), nullable=False)
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    note_template_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.note_template.id", ondelete="CASCADE"))
    diagnosis_system: Mapped[str | None] = mapped_column(ForeignKey("admin.code_system.uri",
                                                                    onupdate="CASCADE"))
    diagnosis_code: Mapped[str | None] = mapped_column(String(64))
    diagnosis_display: Mapped[str | None] = mapped_column(String(500))
    compendium_test_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.compendium_test.id", ondelete="CASCADE"))
    order_set_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.order_set.id", ondelete="CASCADE"))
    prescription_favorite_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.prescription_favorite.id", ondelete="CASCADE"))
    smart_phrase_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.smart_phrase.id", ondelete="CASCADE"))


# =========================================================================== decision support
class CdsRule(Base, UUIDPKMixin, OptionalTenantMixin, TimestampMixin):
    """Rule-based CDS catalogue (layer 1-2). tenant_id NULL = platform rule. High-severity
    rules can never be suppressed (FRS §3.4: override reason required instead)."""
    __tablename__ = "cds_rule"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code", postgresql_nulls_not_distinct=True),
        UniqueConstraint("id", "is_suppressible"),   # target of user_alert_suppression FK
        CheckConstraint("NOT (is_suppressible AND default_severity = 'high')",
                        name="high_not_suppressible"),
    )

    code: Mapped[str] = mapped_column(String(80), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    alert_type: Mapped[str] = mapped_column(String(40), nullable=False)  # allergy, ddi, dose ...
    rule_source: Mapped[RuleSource] = mapped_column(enum_type(RuleSource), nullable=False,
                                                    default=RuleSource.DETERMINISTIC.value)
    default_severity: Mapped[DetectedIssueSeverity] = mapped_column(
        enum_type(DetectedIssueSeverity), nullable=False)
    requires_override_reason: Mapped[bool] = mapped_column(Boolean, nullable=False,
                                                           default=False)
    is_suppressible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    knowledge_base_version: Mapped[str | None] = mapped_column(String(60))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class UserAlertSuppression(Base, AdminMixin):
    """Per-user suppression of low-value alerts. The composite FK on (rule, true) makes it
    impossible to suppress a rule that is not suppressible."""
    __tablename__ = "user_alert_suppression"
    __table_args__ = (
        UniqueConstraint("user_id", "cds_rule_id"),
        ForeignKeyConstraint(["cds_rule_id", "rule_is_suppressible"],
                             ["admin.cds_rule.id", "admin.cds_rule.is_suppressible"],
                             name="fk_user_alert_suppression_rule_suppressible"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.app_user.id", ondelete="CASCADE"),
                                               nullable=False)
    cds_rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.cds_rule.id"), nullable=False)
    rule_is_suppressible: Mapped[bool] = mapped_column(Boolean, Computed("true", persisted=True))
    reason: Mapped[str | None] = mapped_column(String(500))


# =========================================================================== inbox / queues
class WorkItem(Base, AdminMixin):
    """FR-ENC-05 clinician inbox and front-office / billing queues. At most one subject."""
    __tablename__ = "work_item"
    __table_args__ = (
        CheckConstraint("priority BETWEEN 1 AND 5", name="priority"),
        CheckConstraint("escalation_level >= 0", name="escalation_level"),
        CheckConstraint(
            "num_nonnulls(diagnostic_report_id, composition_id, document_reference_id, "
            "medication_request_id, service_request_id, appointment_id, unmatched_result_id, "
            "claim_id, fax_transmission_id) <= 1", name="one_subject"),
        CheckConstraint("(status = 'completed') = (completed_at IS NOT NULL)",
                        name="completed_has_time"),
        CheckConstraint("num_nonnulls(assigned_user_id, assigned_role_id) <= 1",
                        name="one_assignee"),
        Index("ix_work_item_open", "tenant_id", "assigned_user_id", "status", "priority",
              postgresql_where=text("status IN ('open', 'in-progress', 'on-hold')")),
        Index("ix_work_item_role_open", "tenant_id", "assigned_role_id", "status",
              postgresql_where=text("status IN ('open', 'in-progress', 'on-hold')")),
    )

    item_type: Mapped[WorkItemType] = mapped_column(enum_type(WorkItemType), nullable=False)
    status: Mapped[WorkItemStatus] = mapped_column(enum_type(WorkItemStatus), nullable=False,
                                                   default=WorkItemStatus.OPEN.value,
                                                   server_default=WorkItemStatus.OPEN.value)
    priority: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=3)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    assigned_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    assigned_role_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.role.id"))
    facility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.facility.id"))
    due_at: Mapped[datetime | None]
    escalation_level: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    escalated_at: Mapped[datetime | None]
    completed_at: Mapped[datetime | None]
    completed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    patient_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.patient.id"),
                                                         index=True)
    encounter_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.encounter.id"))
    diagnostic_report_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.diagnostic_report.id"))
    composition_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.composition.id"))
    document_reference_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.document_reference.id"))
    medication_request_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.medication_request.id"))
    service_request_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.service_request.id"))
    appointment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.appointment.id"))
    unmatched_result_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.unmatched_result.id"))
    claim_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.claim.id"))
    fax_transmission_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.fax_transmission.id"))


class WorkItemEvent(Base, AdminMixin):
    """Assignment, escalation and status history of a work item (insert-only)."""
    __tablename__ = "work_item_event"
    __table_args__ = (CheckConstraint(
        "event IN ('created', 'assigned', 'escalated', 'status-change', 'comment')",
        name="event_code"),)

    work_item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.work_item.id"),
                                                    nullable=False,
                                                    index=True)
    event: Mapped[str] = mapped_column(String(20), nullable=False)
    from_status: Mapped[WorkItemStatus | None] = mapped_column(enum_type(WorkItemStatus))
    to_status: Mapped[WorkItemStatus | None] = mapped_column(enum_type(WorkItemStatus))
    assigned_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    comment: Mapped[str | None] = mapped_column(Text)
    occurred_at: Mapped[datetime] = mapped_column(nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
