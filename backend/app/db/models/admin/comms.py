"""Object storage records, communication preferences, templates, outbound messages and eFax.

Bytes (documents, card images, audio, HL7/X12/fax payloads) live encrypted in SeaweedFS;
PostgreSQL keeps only the key, version, size and SHA-256 (Tech Arch §6)."""
from __future__ import annotations

import uuid
from datetime import datetime

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

from app.db.base import AdminMixin, Base, enum_type
from app.db.models.enums import (
    CommunicationChannel,
    CommunicationPurpose,
    DeliveryStatus,
    FaxDirection,
    FaxStatus,
    FilePurpose,
    FileState,
    ScanStatus,
)

SHA256 = "{col} ~ '^[0-9a-f]{{64}}$'"


class BinaryObject(Base, AdminMixin):
    """A stored file. Uploads stay unusable until the malware scan marks them clean.

    ``state`` follows the upload flow (API_STANDARDS §15): ``pending-upload`` → ``quarantined``
    → ``clean`` or ``rejected``. Only a clean file is attached or downloaded. A file the server
    makes itself (a receipt, an after-visit summary) is never uploaded, so it is clean from the
    start. ``wrapped_data_key`` is the file's data key, encrypted by core (envelope encryption);
    it is set once the file is clean, never before. A file that is not clean 24 hours after its
    last change (an upload never completed, a stuck scan, a rejected file) goes, row and stored
    bytes, through ``admin.list_unusable_files`` and ``admin.delete_unusable_files``, the only
    way a row leaves this table (migration 0014); a row still referenced is kept."""
    __tablename__ = "binary_object"
    __table_args__ = (
        # per tenant: a global unique would leak other tenants' keys through 23505 errors
        UniqueConstraint("tenant_id", "bucket", "storage_key", "storage_version_id",
                         postgresql_nulls_not_distinct=True),
        CheckConstraint(SHA256.format(col="sha256"), name="sha256_format"),
        CheckConstraint("size_bytes >= 0", name="size"),
        CheckConstraint("(scan_status = 'pending') = (scanned_at IS NULL)", name="scanned_at"),
        CheckConstraint("purpose NOT IN ('receipt', 'after-visit-summary') OR state = 'clean'",
                        name="generated_clean"),
        CheckConstraint("state = 'clean' OR wrapped_data_key IS NULL", name="key_when_clean"),
        CheckConstraint("state <> 'clean' OR scan_status = 'clean' "
                        "OR purpose IN ('receipt', 'after-visit-summary')",
                        name="clean_when_scanned"),
        # The purge's listing (0014): files that are not clean, oldest change first.
        Index("ix_binary_object_unusable", "updated_at", "id",
              postgresql_where=text("state <> 'clean'")),
    )

    bucket: Mapped[str] = mapped_column(String(100), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    storage_version_id: Mapped[str | None] = mapped_column(String(100))
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    original_filename: Mapped[str | None] = mapped_column(String(255))
    scan_status: Mapped[ScanStatus] = mapped_column(enum_type(ScanStatus), nullable=False,
                                                    default=ScanStatus.PENDING.value,
                                                    server_default=ScanStatus.PENDING.value)
    scanned_at: Mapped[datetime | None]
    retention_until: Mapped[datetime | None]
    purpose: Mapped[FilePurpose] = mapped_column(enum_type(FilePurpose), nullable=False)
    state: Mapped[FileState] = mapped_column(enum_type(FileState), nullable=False,
                                             default=FileState.PENDING_UPLOAD.value,
                                             server_default=FileState.PENDING_UPLOAD.value)
    wrapped_data_key: Mapped[str | None] = mapped_column(Text)


class CommunicationPreference(Base, AdminMixin):
    """Consent to be contacted per channel and purpose (SMS STOP lands here)."""
    __tablename__ = "communication_preference"
    __table_args__ = (UniqueConstraint("patient_id", "channel", "purpose"),)

    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id",
                                                             ondelete="CASCADE"),
                                                  nullable=False)
    channel: Mapped[CommunicationChannel] = mapped_column(enum_type(CommunicationChannel),
                                                          nullable=False)
    purpose: Mapped[CommunicationPurpose] = mapped_column(enum_type(CommunicationPurpose),
                                                          nullable=False)
    opted_in: Mapped[bool] = mapped_column(Boolean, nullable=False)
    changed_at: Mapped[datetime] = mapped_column(nullable=False)
    source: Mapped[str] = mapped_column(String(40), nullable=False, default="front-desk")


