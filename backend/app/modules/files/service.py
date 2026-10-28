"""The file service's rules (API_STANDARDS §15; files.yaml; Anand's guide Step 6).

**Request an upload** (``createUploadUrl``): the purpose decides what may be uploaded. The demo's
two uploaded purposes, ``insurance-card`` and ``identity``, take JPEG or PNG up to 10 MB
(``MAX_IMAGE_BYTES``, 10 MiB; M13). ``receipt`` and ``after-visit-summary`` are made by the
server, never uploaded. Every other purpose has no upload rule yet and is refused the same way,
``422 business-rule-violation`` naming the field. The file's row is written ``pending-upload``
in the quarantine bucket, with the declared size and SHA-256, and the answer is a link to
``PUT`` the bytes there, valid for ``UPLOAD_LINK_LIFETIME``. Client file names are never stored.

**Finish an upload** (``completeUpload``), in this order:

1. ``404 not-found``: the clinic has no such file, or it is someone else's upload (only the
   uploader finishes their own upload; nobody else learns it exists);
2. ``409 invalid-state-transition`` (with ``currentState``): the file is not ``pending-upload``
   (completed already, or a generated file), or no bytes were uploaded;
3. the file becomes ``quarantined`` and its ``file.scan`` operation starts; then the scan
   (``scan_upload``) checks the bytes against the declared size and SHA-256 and the declared
   media type against the content, runs the malware scan, and either seals the bytes with a
   fresh data key into the clean bucket (``clean``, with ``wrapped_data_key``) or marks the file
   ``rejected``. The operation ends ``succeeded`` (result: the file) or ``failed`` (``422
   file-not-ready``). Until core's operations exist this runs inside the request (operations.py
   says what changes); the scanner or the encryption being unavailable is ``503`` and leaves the
   file ``pending-upload`` (the transaction rolls back), so the upload can be finished later.

**Get a download link** (``createDownloadUrl``), in this order:

1. ``404 not-found``: the clinic has no such file;
2. ``403 permission-denied`` (audited like require()'s): the user lacks the purpose's read
   permission (``READ_PERMISSIONS``, files.yaml ``FilePurpose``). A purpose not mapped here is
   denied: ``encounter-audio``, ``document``, ``fax``, ``ccda``, ``export``, ``onboarding-import``
   wait for their modules;
3. **an unattached file is its uploader's only**: anyone else gets ``404 not-found``, as for a
   file that doesn't exist (API_STANDARDS §12). An attached file is read through its record's
   patient: a restricted chart needs a break-glass grant or care-team membership (core's
   ``ensure_chart_access``: ``403 break-glass-required``, audited);
4. **only a clean file is downloaded** (Anand's rule): any other state is ``409
   invalid-state-transition`` with ``currentState``, the contract's code for "not clean yet, or
   rejected". Checked last, so the state is told only to someone who may read the file.

The link is valid for ``DOWNLOAD_LINK_LIFETIME`` (the contract's "at most 5 minutes").
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.core import audit
from app.core.deps import CurrentUser
from app.core.errors import CATALOGUE, Conflict, Forbidden, NotFound, ValidationFailed, field_error
from app.core.request_id import current_request_id
from app.core.routing import API_PREFIX

from . import schemas
from .crypto import FileCrypto
from .operations import FILE_SCAN, OperationRecord, Operations
from .repository import FileRecord, FileRepository, NewUpload
from .scanner import Scanner
from .storage import (
    CLEAN_BUCKET,
    GENERATED_PURPOSES,
    QUARANTINE_BUCKET,
    FileStore,
    storage_key,
)

log = logging.getLogger(__name__)

UPLOAD_LINK_LIFETIME = timedelta(minutes=15)
DOWNLOAD_LINK_LIFETIME = timedelta(minutes=5)
MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_TYPES = frozenset({"image/jpeg", "image/png"})


@dataclass(frozen=True)
class UploadRule:
    content_types: frozenset[str]
    max_bytes: int


#: What each uploaded purpose accepts. A purpose not listed can't be uploaded yet.
UPLOAD_RULES: dict[str, UploadRule] = {
    "insurance-card": UploadRule(IMAGE_TYPES, MAX_IMAGE_BYTES),
    "identity": UploadRule(IMAGE_TYPES, MAX_IMAGE_BYTES),
}
#: The read permission each purpose needs for a download link, any one of them (files.yaml).
READ_PERMISSIONS: dict[str, tuple[str, ...]] = {
    "insurance-card": ("coverages:read",),
    "identity": ("patients:read",),
    "receipt": ("payments:create", "superbills:read"),
    "after-visit-summary": ("encounters:read",),
}
#: How each accepted media type starts, so a file can't claim to be what it isn't.
SIGNATURES: dict[str, bytes] = {
    "image/jpeg": b"\xff\xd8\xff",
    "image/png": b"\x89PNG\r\n\x1a\n",
}


def _rule(errors: list[dict[str, str]]) -> ValidationFailed:
    detail = "1 rule is not met." if len(errors) == 1 else f"{len(errors)} rules are not met."
    return ValidationFailed(detail, code="business-rule-violation", errors=errors)


def upload_rule_errors(body: schemas.UploadUrlRequest) -> list[dict[str, str]]:
    if body.purpose in GENERATED_PURPOSES:
        return [field_error("body", "/purpose", "not-allowed-value")]
    rule = UPLOAD_RULES.get(body.purpose)
    if rule is None:
        return [field_error("body", "/purpose", "not-allowed-value")]
    errors = []
    if body.content_type not in rule.content_types:
        errors.append(field_error("body", "/contentType", "not-allowed-value"))
    if body.size_bytes > rule.max_bytes:
        errors.append(field_error("body", "/sizeBytes", "out-of-range"))
    return errors


# ================================================================================ upload link
async def create_upload_url(db: AsyncSession, repo: FileRepository, store: FileStore,
                            user: CurrentUser, body: schemas.UploadUrlRequest
                            ) -> schemas.UploadTicket:
    errors = upload_rule_errors(body)
    if errors:
        raise _rule(errors)
    file_id = uuid4()
    key = storage_key(user.organization_id, file_id)
    await repo.insert_upload(db, NewUpload(
        id=file_id, bucket=QUARANTINE_BUCKET, storage_key=key, content_type=body.content_type,
        size_bytes=body.size_bytes, sha256=body.sha256, purpose=body.purpose, user_id=user.id))
    link = store.presign_put(key, bucket=QUARANTINE_BUCKET, content_type=body.content_type,
                             size_bytes=body.size_bytes, expires=UPLOAD_LINK_LIFETIME)
    await db.commit()
    return schemas.UploadTicket(file_id=file_id, upload_url=link.url,
                                upload_headers=link.headers or None, expires_at=link.expires_at)


# ================================================================================ the scan
@dataclass(frozen=True)
class Rejection:
    detail: str  # for the operation's Problem: no patient data, no submitted values
    scan_status: str  # binary_object.scan_status: "infected", or "pending" when never scanned


def check_bytes(file: FileRecord, data: bytes) -> Rejection | None:
    """The checks before the malware scan: what was uploaded is what was declared."""
    if len(data) != file.size_bytes or hashlib.sha256(data).hexdigest() != file.sha256:
        return Rejection("The uploaded bytes do not match the declared size and SHA-256",
                         "pending")
    signature = SIGNATURES.get(file.content_type)
    if signature is None or not data.startswith(signature):
        return Rejection("The file's content is not the declared media type", "pending")
    return None


async def scan_upload(db: AsyncSession, repo: FileRepository, store: FileStore,
                      scanner: Scanner, crypto: FileCrypto, file: FileRecord, data: bytes
                      ) -> Rejection | None:
    """Scan a quarantined upload and record the outcome on its row (no commit). Clean: the
    bytes, sealed, go to the clean bucket under the same key, and the row records the bucket and
    the wrapped data key. Rejected: the row says so, and its quarantined bytes stay for the
    purge. ``ServiceUnavailable`` from the scanner, the encryption or the store propagates."""
    rejection = check_bytes(file, data)
    if rejection is None:
        verdict = await scanner.scan(data)
        if verdict.infected:
            # The signature name is not patient data; it says what was found, for the logs.
            log.warning("Upload %s rejected by the malware scan (%s)", file.id, verdict.signature)
            rejection = Rejection("The file failed the malware scan", "infected")
    if rejection is not None:
        await repo.mark_rejected(db, file.id, scan_status=rejection.scan_status)
        return rejection
    sealed = await crypto.seal(data)
    try:
        await store.put(file.storage_key, sealed.data, file.content_type, bucket=CLEAN_BUCKET)
    except FileExistsError:
        # Only this file's scan writes this key, and the row (locked, not yet clean) says no
        # finished scan did: it is left from an attempt whose transaction rolled back.
        await store.delete(file.storage_key, bucket=CLEAN_BUCKET)
        await store.put(file.storage_key, sealed.data, file.content_type, bucket=CLEAN_BUCKET)
    await repo.mark_clean(db, file.id, bucket=CLEAN_BUCKET,
                          wrapped_data_key=sealed.wrapped_data_key)
    return None


def operation_problem(type_base: str, instance: str, file_id: UUID, detail: str
                      ) -> dict[str, Any]:
    """The ``failed`` operation's Problem for a rejected file: ``422 file-not-ready``."""
    code = "file-not-ready"
    problem: dict[str, Any] = {"type": f"{type_base}{code}", "title": CATALOGUE[code].title,
                               "status": CATALOGUE[code].status, "detail": detail,
                               "instance": instance, "code": code}
    request_id = current_request_id()
    if request_id:
        problem["requestId"] = request_id
    problem["fileId"] = str(file_id)
    return problem


