"""Working stand-ins for the file service's seams and its database, for tests only.

- ``FakeSession``, ``FakeRepository``: what tenant_db and the repository do, in memory; each
  clinic sees only its own files, as forced row-level security does.
- ``MemoryFileStore``: a ``FileStore`` keeping bytes by bucket and key, with ``memory://`` links.
- ``FakeScanner``: a ``Scanner`` (replaces clamd until ClamAV is in compose): infected when the
  bytes contain ``EICAR``, the test marker below, or unavailable when told to be.
- ``FakeFileCrypto``: the module's real AES-256-GCM (``AesGcmFileCrypto``) over
  ``FakeDataKeys``, core's data keys in memory: a random 32-byte key per file, "wrapped" as an
  opaque name it remembers, or unavailable (503) when told to be.
- ``FakeOperations``: core's operations and ``file.scanned``, in memory (the live tests use
  core's own).
- ``download_tokens()``: core's own ``DownloadTokens`` with a synthetic secret and, if given,
  a clock.

Synthetic data only.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from app.core.crypto import DataKey
from app.core.db import TENANT_ID_INFO_KEY
from app.core.deps import CurrentUser
from app.core.download_tokens import DownloadTokens
from app.core.errors import Forbidden, ServiceUnavailable
from app.core.long_running import FINAL, Operation

from ..crypto import AesGcmFileCrypto
from ..repository import Attachment, FileRecord, NewUpload
from ..scanner import ScanResult
from ..storage import CLEAN_BUCKET, SignedLink, check_key, expiry

# The marker the fake scanner treats as malware (synthetic; not the real EICAR test string).
EICAR = b"EICAR-SYNTHETIC-TEST-MARKER"
JPEG = b"\xff\xd8\xff\xe0" + b"synthetic jpeg body " * 8
PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic png body " * 8


class FakeSession:
    def __init__(self, tenant_id: UUID) -> None:
        self.tenant_id = tenant_id
        self.info: dict[str, Any] = {TENANT_ID_INFO_KEY: tenant_id}
        self.commits = 0

    async def commit(self) -> None:
        self.commits += 1


@dataclass
class World:
    files: dict[UUID, dict[UUID, FileRecord]] = field(default_factory=dict)  # clinic -> files
    attachments: dict[UUID, set[UUID | None]] = field(default_factory=dict)  # file -> patients
    restricted: set[UUID] = field(default_factory=set)  # patients needing break-glass
    granted: set[tuple[UUID, UUID]] = field(default_factory=set)  # (user, patient)
    scan_status: dict[UUID, str] = field(default_factory=dict)
    wrapped_keys: dict[UUID, str] = field(default_factory=dict)
    audited: list[list[UUID]] = field(default_factory=list)  # each download's audit patients
    sessions: list[FakeSession] = field(default_factory=list)

    def add(self, record: FileRecord) -> FileRecord:
        self.files.setdefault(record.tenant_id, {})[record.id] = record
        return record

    def file(self, clinic: UUID, file_id: UUID) -> FileRecord:
        return self.files[clinic][file_id]


class FakeRepository:
    def __init__(self, world: World) -> None:
        self.world = world

    def _mine(self, db: Any) -> dict[UUID, FileRecord]:
        return self.world.files.setdefault(db.tenant_id, {})

    def _set(self, db: Any, file_id: UUID, wanted: str, **changes: Any) -> None:
        record = self._mine(db)[file_id]
        assert record.state == wanted, (record.state, wanted)
        self._mine(db)[file_id] = replace(record, **changes)

    async def insert_upload(self, db: Any, upload: NewUpload) -> None:
        self._mine(db)[upload.id] = FileRecord(
            id=upload.id, tenant_id=db.tenant_id, bucket=upload.bucket,
            storage_key=upload.storage_key, content_type=upload.content_type,
            size_bytes=upload.size_bytes, sha256=upload.sha256, purpose=upload.purpose,
            state="pending-upload", created_by_user_id=upload.user_id)

    async def get(self, db: Any, file_id: UUID, *, lock: bool = False) -> FileRecord | None:
        return self._mine(db).get(file_id)

    async def mark_quarantined(self, db: Any, file_id: UUID) -> None:
        self._set(db, file_id, "pending-upload", state="quarantined")

    async def mark_clean(self, db: Any, file_id: UUID, *, bucket: str,
                         wrapped_data_key: str) -> None:
        self._set(db, file_id, "quarantined", state="clean", bucket=bucket,
                  wrapped_data_key=wrapped_data_key)
        self.world.wrapped_keys[file_id] = wrapped_data_key
        self.world.scan_status[file_id] = "clean"

    async def mark_rejected(self, db: Any, file_id: UUID, *, scan_status: str) -> None:
        self._set(db, file_id, "quarantined", state="rejected")
        self.world.scan_status[file_id] = scan_status

    async def attachment(self, db: Any, file: FileRecord) -> Attachment:
        patients = self.world.attachments.get(file.id)
        if patients is None:
            return Attachment(attached=False, patient_ids=frozenset())
        return Attachment(attached=True,
                          patient_ids=frozenset(p for p in patients if p is not None))

    async def ensure_chart_access(self, db: Any, user: CurrentUser, patient_id: UUID) -> None:
        if patient_id in self.world.restricted and (user.id, patient_id) not in self.world.granted:
            raise Forbidden("This chart is restricted", code="break-glass-required")


class MemoryFileStore:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.deleted: list[tuple[str, str]] = []

    async def put(self, key: str, data: bytes, content_type: str, *,
                  bucket: str = CLEAN_BUCKET) -> None:
        check_key(key, bucket)
        if (bucket, key) in self.objects:
            raise FileExistsError(key)
        self.objects[(bucket, key)] = (data, content_type)

    async def get(self, key: str, *, bucket: str = CLEAN_BUCKET) -> bytes:
        check_key(key, bucket)
        if (bucket, key) not in self.objects:
            raise FileNotFoundError(key)
        return self.objects[(bucket, key)][0]

    async def delete(self, key: str, *, bucket: str = CLEAN_BUCKET) -> None:
        check_key(key, bucket)
        self.objects.pop((bucket, key), None)
        self.deleted.append((bucket, key))

    def presign_put(self, key: str, *, bucket: str, content_type: str, size_bytes: int,
                    expires: timedelta) -> SignedLink:
        check_key(key, bucket)
        return SignedLink(url=f"memory://{bucket}/{key}?put", expires_at=expiry(expires),
                          headers={"Content-Type": content_type})


class FakeScanner:
    def __init__(self) -> None:
        self.scanned: list[bytes] = []
        self.unavailable = False

    async def scan(self, data: bytes) -> ScanResult:
        if self.unavailable:
            raise ServiceUnavailable("The malware scanner is unavailable")
        self.scanned.append(data)
        if EICAR in data:
            return ScanResult(infected=True, signature="Synthetic-Test-Signature")
        return ScanResult(infected=False)


class FakeDataKeys:
    """Core's data keys in memory (module docstring). Never real key material."""

    def __init__(self) -> None:
        self.keys: dict[str, bytes] = {}
        self.unavailable = False

    async def new_data_key(self) -> DataKey:
        if self.unavailable:
            raise ServiceUnavailable("File encryption is not available")
        wrapped = f"vault:v1:test-wrapped-{len(self.keys) + 1}"
        self.keys[wrapped] = secrets.token_bytes(32)
        return DataKey(self.keys[wrapped], wrapped)

    async def unwrap_data_key(self, wrapped: str) -> bytes:
        if self.unavailable or wrapped not in self.keys:
            raise ServiceUnavailable("File encryption is not available")
        return self.keys[wrapped]


