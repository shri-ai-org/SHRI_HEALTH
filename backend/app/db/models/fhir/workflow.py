"""Schedule, Appointment and Encounter.

Slots are computed from schedule_availability_rule + schedule_exception + appointments
(FHIR Slot is served by the facade, not stored). Double booking is prevented in the database:
appointment_participant carries the appointment period and an exclusion constraint forbids
overlapping *blocking* participations of the same practitioner. Overbooks, same-day add-ons on
overlap-allowed types and cancelled appointments are not blocking (trigger-maintained).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ExcludeConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, ClinicalResourceMixin, FhirChildMixin, FhirResourceMixin
from app.db.fhir_types import (
    boolean,
    cc,
    children,
    code,
    coding,
    date_time,
    instant,
    integer,
    parent,
    period,
    ref,
    ref_display,
    ref_identifier,
    string,
)
from app.db.models import systems
from app.db.models.enums import (
    AppointmentStatus,
    EncounterClass,
    EncounterLocationStatus,
    EncounterStatus,
    ParticipantRequired,
    ParticipationStatus,
)

ACTIVE_APPOINTMENT = "('booked', 'arrived', 'checked-in', 'pending')"


# =========================================================================== Schedule
class Schedule(Base, FhirResourceMixin):
    __tablename__ = "schedule"
    fhir_type = "Schedule"

    active: Mapped[bool] = boolean("active", required=True, default=True,
                                   server_default=text("true"))
    (service_category_system, service_category_code, service_category_display,
     service_category_text) = cc("serviceCategory", many=True)
    service_type_system, service_type_code, service_type_display, service_type_text = cc(
        "serviceType", many=True)
    specialty_system, specialty_code, specialty_display, specialty_text = cc("specialty",
                                                                             many=True)
    planning_horizon_start, planning_horizon_end = period("planningHorizon")
    comment: Mapped[str | None] = string("comment", 1000)
    ext_facility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.facility.id"))

    actor = children("ScheduleActor", "schedule_id", None, spread=True)


class ScheduleActor(Base, FhirChildMixin):
    __tablename__ = "schedule_actor"
    fhir_parent = ("schedule_id",)

    schedule_id: Mapped[uuid.UUID] = parent("schedule")
    practitioner_id: Mapped[uuid.UUID | None] = ref("actor", "practitioner", "Practitioner",
                                                    required=True, index=True)
    practitioner_role_id: Mapped[uuid.UUID | None] = ref("actor", "practitioner_role",
                                                         "PractitionerRole", required=True)
    location_id: Mapped[uuid.UUID | None] = ref("actor", "location", "Location", required=True)


# =========================================================================== Appointment
class Appointment(Base, FhirResourceMixin):
    """FHIR Appointment. ``subject_patient_id`` backports R5 Appointment.subject so patient
    consistency can be enforced with foreign keys; the patient is also a participant."""
    __tablename__ = "appointment"
    fhir_type = "Appointment"
    __extra_args__ = (
        CheckConstraint("(start IS NULL) = (\"end\" IS NULL)", name="fhir_app_2"),
        CheckConstraint("start IS NOT NULL OR status IN ('proposed', 'cancelled', 'waitlist')",
                        name="fhir_app_3"),
        CheckConstraint("cancelation_reason_code IS NULL AND cancelation_reason_text IS NULL "
                        "OR status IN ('cancelled', 'noshow')", name="fhir_app_4"),
        CheckConstraint("\"end\" IS NULL OR \"end\" > start", name="end_after_start"),
        CheckConstraint("minutes_duration IS NULL OR minutes_duration > 0",
                        name="duration_positive"),
        CheckConstraint("status <> 'cancelled' OR ext_cancelled_at IS NOT NULL",
                        name="cancelled_has_time"),
        CheckConstraint("ext_rescheduled_from_appointment_id IS DISTINCT FROM id",
                        name="not_rescheduled_from_self"),
        Index("ix_appointment_patient_start", "subject_patient_id", "start"),
        Index("ix_appointment_day", "tenant_id", "start", "status"),
    )

    status: Mapped[str] = code("status", AppointmentStatus, required=True,
                               default=AppointmentStatus.BOOKED)
    (cancelation_reason_system, cancelation_reason_code, cancelation_reason_display,
     cancelation_reason_text) = cc("cancelationReason")
    (service_category_system, service_category_code, service_category_display,
     service_category_text) = cc("serviceCategory", many=True)
    service_type_system, service_type_code, service_type_display, service_type_text = cc(
        "serviceType", many=True)
    (appointment_type_system, appointment_type_code, appointment_type_display,
     appointment_type_text) = cc("appointmentType")
    priority: Mapped[int | None] = integer("priority", fhir_type="unsignedInt")
    description: Mapped[str | None] = string("description", 500)
    start: Mapped[datetime | None] = instant("start")
    end: Mapped[datetime | None] = instant("end")
    minutes_duration: Mapped[int | None] = integer("minutesDuration", fhir_type="positiveInt")
    created: Mapped[datetime | None] = date_time("created")
    comment: Mapped[str | None] = string("comment", 2000)
    patient_instruction: Mapped[str | None] = string("patientInstruction", 2000)
    subject_patient_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clinical.patient.id"), nullable=False, index=True)
    # Shri extensions (front office)
    ext_appointment_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.appointment_type.id"))
    ext_schedule_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.schedule.id"))
    ext_facility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.facility.id"))
    ext_same_day_add_on: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                                      server_default=text("false"))
    ext_overbook: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                               server_default=text("false"))
    ext_rescheduled_from_appointment_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.appointment.id"))
    ext_cancelled_at: Mapped[datetime | None]
    ext_cancelled_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.app_user.id"))

    participant = children("AppointmentParticipant", "appointment_id", "participant")
    reason = children("AppointmentReason", "appointment_id", None, spread=True)


class AppointmentParticipant(Base, FhirChildMixin):
    __tablename__ = "appointment_participant"
    fhir_parent = ("appointment_id",)
    __extra_args__ = (
        CheckConstraint("period_end IS NULL OR period_end > period_start", name="period_order"),
        CheckConstraint("NOT ext_blocking OR (actor_practitioner_id IS NOT NULL AND "
                        "period_start IS NOT NULL AND period_end IS NOT NULL)",
                        name="blocking_needs_period"),
        ExcludeConstraint(
            ("actor_practitioner_id", "="),
            (text("tstzrange(period_start, period_end)"), "&&"),
            where=text("ext_blocking"), using="gist",
            name="ex_appointment_participant_no_double_booking"),
    )

    appointment_id: Mapped[uuid.UUID] = parent("appointment")
    type_system, type_code, type_display, type_text = cc("type", many=True)
    actor_patient_id: Mapped[uuid.UUID | None] = ref("actor", "patient", "Patient")
    actor_practitioner_id: Mapped[uuid.UUID | None] = ref("actor", "practitioner",
                                                          "Practitioner", index=True)
    actor_practitioner_role_id: Mapped[uuid.UUID | None] = ref("actor", "practitioner_role",
                                                               "PractitionerRole")
    actor_related_person_id: Mapped[uuid.UUID | None] = ref("actor", "related_person",
                                                            "RelatedPerson")
    actor_location_id: Mapped[uuid.UUID | None] = ref("actor", "location", "Location")
    required: Mapped[str | None] = code("required", ParticipantRequired)
    status: Mapped[str] = code("status", ParticipationStatus, required=True,
                               default=ParticipationStatus.ACCEPTED)
    period_start, period_end = period("period")   # copied from the appointment (trigger)
    ext_blocking: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                               server_default=text("false"))


class AppointmentReason(Base, FhirChildMixin):
    """One row = one reasonCode or one reasonReference entry."""
    __tablename__ = "appointment_reason"
    __fhir_choices__ = {"reason": (True, ["reasonCode", "reasonReference"])}
    fhir_parent = ("appointment_id",)

    appointment_id: Mapped[uuid.UUID] = parent("appointment")
    reason_code_system, reason_code_code, reason_code_display, reason_code_text = cc(
        "reasonCode", many=True)
    condition_id: Mapped[uuid.UUID | None] = ref("reasonReference", "condition", "Condition")
    procedure_id: Mapped[uuid.UUID | None] = ref("reasonReference", "procedure", "Procedure")
    observation_id: Mapped[uuid.UUID | None] = ref("reasonReference", "observation",
                                                   "Observation")


# =========================================================================== Encounter
class Encounter(Base, ClinicalResourceMixin):
    """US Core Encounter. Rooming = an active encounter_location on an exam room; visit status
    history in encounter_status_history; diagnoses ranked for claims in encounter_diagnosis."""
    __tablename__ = "encounter"
    fhir_type = "Encounter"
    __extra_args__ = (
        CheckConstraint("period_end IS NULL OR period_start IS NULL OR period_end >= period_start",
                        name="period_order"),
        CheckConstraint("status <> 'finished' OR (period_start IS NOT NULL AND "
                        "period_end IS NOT NULL)", name="finished_has_period"),
        CheckConstraint("status NOT IN ('in-progress', 'finished') OR period_start IS NOT NULL",
                        name="started_has_start"),
        CheckConstraint("ext_place_of_service_code IS NULL OR "
                        "ext_place_of_service_code ~ '^[0-9]{2}$'", name="pos_format"),
        Index("ix_encounter_patient_start", "subject_patient_id", "period_start"),
    )

    status: Mapped[str] = code("status", EncounterStatus, required=True,
                               default=EncounterStatus.PLANNED)
    class_: Mapped[str] = coding("class", fixed_system=systems.V3_ACT_CODE,
                                 enum_cls=EncounterClass, required=True, name="class")
    service_type_system, service_type_code, service_type_display, service_type_text = cc(
        "serviceType")
    priority_system, priority_code, priority_display, priority_text = cc("priority")
    subject_patient_id: Mapped[uuid.UUID] = ref("subject", "patient", "Patient", required=True)
    appointment_id: Mapped[uuid.UUID | None] = ref("appointment", "appointment", "Appointment",
                                                   unique=True, many=True)
    period_start, period_end = period("period")
    service_provider_organization_id: Mapped[uuid.UUID | None] = ref(
        "serviceProvider", "organization", "Organization")
    ext_facility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.facility.id"))
    ext_place_of_service_code: Mapped[str | None] = mapped_column(String(2))

    identifier = children("Identifier", "encounter_id", "identifier")
    status_history = children("EncounterStatusHistory", "encounter_id", "statusHistory",
                              order_by="period_start")
    type = children("EncounterType", "encounter_id", None, spread=True)
    participant = children("EncounterParticipant", "encounter_id", "participant")
    reason = children("EncounterReason", "encounter_id", None, spread=True)
    diagnosis = children("EncounterDiagnosis", "encounter_id", "diagnosis", order_by="rank")
    location = children("EncounterLocation", "encounter_id", "location")


class EncounterStatusHistory(Base, FhirChildMixin):
    __tablename__ = "encounter_status_history"
    fhir_parent = ("encounter_id",)
    __extra_args__ = (CheckConstraint("period_end IS NULL OR period_end >= period_start",
                                      name="period_order"),)

    encounter_id: Mapped[uuid.UUID] = parent("encounter")
    status: Mapped[str] = code("status", EncounterStatus, required=True)
    period_start, period_end = period("period", required=True)


class EncounterType(Base, FhirChildMixin):
    __tablename__ = "encounter_type"
    fhir_parent = ("encounter_id",)
    __extra_args__ = (UniqueConstraint("encounter_id", "type_system", "type_code"),)

    encounter_id: Mapped[uuid.UUID] = parent("encounter")
    type_system, type_code, type_display, type_text = cc("type", required=True, many=True)


class EncounterParticipant(Base, FhirChildMixin):
    """Rendering (PPRF), supervising (SPRF, co-signature), attending (ATND) and referring
    (REF) practitioners. An outside referrer is a logical reference by NPI."""
    __tablename__ = "encounter_participant"
    fhir_parent = ("encounter_id",)
    __extra_args__ = (
        CheckConstraint("num_nonnulls(individual_practitioner_id, "
                        "individual_practitioner_role_id, individual_related_person_id, "
                        "individual_identifier_value) <= 1", name="one_individual"),
        CheckConstraint("period_end IS NULL OR period_start IS NULL OR period_end >= period_start",
                        name="period_order"),
        Index("ix_encounter_participant_practitioner", "individual_practitioner_id"),
    )

    encounter_id: Mapped[uuid.UUID] = parent("encounter")
    type_system, type_code, type_display, type_text = cc("type", many=True)
    period_start, period_end = period("period")
    individual_practitioner_id: Mapped[uuid.UUID | None] = ref("individual", "practitioner",
                                                               "Practitioner")
    individual_practitioner_role_id: Mapped[uuid.UUID | None] = ref(
        "individual", "practitioner_role", "PractitionerRole")
    individual_related_person_id: Mapped[uuid.UUID | None] = ref(
        "individual", "related_person", "RelatedPerson")
    individual_identifier_system, individual_identifier_value = ref_identifier("individual")
    individual_display: Mapped[str | None] = ref_display("individual")


class EncounterReason(Base, FhirChildMixin):
    __tablename__ = "encounter_reason"
    __fhir_choices__ = {"reason": (True, ["reasonCode", "reasonReference"])}
    fhir_parent = ("encounter_id",)

    encounter_id: Mapped[uuid.UUID] = parent("encounter")
    reason_code_system, reason_code_code, reason_code_display, reason_code_text = cc(
        "reasonCode", many=True)
    condition_id: Mapped[uuid.UUID | None] = ref("reasonReference", "condition", "Condition")
    procedure_id: Mapped[uuid.UUID | None] = ref("reasonReference", "procedure", "Procedure")
    observation_id: Mapped[uuid.UUID | None] = ref("reasonReference", "observation",
                                                   "Observation")


class EncounterDiagnosis(Base, FhirChildMixin):
    """Ranked encounter diagnoses; rank 1-12 is the claim diagnosis order (charge pointers
    reference (encounter_id, rank))."""
    __tablename__ = "encounter_diagnosis"
    fhir_parent = ("encounter_id",)
    __extra_args__ = (
        UniqueConstraint("encounter_id", "condition_id"),
        UniqueConstraint("encounter_id", "rank"),
        CheckConstraint("rank BETWEEN 1 AND 12", name="rank_range"),
    )

    encounter_id: Mapped[uuid.UUID] = parent("encounter")
    condition_id: Mapped[uuid.UUID] = ref("condition", "condition", "Condition", required=True)
    use_system, use_code, use_display, use_text = cc("use")   # diagnosis-role: AD, DD, billing
    rank: Mapped[int] = integer("rank", required=True, fhir_type="positiveInt")


class EncounterLocation(Base, FhirChildMixin):
    __tablename__ = "encounter_location"
    fhir_parent = ("encounter_id",)
    __extra_args__ = (
        CheckConstraint("period_end IS NULL OR period_start IS NULL OR period_end >= period_start",
                        name="period_order"),
        Index("uq_encounter_location_one_active", "encounter_id", unique=True,
              postgresql_where=text("status = 'active'")),
    )

    encounter_id: Mapped[uuid.UUID] = parent("encounter")
    location_id: Mapped[uuid.UUID] = ref("location", "location", "Location", required=True)
    status: Mapped[str | None] = code("status", EncounterLocationStatus)
    physical_type_system, physical_type_code, physical_type_display, physical_type_text = cc(
        "physicalType")
    period_start, period_end = period("period")