async def complete_upload(db: AsyncSession, repo: FileRepository, store: FileStore,
                          scanner: Scanner, crypto: FileCrypto, ops: Operations,
                          user: CurrentUser, file_id: UUID, *, type_base: str
                          ) -> OperationRecord:
    file = await repo.get(db, file_id, lock=True)
    if file is None or file.created_by_user_id != user.id:
        raise NotFound("File not found")
    if file.state != "pending-upload":
        raise Conflict("The file is not waiting for its upload", currentState=file.state)
    try:
        data = await store.get(file.storage_key, bucket=file.bucket)
    except FileNotFoundError:
        raise Conflict("No bytes were uploaded", currentState=file.state) from None
    await repo.mark_quarantined(db, file.id)
    operation = await ops.create(db, user, FILE_SCAN)
    # The synchronous runner (operations.py): the scan, inside the request.
    rejection = await scan_upload(db, repo, store, scanner, crypto, file, data)
    if rejection is None:
        operation = await ops.succeed(db, operation, result_type="file", result_id=file.id)
    else:
        operation = await ops.fail(db, operation, operation_problem(
            type_base, f"{API_PREFIX}/files/{file.id}/complete", file.id, rejection.detail))
    await db.commit()
    if rejection is None:
        try:
            await store.delete(file.storage_key, bucket=QUARANTINE_BUCKET)
        except Exception:
            # The clean copy and its row are committed; a quarantined copy left behind is
            # never read, and isn't worth failing the request for.
            log.exception("Could not remove the quarantined copy of file %s", file.id)
    return operation


