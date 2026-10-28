"""Revenue cycle (FRS §3.7, FR-RCM-01..03): payers, enrollment, eligibility, fee schedules,
superbill and charges, 837P claims, acknowledgements, 835 remittance and patient payments.

Coverage (the patient's insurance) is the FHIR Coverage resource; everything else here is
normalized admin data. Diagnosis pointers are rows with composite FKs, so a charge can only
point at a diagnosis that exists on its own encounter, and a claim line only at a diagnosis
on its own claim.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    MONEY,
    AdminMixin,
    Base,
    ProvenanceMixin,
    TenantMixin,
    TimestampMixin,
    UUIDPKMixin,
    VersionedMixin,
    enum_type,
)
from app.db.models.enums import (
    AdjustmentGroup,
    BenefitTimePeriod,
    BenefitType,
    ClaimEventSource,
    ClaimFrequency,
    ClaimStatus,
    CoverageLevel,
    EligibilityStatus,
    EligibilityTrigger,
    EnrollmentStatus,
    EnrollmentTransaction,
    NetworkIndicator,
    PayerSequence,
    PayerType,
    PaymentMethod,
    PostingStatus,
    RemittancePaymentMethod,
    SuperbillStatus,
)

CPT_HCPCS = ("'http://www.ama-assn.org/go/cpt'", "'urn:oid:2.16.840.1.113883.6.285'")
PROC_SYSTEM_CHECK = f"code_system IN ({', '.join(CPT_HCPCS)})"
MODIFIER_CHECK = "modifier ~ '^[A-Z0-9]{2}$'"


# =========================================================================== payers
class Employer(Base, AdminMixin):
    """Employer of a patient, or of a related person such as a coverage subscriber (D38;
    workers' compensation claims need it). One per person. The contract's Employer: a name, an
    optional E.164 phone and an optional U.S. address (all of it or none). A change touches the
    patient or related person, so its version and ETag change too."""
    __tablename__ = "employer"
    __table_args__ = (
        CheckConstraint("num_nonnulls(patient_id, related_person_id) = 1", name="one_person"),
        UniqueConstraint("patient_id"),
        UniqueConstraint("related_person_id"),
        CheckConstraint("length(trim(name)) >= 1", name="name_given"),
        CheckConstraint("phone IS NULL OR phone ~ '^\\+[1-9][0-9]{6,14}$'", name="phone_e164"),
        CheckConstraint("num_nonnulls(address_lines, address_city, address_state, "
                        "address_postal_code, address_country) IN (0, 5)",
                        name="address_whole"),
        CheckConstraint("address_lines IS NULL OR cardinality(address_lines) BETWEEN 1 AND 3",
                        name="address_lines_count"),
        CheckConstraint("address_state IS NULL OR address_state ~ '^[A-Z]{2}$'",
                        name="address_state_format"),
        CheckConstraint("address_postal_code IS NULL OR "
                        "address_postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'",
                        name="address_postal_code_format"),
        CheckConstraint("address_country IS NULL OR address_country = 'US'",
                        name="address_country_us"),
    )

    patient_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.patient.id", ondelete="CASCADE"))
    related_person_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.related_person.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(16))
    address_lines: Mapped[list[str] | None] = mapped_column(ARRAY(String(100)))
    address_city: Mapped[str | None] = mapped_column(String(60))
    address_state: Mapped[str | None] = mapped_column(String(2))
    address_postal_code: Mapped[str | None] = mapped_column(String(10))
    address_country: Mapped[str | None] = mapped_column(String(2))


class Payer(Base, UUIDPKMixin, TimestampMixin, VersionedMixin):
    """Payer directory (platform-wide). Exposed in FHIR as Organization (type 'pay')."""
    __tablename__ = "payer"
    __table_args__ = (Index("ix_payer_name_trgm", "name", postgresql_using="gin",
                            postgresql_ops={"name": "gin_trgm_ops"}),)

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    payer_type: Mapped[PayerType] = mapped_column(enum_type(PayerType), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(30))
    address_line: Mapped[str | None] = mapped_column(String(200))
    city: Mapped[str | None] = mapped_column(String(100))
    state: Mapped[str | None] = mapped_column(String(2))
    postal_code: Mapped[str | None] = mapped_column(String(10))
    supports_eligibility: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    supports_claim_status: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    supports_era: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class PayerClearinghouseId(Base, UUIDPKMixin):
    """A payer's ID at each clearinghouse (Waystar, Availity ...)."""
    __tablename__ = "payer_clearinghouse_id"
    __table_args__ = (UniqueConstraint("payer_id", "clearinghouse"),
                      UniqueConstraint("clearinghouse", "external_payer_id"))

    payer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.payer.id", ondelete="CASCADE"),
                                                nullable=False)
    clearinghouse: Mapped[str] = mapped_column(String(40), nullable=False)
    external_payer_id: Mapped[str] = mapped_column(String(40), nullable=False)


