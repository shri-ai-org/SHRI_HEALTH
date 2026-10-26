"""Tenancy, settings, users / RBAC, terminology and picklists (normalized admin tables)."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
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
    TimestampMixin,
    UUIDPKMixin,
    VersionedMixin,
    enum_type,
)
from app.db.models.enums import SettingValueType

NPI_CHECK = "{col} IS NULL OR shri_npi_valid({col})"
STATE_CHECK = "{col} IS NULL OR {col} ~ '^[A-Z]{{2}}$'"


# =========================================================================== tenancy
class Tenant(Base, UUIDPKMixin, TimestampMixin):
    """A practice / physician group. Every tenant-scoped row points here; RLS isolates them.
    ``organization_id`` is the practice's own FHIR Organization (who it is to partners)."""
    __tablename__ = "tenant"
    __table_args__ = (
        CheckConstraint("slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'", name="slug_format"),
        CheckConstraint("market_profile IN ('US', 'IN')", name="market_profile"),
    )

    slug: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    legal_name: Mapped[str | None] = mapped_column(String(200))
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.organization.id", ondelete="RESTRICT", use_alter=True), unique=True)
    market_profile: Mapped[str] = mapped_column(String(2), nullable=False, default="US",
                                                server_default="US")
    timezone: Mapped[str] = mapped_column(String(64), nullable=False,
                                          default="America/New_York",
                                          server_default="America/New_York")
    ai_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                             server_default=text("true"))   # org kill switch
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                            server_default=text("true"))


class MrnCounter(Base, AdminMixin):
    """One medical record number counter per practice (D41): the practice prefix plus a number,
    never reused, e.g. ``TEST-000123``. ``admin.next_mrn()`` returns the practice's MRN system
    and the next value inside the registration transaction: the row lock serializes
    registrations, so no two patients get the same number, and a registration that rolls back
    gives its number back. The MRN itself is an ``identifier`` row (type MR) with that system.
    The database lets the number only grow, and the prefix and system change only until the
    first MRN is issued (``shri_mrn_counter_guard``). No role may delete the row."""
    __tablename__ = "mrn_counter"
    __table_args__ = (
        UniqueConstraint("tenant_id"),
        CheckConstraint("prefix ~ '^[A-Z0-9]{1,10}$'", name="prefix_format"),
        CheckConstraint("system ~ '^(urn:|https?://)'", name="system_uri"),
        CheckConstraint("next_value >= 1", name="next_value_positive"),
    )

    prefix: Mapped[str] = mapped_column(String(10), nullable=False)
    #: The practice's MRN identifier system (D41).
    system: Mapped[str] = mapped_column(String(300), nullable=False)
    next_value: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1,
                                            server_default=text("1"))


class SettingDefinition(Base, UUIDPKMixin, TimestampMixin):
    """Platform catalogue of tenant settings (replaces free-form settings JSON)."""
    __tablename__ = "setting_definition"
    __table_args__ = (CheckConstraint("key ~ '^[a-z][a-z0-9_.]{2,99}$'", name="key_format"),)

    key: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    value_type: Mapped[SettingValueType] = mapped_column(enum_type(SettingValueType),
                                                         nullable=False)
    default_value: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str] = mapped_column(String(500), nullable=False)


#: Platform settings seeded into ``setting_definition`` (key, value type, default, description).
#: Keys are lower case (``key_format``); the repository maps them to the contract's camelCase.
SETTINGS: list[tuple[str, SettingValueType, str, str]] = [
    ("registration.show_sexual_orientation_and_gender_identity", SettingValueType.BOOLEAN,
     "false", "Show sexual orientation and gender identity at registration (D39, A49). "
     "Off by default: the practice turns it on."),
]


class TenantSetting(Base, AdminMixin):
    __tablename__ = "tenant_setting"
    __table_args__ = (UniqueConstraint("tenant_id", "setting_key"),)

    setting_key: Mapped[str] = mapped_column(
        ForeignKey("admin.setting_definition.key", onupdate="CASCADE"), nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)