# ================================================================================ download link
async def create_download_url(request: Request, db: AsyncSession, repo: FileRepository,
                              store: FileStore, user: CurrentUser, file_id: UUID
                              ) -> schemas.DownloadLink:
    file = await repo.get(db, file_id)
    if file is None:
        raise NotFound("File not found")
    allowed = READ_PERMISSIONS.get(file.purpose, ())
    if not any(user.can(permission) for permission in allowed):
        needed = " or ".join(allowed) or f"a mapping for purpose {file.purpose}"
        await audit.record_denial(request, user, needed)
        raise Forbidden(f"Requires {needed}")
    attachment = await repo.attachment(db, file)
    if not attachment.attached:
        if file.created_by_user_id != user.id:
            raise NotFound("File not found")
    else:
        for patient_id in sorted(attachment.patient_ids):
            await repo.ensure_chart_access(db, user, patient_id)
    if file.state != "clean" or file.bucket != CLEAN_BUCKET:
        raise Conflict("Only a clean file can be downloaded", currentState=file.state)
    link = store.presign_get(file.storage_key, bucket=CLEAN_BUCKET,
                             content_type=file.content_type, expires=DOWNLOAD_LINK_LIFETIME)
    return schemas.DownloadLink(url=link.url, expires_at=link.expires_at,
                                content_type=file.content_type, size_bytes=file.size_bytes)


def to_operation(record: OperationRecord) -> schemas.Operation:
    result = (schemas.OperationResult(type=record.result_type, id=record.result_id)
              if record.result_type is not None and record.result_id is not None else None)
    return schemas.Operation(id=record.id, kind=record.kind, status=record.status,
                             created_at=record.created_at, updated_at=record.updated_at,
                             completed_at=record.completed_at, result=result, error=record.error)


def operation_location(operation_id: UUID) -> str:
    return f"{API_PREFIX}/operations/{operation_id}"
