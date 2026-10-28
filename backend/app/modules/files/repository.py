"""Reads and writes of ``admin.binary_object`` for the file service, in plain SQL under the
request's session.

Row-level security does the clinic filtering: the session from ``tenant_db`` sees only the
caller's clinic, so another clinic's file is simply not found, and no query here names a tenant
except the insert, which must fill ``tenant_id`` (the session's clinic; the policy's WITH CHECK
refuses any other). ``shri_app`` may insert and update files but never delete one: rows leave
only through the purge (purge.py, migration 0014).

Contract to column (``backend/app/db/CLAUDE.md``, "Files"): ``FilePurpose`` is ``purpose``, the
file state is ``state``; ``sizeBytes``, ``contentType`` and ``sha256`` are their columns. A
pending upload's ``sha256`` and ``size_bytes`` are what the client declared; the scan checks the
bytes against them before the file is clean.

Where a file is attached, which says whose chart it is part of (``attachment_patients``):

- ``insurance-card``: ``clinical.coverage_card_image.binary_object_id``, the coverage's
  ``beneficiary_patient_id``;
- ``identity`` and ``after-visit-summary``: ``clinical.document_reference_content.
  attachment_binary_object_id``, the document's ``subject_patient_id`` (a license image is a
  document with category ``identity`` that the identifier's ``supporting_document_id`` points at,
  D56; an after-visit summary is a generated document);
- ``receipt``: ``admin.patient_payment.receipt_file_id``, the payment's ``patient_id``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import TextClause

from app.core.access import ensure_chart_access
from app.core.db import TENANT_ID_INFO_KEY
from app.core.deps import CurrentUser


@dataclass(frozen=True)
class FileRecord:
    id: UUID
    tenant_id: UUID
    bucket: str
    storage_key: str
    content_type: str
    size_bytes: int
    sha256: str
    purpose: str
    state: str
    created_by_user_id: UUID | None
    wrapped_data_key: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class NewUpload:
    id: UUID
    bucket: str
    storage_key: str
    content_type: str
    size_bytes: int
    sha256: str
    purpose: str
    user_id: UUID


@dataclass(frozen=True)
class Attachment:
    """Whether the file is attached to a record, and the patients of those records."""

    attached: bool
    patient_ids: frozenset[UUID]


class FileRepository(Protocol):
    async def insert_upload(self, db: AsyncSession, upload: NewUpload) -> None: ...

    async def get(self, db: AsyncSession, file_id: UUID, *, lock: bool = False
                  ) -> FileRecord | None:
        """The clinic's file, or None; ``lock`` takes the row (``FOR UPDATE``)."""
        ...

    async def mark_quarantined(self, db: AsyncSession, file_id: UUID) -> None: ...

    async def mark_clean(self, db: AsyncSession, file_id: UUID, *, bucket: str,
                         wrapped_data_key: str) -> None: ...

    async def mark_rejected(self, db: AsyncSession, file_id: UUID, *, scan_status: str
                            ) -> None:
        """``scan_status`` ``infected`` after a scan, ``pending`` when the bytes failed the
        checks before it (size, SHA-256, content type) and were never scanned."""
        ...

    async def attachment(self, db: AsyncSession, file: FileRecord) -> Attachment: ...

    async def ensure_chart_access(self, db: AsyncSession, user: CurrentUser,
                                  patient_id: UUID) -> None:
        """Core's ``ensure_chart_access``: 403 ``break-glass-required`` for a restricted chart
        the user may not open (audited)."""
        ...