class PayerEnrollment(Base, AdminMixin):
    """Provider enrollment for claims / ERA / EFT with a payer (lead time is weeks)."""
    __tablename__ = "payer_enrollment"
    __table_args__ = (
        UniqueConstraint("tenant_id", "payer_id", "practitioner_id", "transaction",
                         "clearinghouse",
                         postgresql_nulls_not_distinct=True),
        CheckConstraint("status <> 'approved' OR approved_at IS NOT NULL", name="approved_at"),
    )

    payer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.payer.id"), nullable=False)
    practitioner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey(
        "clinical.practitioner.id"))
    clearinghouse: Mapped[str] = mapped_column(String(40), nullable=False)
    transaction: Mapped[EnrollmentTransaction] = mapped_column(enum_type(EnrollmentTransaction),
                                                               nullable=False)
    status: Mapped[EnrollmentStatus] = mapped_column(enum_type(EnrollmentStatus),
                                                     nullable=False,
                                                     default=EnrollmentStatus.PENDING.value)
    submitted_at: Mapped[datetime | None]
    approved_at: Mapped[datetime | None]


class PracticePayer(Base, AdminMixin, VersionedMixin):
    """A payer this practice actually works with, i.e. the `/practice-payers` directory
    (A39/issue #13) - distinct from `payer`, the platform-wide, read-only payer list. The
    platform payer is never edited per-practice; this row is where a practice turns one on and
    tracks whether it's currently active for the practice to bill against."""
    __tablename__ = "practice_payer"
    __table_args__ = (UniqueConstraint("tenant_id", "payer_id"),)

    payer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.payer.id"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                            server_default=text("true"))


# =========================================================================== eligibility
class EligibilityCheck(Base, AdminMixin):
    """One X12 270/271 round trip (booking, pre-visit batch, check-in, manual)."""
    __tablename__ = "eligibility_check"
    __table_args__ = (
        Index("ix_eligibility_check_coverage_time", "coverage_id", "requested_at"),
        CheckConstraint("responded_at IS NULL OR responded_at >= requested_at",
                        name="response_after_request"),
        CheckConstraint("status = 'pending' OR responded_at IS NOT NULL OR status = 'timeout'",
                        name="completed_has_time"),
        CheckConstraint("provider_npi IS NULL OR shri_npi_valid(provider_npi)", name="npi_valid"),
    )

    coverage_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.coverage.id"),
                                                   nullable=False)
    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"), nullable=False,
                                                  index=True)
    appointment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.appointment.id"),
                                                             index=True)
    encounter_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.encounter.id"))
    provider_npi: Mapped[str | None] = mapped_column(String(10))
    trigger: Mapped[EligibilityTrigger] = mapped_column(enum_type(EligibilityTrigger),
                                                        nullable=False)
    clearinghouse: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[EligibilityStatus] = mapped_column(enum_type(EligibilityStatus),
                                                      nullable=False,
                                                      default=EligibilityStatus.PENDING.value)
    requested_at: Mapped[datetime] = mapped_column(nullable=False)
    responded_at: Mapped[datetime | None]
    plan_name: Mapped[str | None] = mapped_column(String(200))
    coverage_start: Mapped[date | None]
    coverage_end: Mapped[date | None]
    error_code: Mapped[str | None] = mapped_column(String(10))       # AAA03
    error_message: Mapped[str | None] = mapped_column(String(500))
    expires_at: Mapped[datetime | None]
    integration_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.integration_message.id"))
    requested_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))