class MessageTemplate(Base, AdminMixin):
    __tablename__ = "message_template"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code", "channel", "language", "version"),
        CheckConstraint("channel <> 'email' OR subject IS NOT NULL", name="email_subject"),
    )

    code: Mapped[str] = mapped_column(String(60), nullable=False)
    channel: Mapped[CommunicationChannel] = mapped_column(enum_type(CommunicationChannel),
                                                          nullable=False)
    language: Mapped[str] = mapped_column(String(20), nullable=False, default="en")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    subject: Mapped[str | None] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    contains_phi: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class OutboundCommunication(Base, AdminMixin):
    """Delivery record. The rendered body is not stored: template + params reproduce it."""
    __tablename__ = "outbound_communication"
    __table_args__ = (
        Index("ix_outbound_communication_patient_time", "patient_id", "created_at"),
        CheckConstraint("status <> 'delivered' OR delivered_at IS NOT NULL",
                        name="delivered_at"),
    )

    patient_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.patient.id"))
    channel: Mapped[CommunicationChannel] = mapped_column(enum_type(CommunicationChannel),
                                                          nullable=False)
    purpose: Mapped[CommunicationPurpose] = mapped_column(enum_type(CommunicationPurpose),
                                                          nullable=False)
    template_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.message_template.id"))
    recipient_masked: Mapped[str] = mapped_column(String(100), nullable=False)
    appointment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clinical.appointment.id"))
    status: Mapped[DeliveryStatus] = mapped_column(enum_type(DeliveryStatus), nullable=False,
                                                   default=DeliveryStatus.QUEUED.value)
    provider: Mapped[str | None] = mapped_column(String(40))
    provider_message_id: Mapped[str | None] = mapped_column(String(100))
    sent_at: Mapped[datetime | None]
    delivered_at: Mapped[datetime | None]
    error_message: Mapped[str | None] = mapped_column(String(500))


class OutboundCommunicationParam(Base, AdminMixin):
    __tablename__ = "outbound_communication_param"
    __table_args__ = (UniqueConstraint("communication_id", "name"),)

    communication_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("admin.outbound_communication.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    value: Mapped[str] = mapped_column(String(1000), nullable=False)


class FaxTransmission(Base, AdminMixin):
    """Inbound / outbound eFax (vendor under a BAA). Inbound faxes become a quarantined
    DocumentReference with indexing_status 'pending' until staff file them."""
    __tablename__ = "fax_transmission"
    __table_args__ = (
        UniqueConstraint("tenant_id", "vendor_fax_id"),
        CheckConstraint("page_count IS NULL OR page_count >= 0", name="page_count"),
        CheckConstraint("direction = 'outbound' OR status IN ('received', 'failed')",
                        name="inbound_status"),
        CheckConstraint("direction = 'inbound' OR status <> 'received'", name="outbound_status"),
        CheckConstraint("status <> 'failed' OR error_message IS NOT NULL", name="failed_reason"),
    )

    direction: Mapped[FaxDirection] = mapped_column(enum_type(FaxDirection), nullable=False)
    status: Mapped[FaxStatus] = mapped_column(enum_type(FaxStatus), nullable=False)
    remote_number_masked: Mapped[str] = mapped_column(String(30), nullable=False)
    page_count: Mapped[int | None] = mapped_column(SmallInteger)
    vendor_fax_id: Mapped[str | None] = mapped_column(String(100))
    document_reference_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("clinical.document_reference.id"))
    sent_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("admin.app_user.id"))
    occurred_at: Mapped[datetime] = mapped_column(nullable=False)
    integration_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("admin.integration_message.id"))
    error_message: Mapped[str | None] = mapped_column(String(500))
