"""Declarative base, column types and mixins shared by every table.

Two families of tables share this base:

* FHIR resource tables (``app.db.models.fhir``): one table per FHIR R4 resource, columns named
  after FHIR elements, repeating elements in child tables. Columns carry ``info`` metadata
  (see ``app.db.fhir_types``) that drives the FHIR CHECK constraints and the FHIR facade.
* Admin tables (``app.db.models.admin``): ordinary 3NF tables for non-clinical features.

Three PostgreSQL schemas, one database (ADR-0011 condition 4, D23):

* ``clinical`` - every FHIR resource/child table, plus ``fhir_resource_history``.
* ``audit``    - exactly ``audit_event`` and ``break_glass_access``.
* ``admin``    - every other admin table.

Schema assignment happens once, automatically, in ``Base.__init_subclass__`` below - no
individual table class needs to know or declare its own schema. This keeps all 218 tables on
one shared ``MetaData`` (so bare ``ForeignKey("table.column")`` strings still resolve across
schema boundaries, e.g. a clinical table referencing ``tenant.id`` in ``admin``), while giving
each ``Table`` the correct ``schema=`` for CREATE TABLE / RLS / grants.

Conventions
-----------
* UUID primary keys (uuid4 in Python - D29: UUIDv7 is not adopted, it exposes creation time).
  For FHIR tables the primary key is also the FHIR logical id.
* Every tenant-scoped table has ``tenant_id`` and forced row-level security.
* Enumerations are VARCHAR + named CHECK (never native PG ENUM), values are FHIR codes.
* Constraint names follow ``NAMING_CONVENTION``; long names are shortened with a hash.
* Every computed column is STORED (D34) - see ``tests/test_db_rules.py::test_no_virtual_columns``.
"""
from __future__ import annotations

import enum
import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, ClassVar

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    MetaData,
    Numeric,
    String,
    Time,
    func,
    text,
)
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

MONEY = Numeric(12, 2)

# ----------------------------------------------------------------- schema assignment (D23)
CLINICAL_SCHEMA = "clinical"
ADMIN_SCHEMA = "admin"
AUDIT_SCHEMA = "audit"

#: The only two tables DATA_OWNERSHIP.md's "Au" pattern names explicitly. Every other admin
#: table (everything else under app.db.models.admin) defaults to ADMIN_SCHEMA.
AUDIT_TABLES = frozenset({"audit_event", "break_glass_access"})

#: fhir_resource_history (app.db.models.fhir.records) uses only TenantMixin, not
#: FhirResourceMixin/FhirChildMixin (it's the versioning store, not a resource) - so it's
#: NOT skipped by the FhirResourceMixin/FhirChildMixin check in __init_subclass__ below, and
#: would otherwise fall through to ADMIN_SCHEMA. It belongs in CLINICAL_SCHEMA instead (tightly
#: coupled to clinical resource versioning; DATA_OWNERSHIP's "Au" pattern names only the two
#: AUDIT_TABLES above, not resource history).
_CLINICAL_NON_MIXIN_TABLES = frozenset({"fhir_resource_history"})


def admin_schema_for(tablename: str | None) -> str:
    """Schema for a table that is NOT a FHIR resource/child (i.e. not routed through
    FhirResourceMixin/FhirChildMixin, which hardcode CLINICAL_SCHEMA directly)."""
    if tablename in _CLINICAL_NON_MIXIN_TABLES:
        return CLINICAL_SCHEMA
    if tablename in AUDIT_TABLES:
        return AUDIT_SCHEMA
    return ADMIN_SCHEMA


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map = {
        uuid.UUID: UUID(as_uuid=True),
        datetime: DateTime(timezone=True),
        date: Date,
        time: Time,
        dict[str, Any]: JSONB,
        Decimal: MONEY,
    }

    def __init_subclass__(cls, **kw: Any) -> None:
        """Inject ``{"schema": ...}`` into every mapped table's ``__table_args__``.

        Admin tables set ``__table_args__`` directly, as a plain tuple, in their own class body
        - that tuple already exists in ``cls.__dict__`` by the time this hook runs (after the
        class body executes, before SQLAlchemy builds the ``Table``), so we can safely append to
        it here. FHIR resource/child tables get their schema from
        ``FhirResourceMixin``/``FhirChildMixin`` instead (they already own ``__table_args__`` via
        ``declared_attr``, which this hook must not shadow), so they're skipped here.
        """
        if not issubclass(cls, (FhirResourceMixin, FhirChildMixin)):
            tablename = cls.__dict__.get("__tablename__") or getattr(cls, "__tablename__", None)
            if tablename is not None:
                schema_arg = {"schema": admin_schema_for(tablename)}
                existing = cls.__dict__.get("__table_args__")
                if existing is None:
                    cls.__table_args__ = (schema_arg,)
                elif isinstance(existing, dict):
                    cls.__table_args__ = {**existing, **schema_arg}
                else:
                    cls.__table_args__ = (*existing, schema_arg)
        super().__init_subclass__(**kw)


def enum_type(enum_cls: type[enum.Enum], length: int = 40) -> SAEnum:
    """VARCHAR enum storing the enum *value* (the FHIR code). The CHECK is added per column by
    ``constraints.apply_enum_checks`` (named ``ck_<table>_<column>_codes``)."""
    return SAEnum(enum_cls, native_enum=False, create_constraint=False, length=length,
                  name=enum_cls.__name__.lower(),
                  values_callable=lambda members: [m.value for m in members],
                  validate_strings=True)


def code_array_check(column: str, enum_cls: type[enum.Enum], name: str) -> CheckConstraint:
    """0..* FHIR ``code`` stored as varchar[]: every element must be a value of ``enum_cls``."""
    values = ", ".join(f"'{m.value}'" for m in enum_cls)
    return CheckConstraint(f"{column} <@ ARRAY[{values}]::varchar[]", name=name)