class EligibilityServiceType(Base, TenantMixin):
    """X12 service type codes requested (EQ01), e.g. 30 = health benefit plan coverage."""
    __tablename__ = "eligibility_service_type"
    __table_args__ = (CheckConstraint("service_type_code ~ '^[A-Z0-9]{1,2}$'",
                                      name="code_format"),)

    eligibility_check_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.eligibility_check.id", ondelete="CASCADE"), primary_key=True)
    service_type_code: Mapped[str] = mapped_column(String(2), primary_key=True)


class EligibilityBenefit(Base, AdminMixin):
    """Normalized 271 EB loop: copay, deductible, coinsurance, out-of-pocket ..."""
    __tablename__ = "eligibility_benefit"
    __table_args__ = (
        CheckConstraint("percent IS NULL OR percent BETWEEN 0 AND 100", name="percent"),
        CheckConstraint("amount IS NULL OR amount >= 0", name="amount"),
    )

    eligibility_check_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.eligibility_check.id", ondelete="CASCADE"), nullable=False, index=True)
    benefit_type: Mapped[BenefitType] = mapped_column(enum_type(BenefitType), nullable=False)
    service_type_code: Mapped[str | None] = mapped_column(String(2))
    coverage_level: Mapped[CoverageLevel | None] = mapped_column(enum_type(CoverageLevel))
    network: Mapped[NetworkIndicator | None] = mapped_column(enum_type(NetworkIndicator))
    time_period: Mapped[BenefitTimePeriod | None] = mapped_column(enum_type(BenefitTimePeriod))
    amount: Mapped[Decimal | None] = mapped_column(MONEY)
    percent: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    authorization_required: Mapped[bool | None] = mapped_column(Boolean)
    message: Mapped[str | None] = mapped_column(String(500))


# =========================================================================== fee schedules
class FeeSchedule(Base, AdminMixin, VersionedMixin):
    __tablename__ = "fee_schedule"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", "effective_from"),
        CheckConstraint("effective_to IS NULL OR effective_to >= effective_from", name="period"),
    )

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    payer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey(
        "admin.payer.id"))  # NULL = standard
    effective_from: Mapped[date] = mapped_column(nullable=False)
    effective_to: Mapped[date | None]
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class FeeScheduleItem(Base, AdminMixin):
    __tablename__ = "fee_schedule_item"
    __table_args__ = (
        UniqueConstraint("fee_schedule_id", "code_system", "code", "modifier"),
        CheckConstraint(PROC_SYSTEM_CHECK, name="procedure_system"),
        CheckConstraint("modifier = '' OR " + MODIFIER_CHECK, name="modifier_format"),
        CheckConstraint("amount >= 0", name="amount"),
    )

    fee_schedule_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.fee_schedule.id", ondelete="CASCADE"), nullable=False)
    code_system: Mapped[str] = mapped_column(ForeignKey("admin.code_system.uri",
                                                        onupdate="CASCADE"),
                                             nullable=False)
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    modifier: Mapped[str] = mapped_column(String(2), nullable=False, default="",
                                          server_default="")
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)