_SELECT = """
SELECT id, tenant_id, bucket, storage_key, content_type, size_bytes, sha256, purpose,
       state, created_by_user_id, wrapped_data_key
FROM admin.binary_object WHERE id = :id
"""
_GET = text(_SELECT)
_GET_FOR_UPDATE = text(_SELECT + "FOR UPDATE")
_INSERT = text("""
INSERT INTO admin.binary_object
    (id, tenant_id, bucket, storage_key, content_type, size_bytes, sha256, purpose, state,
     scan_status, created_by_user_id, updated_by_user_id)
VALUES (:id, :tenant_id, :bucket, :storage_key, :content_type, :size_bytes, :sha256, :purpose,
        'pending-upload', 'pending', :user_id, :user_id)
""")
_QUARANTINED = text("""
UPDATE admin.binary_object
   SET state = 'quarantined', updated_at = now(),
       updated_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
WHERE id = :id AND state = 'pending-upload'
""")
_CLEAN = text("""
UPDATE admin.binary_object
   SET state = 'clean', scan_status = 'clean', scanned_at = now(), bucket = :bucket,
       wrapped_data_key = :wrapped_data_key, updated_at = now(),
       updated_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
WHERE id = :id AND state = 'quarantined'
""")
_REJECTED = text("""
UPDATE admin.binary_object
   SET state = 'rejected', scan_status = :scan_status,
       scanned_at = CASE WHEN CAST(:scanned AS boolean) THEN now() END, updated_at = now(),
       updated_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
WHERE id = :id AND state = 'quarantined'
""")
_CARD = text("""
SELECT c.beneficiary_patient_id AS patient_id
FROM clinical.coverage_card_image i JOIN clinical.coverage c ON c.id = i.coverage_id
WHERE i.binary_object_id = :id
""")
_DOCUMENT = text("""
SELECT d.subject_patient_id AS patient_id
FROM clinical.document_reference_content dc
JOIN clinical.document_reference d ON d.id = dc.document_reference_id
WHERE dc.attachment_binary_object_id = :id
""")
_RECEIPT = text("SELECT patient_id FROM admin.patient_payment WHERE receipt_file_id = :id")
_ATTACHMENTS = {"insurance-card": _CARD, "identity": _DOCUMENT,
                "after-visit-summary": _DOCUMENT, "receipt": _RECEIPT}


class SqlFileRepository:
    async def insert_upload(self, db: AsyncSession, upload: NewUpload) -> None:
        await db.execute(_INSERT, {
            "id": upload.id, "tenant_id": db.info[TENANT_ID_INFO_KEY], "bucket": upload.bucket,
            "storage_key": upload.storage_key, "content_type": upload.content_type,
            "size_bytes": upload.size_bytes, "sha256": upload.sha256,
            "purpose": upload.purpose, "user_id": upload.user_id})

    async def get(self, db: AsyncSession, file_id: UUID, *, lock: bool = False
                  ) -> FileRecord | None:
        row = (await db.execute(_GET_FOR_UPDATE if lock else _GET, {"id": file_id})
               ).one_or_none()
        if row is None:
            return None
        return FileRecord(id=row.id, tenant_id=row.tenant_id, bucket=row.bucket,
                          storage_key=row.storage_key, content_type=row.content_type,
                          size_bytes=row.size_bytes, sha256=row.sha256, purpose=row.purpose,
                          state=row.state, created_by_user_id=row.created_by_user_id,
                          wrapped_data_key=row.wrapped_data_key)

    @staticmethod
    async def _update_one(db: AsyncSession, statement: TextClause, params: dict[str, object]
                          ) -> None:
        result = await db.execute(statement, params)
        if getattr(result, "rowcount", None) != 1:
            raise RuntimeError("The file changed state under the request's lock")

    async def mark_quarantined(self, db: AsyncSession, file_id: UUID) -> None:
        await self._update_one(db, _QUARANTINED, {"id": file_id})

    async def mark_clean(self, db: AsyncSession, file_id: UUID, *, bucket: str,
                         wrapped_data_key: str) -> None:
        await self._update_one(db, _CLEAN, {"id": file_id, "bucket": bucket,
                                            "wrapped_data_key": wrapped_data_key})

    async def mark_rejected(self, db: AsyncSession, file_id: UUID, *, scan_status: str
                            ) -> None:
        await self._update_one(db, _REJECTED, {"id": file_id, "scan_status": scan_status,
                                               "scanned": scan_status != "pending"})

    async def attachment(self, db: AsyncSession, file: FileRecord) -> Attachment:
        query = _ATTACHMENTS.get(file.purpose)
        if query is None:
            return Attachment(attached=False, patient_ids=frozenset())
        rows = (await db.execute(query, {"id": file.id})).all()
        return Attachment(attached=bool(rows),
                          patient_ids=frozenset(r.patient_id for r in rows
                                                if r.patient_id is not None))

    async def ensure_chart_access(self, db: AsyncSession, user: CurrentUser,
                                  patient_id: UUID) -> None:
        await ensure_chart_access(db, user, patient_id)
