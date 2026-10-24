"""Pharmacy directory, preferred pharmacies and e-prescribing transactions (FR-MED-01).

The prescription is the FHIR MedicationRequest; NCPDP SCRIPT traffic with the eRx vendor is
tracked here. There is no in-house dispensing (FRS §9)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (Boolean, CheckConstraint, ForeignKey, Index, String, UniqueConstraint,
                        text)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import AdminMixin, Base, TimestampMixin, UUIDPKMixin, VersionedMixin, enum_type
from app.db.models.enums import ErxMessageType, ErxTransactionStatus, MessageDirection


class Pharmacy(Base, UUIDPKMixin, TimestampMixin):
    """Platform-wide directory synced from the eRx vendor. Exposed as FHIR Organization."""
    __tablename__ = "pharmacy"
    __table_args__ = (
        CheckConstraint("ncpdp_id ~ '^[0-9]{7}$'", name="ncpdp_format"),
        CheckConstraint("npi IS NULL OR shri_npi_valid(npi)", name="npi_valid"),
        CheckConstraint("state IS NULL OR state ~ '^[A-Z]{2}$'", name="state_format"),
        Index("ix_pharmacy_name_trgm", "name", postgresql_using="gin",
              postgresql_ops={"name": "gin_trgm_ops"}),
        Index("ix_pharmacy_postal", "postal_code"),
    )

    ncpdp_id: Mapped[str] = mapped_column(String(7), nullable=False, unique=True)
    npi: Mapped[str | None] = mapped_column(String(10))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(30))
    fax: Mapped[str | None] = mapped_column(String(30))
    address_line: Mapped[str | None] = mapped_column(String(200))
    city: Mapped[str | None] = mapped_column(String(100))
    state: Mapped[str | None] = mapped_column(String(2))
    postal_code: Mapped[str | None] = mapped_column(String(10))
    is_mail_order: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class PharmacyServiceLevel(Base):
    """SCRIPT service levels a pharmacy accepts (new, refill, change, cancel, controlled)."""
    __tablename__ = "pharmacy_service_level"
    __table_args__ = (CheckConstraint(
        "service_level IN ('new', 'refill', 'change', 'cancel', 'controlled', 'rx-history')",
        name="service_level_code"),)

    pharmacy_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.pharmacy.id", ondelete="CASCADE"),
                                                   primary_key=True)
    service_level: Mapped[str] = mapped_column(String(20), primary_key=True)


class PatientPharmacy(Base, AdminMixin, VersionedMixin):
    """The patient's chosen pharmacies; at most one default."""
    __tablename__ = "patient_pharmacy"
    __table_args__ = (
        UniqueConstraint("patient_id", "pharmacy_id"),
        Index("uq_patient_pharmacy_one_default", "patient_id", unique=True,
              postgresql_where=text("is_default")),
    )

    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id", ondelete="CASCADE"),
                                                  nullable=False)
    pharmacy_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("admin.pharmacy.id"), nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class ErxTransaction(Base, AdminMixin):
    """One NCPDP SCRIPT message with the eRx vendor (NewRx, CancelRx, RxRenewalRequest ...).
    Inbound renewal / change requests may arrive before they are matched to a prescription."""
    __tablename__ = "erx_transaction"
    __table_args__ = (
        UniqueConstraint("tenant_id", "vendor_message_id"),
        Index("ix_erx_transaction_request", "medication_request_id", "occurred_at"),
        CheckConstraint("direction = 'inbound' OR medication_request_id IS NOT NULL",
                        name="outbound_has_request"),
        CheckConstraint("status <> 'error' OR error_message IS NOT NULL", name="error_message"),
    )

    medication_request_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.medication_request.id"))
    patient_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.patient.id"), index=True)
    pharmacy_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.pharmacy.id"))
    message_type: Mapped[ErxMessageType] = mapped_column(enum_type(ErxMessageType),
                                                         nullable=False)
    direction: Mapped[MessageDirection] = mapped_column(enum_type(MessageDirection),
                                                        nullable=False)
    status: Mapped[ErxTransactionStatus] = mapped_column(enum_type(ErxTransactionStatus),
                                                         nullable=False)
    vendor_message_id: Mapped[str | None] = mapped_column(String(100))
    related_transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.erx_transaction.id"))     # response -> request
    integration_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.integration_message.id"))
    occurred_at: Mapped[datetime] = mapped_column(nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(20))
    error_message: Mapped[str | None] = mapped_column(String(500))