# =========================================================================== charge capture
class Superbill(Base, AdminMixin):
    """Charge capture for one signed encounter; approved superbill -> claim(s)."""
    __tablename__ = "superbill"
    __table_args__ = (
        CheckConstraint("status NOT IN ('approved', 'billed') OR "
                        "(approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL)",
                        name="approved_has_approver"),
        CheckConstraint("place_of_service_code ~ '^[0-9]{2}$'", name="pos_format"),
        UniqueConstraint("id", "encounter_id"),
    )

    encounter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.encounter.id"),
                                                    nullable=False,
                                                    unique=True)
    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"), nullable=False,
                                                  index=True)
    rendering_practitioner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(
        "clinical.practitioner.id"),
                                                                 nullable=False)
    billing_practitioner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.practitioner.id"))
    facility_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.facility.id"), nullable=False)
    place_of_service_code: Mapped[str] = mapped_column(String(2), nullable=False, default="11")
    fee_schedule_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.fee_schedule.id"))
    status: Mapped[SuperbillStatus] = mapped_column(enum_type(SuperbillStatus), nullable=False,
                                                    default=SuperbillStatus.DRAFT.value)
    approved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    approved_at: Mapped[datetime | None]
    notes: Mapped[str | None] = mapped_column(Text)


class Charge(Base, AdminMixin, ProvenanceMixin):
    """Superbill line. AI-suggested codes (AI-04) carry ai_suggestion_id + entry_source."""
    __tablename__ = "charge"
    __table_args__ = (
        UniqueConstraint("superbill_id", "line_number"),
        UniqueConstraint("id", "encounter_id"),
        ForeignKeyConstraint(["superbill_id", "encounter_id"],
                             ["admin.superbill.id", "admin.superbill.encounter_id"],
                             name="fk_charge_superbill_encounter"),
        CheckConstraint(PROC_SYSTEM_CHECK, name="procedure_system"),
        CheckConstraint("units > 0", name="units_positive"),
        CheckConstraint("unit_charge >= 0", name="unit_charge"),
        CheckConstraint("total_charge = round(units * unit_charge, 2)", name="total_matches"),
        CheckConstraint("ndc_code IS NULL OR ndc_code ~ '^[0-9]{11}$'", name="ndc_format"),
    )

    superbill_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.superbill.id",
                                                               ondelete="CASCADE"),
                                                    nullable=False)
    encounter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.encounter.id"),
                                                    nullable=False)
    line_number: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    code_system: Mapped[str] = mapped_column(ForeignKey("admin.code_system.uri",
                                                        onupdate="CASCADE"),
                                             nullable=False)
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    description: Mapped[str | None] = mapped_column(String(300))
    units: Mapped[Decimal] = mapped_column(Numeric(8, 3), nullable=False, default=1)
    unit_charge: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    total_charge: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    ndc_code: Mapped[str | None] = mapped_column(String(11))
    service_date: Mapped[date] = mapped_column(nullable=False)
    rendering_practitioner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.practitioner.id"))
    procedure_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.procedure.id"))
    is_void: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class ChargeModifier(Base, AdminMixin):
    __tablename__ = "charge_modifier"
    __table_args__ = (
        UniqueConstraint("charge_id", "position"),
        UniqueConstraint("charge_id", "modifier"),
        CheckConstraint("position BETWEEN 1 AND 4", name="position"),
        CheckConstraint(MODIFIER_CHECK, name="modifier_format"),
    )

    charge_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.charge.id", ondelete="CASCADE"),
                                                 nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    modifier: Mapped[str] = mapped_column(String(2), nullable=False)


class ChargeDiagnosisPointer(Base, AdminMixin):
    """Charge -> encounter diagnosis (by rank). Composite FKs guarantee the diagnosis is on the
    charge's own encounter."""
    __tablename__ = "charge_diagnosis_pointer"
    __table_args__ = (
        UniqueConstraint("charge_id", "position"),
        UniqueConstraint("charge_id", "diagnosis_rank"),
        CheckConstraint("position BETWEEN 1 AND 4", name="position"),
        ForeignKeyConstraint(["charge_id", "encounter_id"], ["admin.charge.id",
                                                             "admin.charge.encounter_id"],
                             ondelete="CASCADE", name="fk_charge_dx_pointer_charge_encounter"),
        ForeignKeyConstraint(["encounter_id", "diagnosis_rank"],
                             ["clinical.encounter_diagnosis.encounter_id",
                              "clinical.encounter_diagnosis.rank"],
                             name="fk_charge_dx_pointer_encounter_diagnosis"),
    )

    charge_id: Mapped[uuid.UUID] = mapped_column(nullable=False, index=True)
    encounter_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    diagnosis_rank: Mapped[int] = mapped_column(SmallInteger, nullable=False)


