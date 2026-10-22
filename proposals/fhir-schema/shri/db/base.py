"""Declarative base, column types and mixins shared by every table.

Two families of tables share this base:

* FHIR resource tables (``shri.models.fhir``): one table per FHIR R4 resource, columns named
  after FHIR elements, repeating elements in child tables. Columns carry ``info`` metadata
  (see ``shri.db.fhir_types``) that drives the FHIR CHECK constraints and the FHIR facade.
* Admin tables (``shri.models.admin``): ordinary 3NF tables for non-clinical features.

Conventions
-----------
* UUID primary keys (uuid4 in Python; switch the server default to ``uuidv7()`` on PG 18).
  For FHIR tables the primary key is also the FHIR logical id.
* Every tenant-scoped table has ``tenant_id`` and forced row-level security (``rls.py``).
* Enumerations are VARCHAR + named CHECK (never native PG ENUM), values are FHIR codes.
* Constraint names follow ``NAMING_CONVENTION``; long names are shortened with a hash.
"""
from __future__ import annotations

import enum
import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, ClassVar

from sqlalchemy import (BigInteger, CheckConstraint, Date, DateTime, Enum as SAEnum, ForeignKey,
                        Integer, MetaData, Numeric, String, Time, func, text)
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
        return mapped_column(ForeignKey("app_user.id", ondelete="SET NULL"))

    @declared_attr
    def updated_by_user_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(ForeignKey("app_user.id", ondelete="SET NULL"))


class TenantMixin:
    """Row belongs to exactly one tenant (practice). RLS-protected."""

    @declared_attr
    def tenant_id(cls) -> Mapped[uuid.UUID]:
        return mapped_column(ForeignKey("tenant.id", ondelete="RESTRICT"), nullable=False,
                             index=True)


class OptionalTenantMixin:
    """NULL tenant_id = platform-wide row (system roles, shared guidelines, platform staff)."""

    @declared_attr
    def tenant_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(ForeignKey("tenant.id", ondelete="RESTRICT"), index=True)


class AdminMixin(UUIDPKMixin, TenantMixin, TimestampMixin, ActorMixin):
    """Default for tenant-scoped admin tables."""


class ProvenanceMixin:
    """FR-PAT-02: distinguish verified, imported, patient-reported and AI-generated content.

    Exposed in FHIR as ``meta.tag`` (entry source) and ``meta.source`` (source system).
    """

    @declared_attr
    def entry_source(cls) -> Mapped[str]:
        from shri.models.enums import EntrySource
        return mapped_column(enum_type(EntrySource), nullable=False,
                             default=EntrySource.CLINICIAN.value,
                             server_default=EntrySource.CLINICIAN.value)

    source_system: Mapped[str | None] = mapped_column(String(100))      # openemr, quest, ccda
    source_record_id: Mapped[str | None] = mapped_column(String(200))   # original identifier

    @declared_attr
    def verified_by_user_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(ForeignKey("app_user.id", ondelete="SET NULL"))

    verified_at: Mapped[datetime | None]

    @declared_attr
    def ai_suggestion_id(cls) -> Mapped[uuid.UUID | None]:
        # use_alter breaks the ai_suggestion <-> patient/encounter creation cycle. RESTRICT:
        # a suggestion can never be deleted out from under the clinical row it produced.
        return mapped_column(ForeignKey("ai_suggestion.id", ondelete="RESTRICT", use_alter=True))


class FhirResourceMixin(UUIDPKMixin, TenantMixin, TimestampMixin, ActorMixin):
    """Root table of a FHIR resource.

    ``meta_version_id`` / ``meta_last_updated`` are maintained by database triggers (one
    version per transaction, child-table changes included) and every version is snapshotted
    into ``fhir_resource_history`` at commit, which backs ``_history`` and ``vread``.
    """
    fhir_type: ClassVar[str]

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
    def __table_args__(cls) -> tuple:
        return cls.resource_table_args()

    @classmethod
    def resource_table_args(cls) -> tuple:
        from shri.models.enums import SecurityLabel
        return (
            code_array_check("meta_security", SecurityLabel, "meta_security_codes"),
            CheckConstraint("jsonb_typeof(extension) = 'array'", name="extension_is_array"),
            *getattr(cls, "__extra_args__", ()),
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
    def __table_args__(cls) -> tuple:
        return tuple(getattr(cls, "__extra_args__", ()))