class Facility(Base, AdminMixin, VersionedMixin):
    """Billing / operational attributes of a practice site. The site itself is a FHIR
    Location (``location_id``); rooms are child Locations of it."""
    __tablename__ = "facility"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code"),
        CheckConstraint(NPI_CHECK.format(col="npi"), name="npi_valid"),
        CheckConstraint("clia_number IS NULL OR clia_number ~ '^[0-9]{2}D[0-9]{7}$'",
                        name="clia_format"),
        CheckConstraint("place_of_service_code ~ '^[0-9]{2}$'", name="pos_format"),
    )

    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.location.id"),
                                                   nullable=False,
                                                   unique=True)
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    npi: Mapped[str | None] = mapped_column(String(10))
    clia_number: Mapped[str | None] = mapped_column(String(10))
    tax_id_ref: Mapped[str | None] = mapped_column(String(200))     # OpenBao reference, not TIN
    place_of_service_code: Mapped[str] = mapped_column(String(2), nullable=False, default="11",
                                                       server_default="11")
    # IANA time zone; appointments display in facility time (D40). Required (A45).
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    is_billing_location: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                                      server_default=text("true"))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                            server_default=text("true"))


# =========================================================================== users / RBAC
class AppUser(Base, UUIDPKMixin, OptionalTenantMixin, TimestampMixin):
    """Application profile of a Keycloak identity. tenant_id NULL = Shri platform staff, who
    get no clinical access by default."""
    __tablename__ = "app_user"
    __table_args__ = (
        UniqueConstraint("tenant_id", "username", postgresql_nulls_not_distinct=True),
        CheckConstraint("email IS NULL OR email ~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'",
                        name="email_format"),
    )

    keycloak_subject: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    username: Mapped[str] = mapped_column(String(150), nullable=False)
    email: Mapped[str | None] = mapped_column(String(254))
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    practitioner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.practitioner.id", use_alter=True), unique=True)
    mfa_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                               server_default=text("true"))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                            server_default=text("true"))
    last_login_at: Mapped[datetime | None]


class Permission(Base, UUIDPKMixin):
    """Global permission catalogue: 'note.sign', 'order.lab.create', 'ai.killswitch' ..."""
    __tablename__ = "permission"
    __table_args__ = (CheckConstraint("code ~ '^[a-z][a-z0-9_.]{2,99}$'", name="code_format"),)

    code: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    is_clinical: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                              server_default=text("false"))


class Role(Base, UUIDPKMixin, OptionalTenantMixin, TimestampMixin):
    __tablename__ = "role"
    __table_args__ = (UniqueConstraint("tenant_id", "code", postgresql_nulls_not_distinct=True),)

    code: Mapped[str] = mapped_column(String(60), nullable=False)   # clinician, front-desk ...
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                            server_default=text("false"))


class RolePermission(Base, OptionalTenantMixin):
    """tenant_id NULL = permission of a platform (system) role."""
    __tablename__ = "role_permission"

    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.role.id", ondelete="CASCADE"),
                                               primary_key=True)
    permission_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.permission.id", ondelete="CASCADE"), primary_key=True)


class UserRole(Base, AdminMixin):
    """Role assignment, optionally limited to one facility and a validity window."""
    __tablename__ = "user_role"
    __table_args__ = (
        UniqueConstraint("user_id", "role_id", "facility_id", postgresql_nulls_not_distinct=True),
        CheckConstraint("valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from",
                        name="valid_period"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.app_user.id", ondelete="CASCADE"),
                                               nullable=False, index=True)
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.role.id"), nullable=False)
    facility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.facility.id"))
    valid_from: Mapped[date | None]
    valid_to: Mapped[date | None]


class CareTeamMember(Base, AdminMixin):
    """Patient-relationship access scope (FR-PAT-02 'restrict by patient relationships')."""
    __tablename__ = "care_team_member"
    __table_args__ = (
        CheckConstraint("num_nonnulls(practitioner_id, user_id) = 1", name="one_member"),
        CheckConstraint("period_end IS NULL OR period_end >= period_start", name="period"),
    )

    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id",
                                                             ondelete="CASCADE"),
                                                  nullable=False, index=True)
    practitioner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey(
        "clinical.practitioner.id"))
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    role_code: Mapped[str] = mapped_column(String(40), nullable=False)   # pcp, care-manager
    period_start: Mapped[date] = mapped_column(nullable=False)
    period_end: Mapped[date | None]