# =========================================================================== claims
class Claim(Base, AdminMixin):
    """837P professional claim. Replacement (7) / void (8) claims point at the original."""
    __tablename__ = "claim"
    __table_args__ = (
        UniqueConstraint("tenant_id", "patient_control_number"),
        UniqueConstraint("tenant_id", "idempotency_key"),
        Index("ix_claim_status", "tenant_id", "status", "submitted_at"),
        CheckConstraint("(frequency_code = '1') = (original_claim_id IS NULL)",
                        name="frequency_original"),
        CheckConstraint("total_charge >= 0 AND total_paid >= 0 AND patient_responsibility >= 0",
                        name="amounts"),
        CheckConstraint("status IN ('draft', 'ready') OR submitted_at IS NOT NULL",
                        name="submitted_has_time"),
    )

    superbill_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.superbill.id"),
                                                    nullable=False)
    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"), nullable=False,
                                                  index=True)
    coverage_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.coverage.id"),
                                                   nullable=False)
    payer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.payer.id"), nullable=False)
    payer_sequence: Mapped[PayerSequence] = mapped_column(enum_type(PayerSequence, 1),
                                                          nullable=False,
                                                          default=PayerSequence.PRIMARY.value)
    frequency_code: Mapped[ClaimFrequency] = mapped_column(enum_type(ClaimFrequency, 1),
                                                           nullable=False,
                                                           default=ClaimFrequency.ORIGINAL.value)
    original_claim_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.claim.id"))
    patient_control_number: Mapped[str] = mapped_column(String(38), nullable=False)   # CLM01
    payer_claim_control_number: Mapped[str | None] = mapped_column(String(50))
    status: Mapped[ClaimStatus] = mapped_column(enum_type(ClaimStatus), nullable=False,
                                                default=ClaimStatus.DRAFT.value)
    total_charge: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    total_paid: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    patient_responsibility: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    clearinghouse: Mapped[str | None] = mapped_column(String(40))
    clearinghouse_claim_id: Mapped[str | None] = mapped_column(String(80))
    submitted_at: Mapped[datetime | None]
    adjudicated_at: Mapped[datetime | None]
    outbound_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.integration_message.id"))
    idempotency_key: Mapped[str | None] = mapped_column(String(100))


class ClaimDiagnosis(Base, AdminMixin):
    """Diagnosis list as submitted (HI segment, up to 12) - a snapshot, not a live link."""
    __tablename__ = "claim_diagnosis"
    __table_args__ = (
        UniqueConstraint("claim_id", "sequence"),
        UniqueConstraint("claim_id", "icd10_code"),
        CheckConstraint("sequence BETWEEN 1 AND 12", name="sequence"),
        CheckConstraint("icd10_code ~ '^[A-TV-Z][0-9][0-9A-Z](\\.?[0-9A-Z]{1,4})?$'",
                        name="icd10_format"),
    )

    claim_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.claim.id", ondelete="CASCADE"),
                                                nullable=False)
    sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    icd10_code: Mapped[str] = mapped_column(String(8), nullable=False)