class FakeFileCrypto(AesGcmFileCrypto):
    """Real AES-256-GCM over ``FakeDataKeys``."""

    def __init__(self) -> None:
        self.data_keys = FakeDataKeys()
        super().__init__(self.data_keys)

    @property
    def wrapped(self) -> list[str]:
        """Every wrapped key handed out, in order."""
        return list(self.data_keys.keys)


class FakeOperations:
    def __init__(self) -> None:
        self.operations: dict[UUID, Operation] = {}
        self.events: list[tuple[UUID, str]] = []  # file.scanned: (file, status)

    async def start(self, db: Any, kind: str) -> Operation:
        now = datetime.now(UTC)
        operation = Operation(id=uuid4(), kind=kind, status="queued",
                              created_by_user_id=uuid4(), created_at=now, updated_at=now)
        self.operations[operation.id] = operation
        return operation

    async def finish(self, db: Any, operation: Operation, status: Any, *,
                     result: tuple[str, UUID] | None = None,
                     error: dict[str, Any] | None = None) -> Operation:
        assert operation.status not in FINAL and status in FINAL
        now = datetime.now(UTC)
        done = replace(operation, status=status, updated_at=now, completed_at=now,
                       result_type=result[0] if result else None,
                       result_id=result[1] if result else None, error=error)
        self.operations[done.id] = done
        return done

    async def file_scanned(self, db: Any, file_id: UUID, status: str) -> None:
        self.events.append((file_id, status))


#: Synthetic, for tests only.
TOKEN_SECRET = "synthetic-download-token-key-for-tests-only"


def download_tokens(clock: Callable[[], float] = time.time) -> DownloadTokens:
    """Core's own download tokens (module docstring)."""
    return DownloadTokens(TOKEN_SECRET, clock)