# --------------------------------------------------------------------------- mixins
class UUIDPKMixin:
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now(),
                                                 nullable=False)


class ActorMixin:
    @declared_attr
    def created_by_user_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.app_user.id", ondelete="SET NULL"))

    @declared_attr
    def updated_by_user_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.app_user.id", ondelete="SET NULL"))


class VersionedMixin:
    """A1/If-Match target (ADR-0008): admin tables with no FHIR meta_version_id of their own
    (A41/issue #13 - practice-setup resources and patient_pharmacy). ``version`` is bumped by
    the ``shri_bump_version()`` trigger (sql/10_rules.sql) on every UPDATE, server-side only -
    the column is never written by the application, including on the row that sets it."""
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1,
                                         server_default=text("1"))


class TenantMixin:
    """Row belongs to exactly one tenant (practice). RLS-protected."""

    @declared_attr
    def tenant_id(cls) -> Mapped[uuid.UUID]:
        return mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.tenant.id", ondelete="RESTRICT"),
                             nullable=False, index=True)


class OptionalTenantMixin:
    """NULL tenant_id = platform-wide row (system roles, shared guidelines, platform staff)."""

    @declared_attr
    def tenant_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.tenant.id", ondelete="RESTRICT"),
                             index=True)


class AdminMixin(UUIDPKMixin, TenantMixin, TimestampMixin, ActorMixin):
    """Default for tenant-scoped admin tables."""


class ProvenanceMixin:
    """FR-PAT-02: distinguish verified, imported, patient-reported and AI-generated content.

    Exposed in FHIR as ``meta.tag`` (entry source) and ``meta.source`` (source system).
    """

    @declared_attr
    def entry_source(cls) -> Mapped[str]:
        from app.db.models.enums import EntrySource
        return mapped_column(enum_type(EntrySource), nullable=False,
                             default=EntrySource.CLINICIAN.value,
                             server_default=EntrySource.CLINICIAN.value)

    source_system: Mapped[str | None] = mapped_column(String(100))      # openemr, quest, ccda
    source_record_id: Mapped[str | None] = mapped_column(String(200))   # original identifier

    @declared_attr
    def verified_by_user_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.app_user.id", ondelete="SET NULL"))

    verified_at: Mapped[datetime | None]

    @declared_attr
    def ai_suggestion_id(cls) -> Mapped[uuid.UUID | None]:
        # use_alter breaks the ai_suggestion <-> patient/encounter creation cycle. RESTRICT:
        # a suggestion can never be deleted out from under the clinical row it produced.
        return mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.ai_suggestion.id", ondelete="RESTRICT",
                                        use_alter=True))


class FhirResourceMixin(UUIDPKMixin, TenantMixin, TimestampMixin, ActorMixin):
    """Root table of a FHIR resource.

    ``meta_version_id`` / ``meta_last_updated`` are maintained by database triggers (one
    version per transaction, child-table changes included) and every version is snapshotted
    into ``fhir_resource_history`` at commit, which backs ``_history`` and ``vread``.
    """
    fhir_type: ClassVar[str]
    #: Columns whose change alone is not a new version (no meta_version_id bump, no history
    #: row): the trigger shri_fhir_version() gets them as arguments (migration 0013).
    fhir_unversioned_columns: ClassVar[tuple[str, ...]] = ()

    meta_version_id: Mapped[int] = mapped_column(Integer, nullable=False, default=1,
                                                 server_default=text("1"))
    meta_last_updated: Mapped[datetime] = mapped_column(nullable=False,
                                                        server_default=func.now())
    meta_txid: Mapped[int | None] = mapped_column(BigInteger)   # internal: version-bump guard

    @declared_attr
    def meta_security(cls) -> Mapped[list[str]]:
        # v3 confidentiality / sensitivity labels (R, V, PSY, SUD ...): 42 CFR Part 2 in P1.
        return mapped_column(ARRAY(String(10)), nullable=False, default=list,
                             server_default=text("'{}'"),
                             info={"fhir": "meta.security", "fhir_type": "Coding"})

    @declared_attr
    def extension(cls) -> Mapped[list[dict[str, Any]]]:
        # Extensions this schema does not model (kept verbatim from C-CDA / partner imports).
        return mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'"))

    @declared_attr.directive
    def __table_args__(cls) -> tuple[Any, ...]:
        return cls.resource_table_args()

    @classmethod
    def resource_table_args(cls) -> tuple[Any, ...]:
        from app.db.models.enums import SecurityLabel
        return (
            code_array_check("meta_security", SecurityLabel, "meta_security_codes"),
            CheckConstraint("jsonb_typeof(extension) = 'array'", name="extension_is_array"),
            *getattr(cls, "__extra_args__", ()),
            {"schema": CLINICAL_SCHEMA},
        )


class ClinicalResourceMixin(FhirResourceMixin, ProvenanceMixin):
    """FHIR resource that is part of the clinical record (carries provenance)."""


class FhirChildMixin(UUIDPKMixin, TenantMixin, TimestampMixin):
    """Backbone element / repeating element of a FHIR resource, stored as a child row.

    Changes to child rows bump the parent's ``meta_version_id`` (trigger) and are included in
    the parent's history snapshot. Child rows may be deleted while the parent is editable;
    guard triggers block changes once the parent is signed / final.
    """
    fhir_parent: ClassVar[tuple[str, ...]]   # FK column(s) pointing at the parent row(s)

    @declared_attr.directive
    def __table_args__(cls) -> tuple[Any, ...]:
        return (*tuple(getattr(cls, "__extra_args__", ())), {"schema": CLINICAL_SCHEMA})