class ClaimLine(Base, AdminMixin):
    __tablename__ = "claim_line"
    __table_args__ = (
        UniqueConstraint("claim_id", "line_number"),
        UniqueConstraint("id", "claim_id"),
        CheckConstraint("units > 0", name="units_positive"),
        CheckConstraint("charge_amount >= 0 AND paid_amount >= 0", name="amounts"),
    )

    claim_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.claim.id", ondelete="CASCADE"),
                                                nullable=False)
    charge_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.charge.id"), nullable=False)
    line_number: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    procedure_code: Mapped[str] = mapped_column(String(10), nullable=False)
    units: Mapped[Decimal] = mapped_column(Numeric(8, 3), nullable=False)
    charge_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    paid_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    service_date: Mapped[date] = mapped_column(nullable=False)


class ClaimLineModifier(Base, AdminMixin):
    __tablename__ = "claim_line_modifier"
    __table_args__ = (
        UniqueConstraint("claim_line_id", "position"),
        CheckConstraint("position BETWEEN 1 AND 4", name="position"),
        CheckConstraint(MODIFIER_CHECK, name="modifier_format"),
    )

    claim_line_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.claim_line.id",
                                                                ondelete="CASCADE"),
                                                     nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    modifier: Mapped[str] = mapped_column(String(2), nullable=False)


class ClaimLineDiagnosisPointer(Base, AdminMixin):
    """SV107 pointers; composite FKs keep each pointer inside the line's own claim."""
    __tablename__ = "claim_line_diagnosis_pointer"
    __table_args__ = (
        UniqueConstraint("claim_line_id", "position"),
        CheckConstraint("position BETWEEN 1 AND 4", name="position"),
        ForeignKeyConstraint(["claim_line_id", "claim_id"], ["admin.claim_line.id",
                                                             "admin.claim_line.claim_id"],
                             ondelete="CASCADE", name="fk_claim_line_dx_pointer_line_claim"),
        ForeignKeyConstraint(["claim_id", "diagnosis_sequence"],
                             ["admin.claim_diagnosis.claim_id", "admin.claim_diagnosis.sequence"],
                             name="fk_claim_line_dx_pointer_claim_diagnosis"),
    )

    claim_line_id: Mapped[uuid.UUID] = mapped_column(nullable=False, index=True)
    claim_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    diagnosis_sequence: Mapped[int] = mapped_column(SmallInteger, nullable=False)


class ClaimStatusEvent(Base, AdminMixin):
    """999 / 277CA acknowledgements, 276/277 status, scrubber findings, manual notes."""
    __tablename__ = "claim_status_event"
    __table_args__ = (Index("ix_claim_status_event_time", "claim_id", "occurred_at"),)

    claim_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.claim.id"), nullable=False)
    source: Mapped[ClaimEventSource] = mapped_column(enum_type(ClaimEventSource), nullable=False)
    status_category_code: Mapped[str | None] = mapped_column(String(5))   # A1, A2, A7, F1 ...
    status_code: Mapped[str | None] = mapped_column(String(10))
    description: Mapped[str | None] = mapped_column(String(500))
    occurred_at: Mapped[datetime] = mapped_column(nullable=False)
    integration_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.integration_message.id"))


# =========================================================================== remittance
class Remittance(Base, AdminMixin):
    """835 ERA payment (one check / EFT trace)."""
    __tablename__ = "remittance"
    __table_args__ = (
        UniqueConstraint("tenant_id", "payer_id", "trace_number"),
        CheckConstraint("payment_amount >= 0", name="amount"),
        CheckConstraint("(posting_status = 'posted') = (posted_at IS NOT NULL)", name="posted_at"),
    )

    payer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.payer.id"), nullable=False)
    trace_number: Mapped[str] = mapped_column(String(50), nullable=False)   # TRN02
    payment_method: Mapped[RemittancePaymentMethod] = mapped_column(
        enum_type(RemittancePaymentMethod, 3), nullable=False)
    payment_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    payment_date: Mapped[date] = mapped_column(nullable=False)
    payee_npi: Mapped[str | None] = mapped_column(String(10))
    posting_status: Mapped[PostingStatus] = mapped_column(enum_type(PostingStatus),
                                                          nullable=False,
                                                          default=PostingStatus.UNPOSTED.value)
    posted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    posted_at: Mapped[datetime | None]
    inbound_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.integration_message.id"))