class CosignRule(Base, AdminMixin):
    """FR-ENC-01: supervising-physician co-signature for NPs / PAs, configurable by state."""
    __tablename__ = "cosign_rule"
    __table_args__ = (
        CheckConstraint("supervisee_practitioner_id <> supervising_practitioner_id",
                        name="distinct_people"),
        CheckConstraint(STATE_CHECK.format(col="state"), name="state_format"),
        CheckConstraint("applies_to_notes OR applies_to_prescriptions OR applies_to_orders",
                        name="applies_to_something"),
        CheckConstraint("effective_to IS NULL OR effective_to >= effective_from", name="period"),
    )

    supervisee_practitioner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clinical.practitioner.id"), nullable=False, index=True)
    supervising_practitioner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clinical.practitioner.id"), nullable=False)
    state: Mapped[str | None] = mapped_column(String(2))
    applies_to_notes: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    applies_to_prescriptions: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    applies_to_orders: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    cosign_within_days: Mapped[int | None] = mapped_column(SmallInteger)
    effective_from: Mapped[date] = mapped_column(nullable=False)
    effective_to: Mapped[date | None]


# =========================================================================== terminology
class CodeSystem(Base, UUIDPKMixin, TimestampMixin):
    """Registered code systems (platform-wide). CodeableConcept ``*_system`` columns FK here."""
    __tablename__ = "code_system"

    code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    uri: Mapped[str] = mapped_column(String(300), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    version: Mapped[str | None] = mapped_column(String(40))
    license_note: Mapped[str | None] = mapped_column(String(500))


class Concept(Base, UUIDPKMixin, TimestampMixin):
    """Terminology content (ICD-10-CM, LOINC, RxNorm ...), loaded per licence."""
    __tablename__ = "concept"
    __table_args__ = (
        UniqueConstraint("code_system_id", "code"),
        CheckConstraint("effective_to IS NULL OR effective_from IS NULL "
                        "OR effective_to >= effective_from", name="period"),
        Index("ix_concept_display_trgm", "display", postgresql_using="gin",
              postgresql_ops={"display": "gin_trgm_ops"}),
    )

    code_system_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.code_system.id"),
                                                      nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    display: Mapped[str] = mapped_column(String(500), nullable=False)
    is_billable: Mapped[bool | None] = mapped_column(Boolean)   # ICD-10-CM leaf codes
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    effective_from: Mapped[date | None]
    effective_to: Mapped[date | None]


class ConceptProperty(Base, UUIDPKMixin):
    """Concept properties (RxNorm TTY, LOINC class, DEA schedule ...), one row per value."""
    __tablename__ = "concept_property"
    __table_args__ = (UniqueConstraint("concept_id", "property", "value"),)

    concept_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.concept.id",
                                                             ondelete="CASCADE"),
                                                  nullable=False)
    property: Mapped[str] = mapped_column(String(60), nullable=False)
    value: Mapped[str] = mapped_column(String(500), nullable=False)


class Picklist(Base, AdminMixin):
    """Tenant picklists (replaces OpenEMR list_options): cancellation reasons, rooms ..."""
    __tablename__ = "picklist"
    __table_args__ = (UniqueConstraint("tenant_id", "code"),)

    code: Mapped[str] = mapped_column(String(60), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)


class PicklistItem(Base, AdminMixin):
    __tablename__ = "picklist_item"
    __table_args__ = (
        UniqueConstraint("picklist_id", "code"),
        CheckConstraint("(maps_to_system IS NULL) = (maps_to_code IS NULL)", name="map_pair"),
    )

    picklist_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.picklist.id",
                                                              ondelete="CASCADE"),
                                                   nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    display: Mapped[str] = mapped_column(String(500), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    maps_to_system: Mapped[str | None] = mapped_column(ForeignKey("admin.code_system.uri",
                                                                  onupdate="CASCADE"))
    maps_to_code: Mapped[str | None] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