class RemittanceClaim(Base, AdminMixin):
    """CLP loop."""
    __tablename__ = "remittance_claim"
    __table_args__ = (CheckConstraint("charge_amount >= 0", name="charge_amount"),)

    remittance_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.remittance.id",
                                                                ondelete="CASCADE"),
                                                     nullable=False, index=True)
    claim_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.claim.id"), index=True)
    patient_control_number: Mapped[str] = mapped_column(String(38), nullable=False)
    claim_status_code: Mapped[str] = mapped_column(String(2), nullable=False)
    charge_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    paid_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    patient_responsibility: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    payer_claim_control_number: Mapped[str | None] = mapped_column(String(50))


class RemittanceServiceLine(Base, AdminMixin):
    """SVC loop."""
    __tablename__ = "remittance_service_line"

    remittance_claim_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.remittance_claim.id", ondelete="CASCADE"), nullable=False, index=True)
    claim_line_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.claim_line.id"))
    procedure_code: Mapped[str] = mapped_column(String(10), nullable=False)
    charge_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    paid_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    units_paid: Mapped[Decimal | None] = mapped_column(Numeric(8, 3))


class RemittanceAdjustment(Base, AdminMixin):
    """CAS adjustment at claim or service-line level (exactly one)."""
    __tablename__ = "remittance_adjustment"
    __table_args__ = (CheckConstraint(
        "num_nonnulls(remittance_claim_id, remittance_service_line_id) = 1", name="one_level"),)

    remittance_claim_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.remittance_claim.id", ondelete="CASCADE"), index=True)
    remittance_service_line_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.remittance_service_line.id", ondelete="CASCADE"), index=True)
    group_code: Mapped[AdjustmentGroup] = mapped_column(enum_type(AdjustmentGroup, 2),
                                                        nullable=False)
    reason_code: Mapped[str] = mapped_column(String(5), nullable=False)   # CARC
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    quantity: Mapped[Decimal | None] = mapped_column(Numeric(8, 3))


class RemittanceRemark(Base, AdminMixin):
    """RARC remark codes (MOA / LQ), at claim or service-line level."""
    __tablename__ = "remittance_remark"
    __table_args__ = (CheckConstraint(
        "num_nonnulls(remittance_claim_id, remittance_service_line_id) = 1", name="one_level"),)

    remittance_claim_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.remittance_claim.id", ondelete="CASCADE"))
    remittance_service_line_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.remittance_service_line.id", ondelete="CASCADE"))
    remark_code: Mapped[str] = mapped_column(String(10), nullable=False)


class PatientPayment(Base, AdminMixin):
    """Copays and patient payments. Card payments go through a processor: only its
    reference is stored, and a CHECK rejects anything that looks like a card number. The
    receipt PDF is a file (``receipt_file_id``, D58), generated in the payment transaction."""
    __tablename__ = "patient_payment"
    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("is_refund = (refund_of_payment_id IS NOT NULL)", name="refund_link"),
        CheckConstraint("processor_reference IS NULL OR "
                        "regexp_replace(processor_reference, '[ -]', '', 'g') !~ '^[0-9]{13,19}$'",
                        name="no_card_number"),
        CheckConstraint("method <> 'card' OR processor_reference IS NOT NULL",
                        name="card_has_processor_ref"),
    )

    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"), nullable=False,
                                                  index=True)
    encounter_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.encounter.id"))
    appointment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.appointment.id"))
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    method: Mapped[PaymentMethod] = mapped_column(enum_type(PaymentMethod), nullable=False)
    processor_reference: Mapped[str | None] = mapped_column(String(100))
    collected_at: Mapped[datetime] = mapped_column(nullable=False)
    collected_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    is_refund: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    refund_of_payment_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.patient_payment.id"))
    #: Required (D104): the receipt is made in the same transaction as the payment.
    receipt_file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.binary_object.id"),
                                                       nullable=False)
