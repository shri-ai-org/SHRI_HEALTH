"""Where file bytes live, and storing the files the server makes itself.

- ``FileStore``, where the bytes live, by bucket and key, and the links a browser uses to
  ``PUT`` an upload or ``GET`` a download without the bytes passing through the API
  (API_STANDARDS §15). ``LocalFileStore`` is a folder on disk, for tests and local development;
  ``s3.S3FileStore`` is the object store (SeaweedFS), with SigV4 pre-signed links.
- ``store_generated()``, which writes a file the server made (a receipt, later the after-visit
  summary) and records its ``admin.binary_object`` row in the request's own transaction.
- ``file_store()``, the FastAPI dependency that gives an endpoint its store.

Two buckets (``admin.binary_object.bucket``): an upload's bytes land in ``quarantine`` and move
to ``clean`` once the scan passes (service.py); a generated file is written to ``clean`` at once.

**Encryption.** An upload is sealed with its own data key before it reaches the clean bucket
(``crypto.FileCrypto``, a seam until core's ``new_data_key()``). Generated files are not yet:
``store_generated()`` writes the bytes as they are and ``wrapped_data_key`` stays NULL. When core
provides ``new_data_key()``, ``store_generated()`` seals the bytes the same way and records the
wrapped key; nothing here invents encryption meanwhile (D3: encryption is core's).

**Orphans.** ``store_generated()`` writes the bytes before the row, and the row commits with the
caller's transaction. If that transaction then rolls back, the object stays in the store with no
row pointing at it. Nothing reads such an object: a file is reached only through its row. The
purge (purge.py) works from rows, so it does not find these; sweeping the store for objects
without a row is a later job (see purge.py).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.core.db import TENANT_ID_INFO_KEY
from app.core.errors import ServiceUnavailable

#: The bucket of a clean file: a scanned upload, or a generated file from the start (0012).
CLEAN_BUCKET = "clean"
#: The bucket an upload lands in, until its scan passes (API_STANDARDS §15 step 2).
QUARANTINE_BUCKET = "quarantine"
BUCKETS = frozenset({CLEAN_BUCKET, QUARANTINE_BUCKET})
#: Purposes the server makes itself, clean from the start (``ck_binary_object_generated_clean``).
GENERATED_PURPOSES = frozenset({"receipt", "after-visit-summary"})
#: The environment variable that names the store's folder, until core has a setting for it.
FILE_STORE_DIR_ENV = "SHRI_FILE_STORE_DIR"

# A storage key is two generated UUIDs, the clinic and the file: never client input, no PHI.
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_KEY = re.compile(rf"^{_UUID}/{_UUID}$")


def check_key(key: str, bucket: str) -> None:
    """Refuse anything but a generated key in a known bucket (``ValueError``)."""
    if bucket not in BUCKETS:
        raise ValueError("Not a file-service bucket")
    if not _KEY.fullmatch(key):
        raise ValueError("Not a generated storage key")


def storage_key(tenant_id: UUID, file_id: UUID) -> str:
    return f"{tenant_id}/{file_id}"


@dataclass(frozen=True)
class SignedLink:
    """A pre-signed link: a bearer secret until ``expires_at``. Never log it or store it."""

    url: str = field(repr=False)
    expires_at: datetime
    headers: dict[str, str] = field(default_factory=dict)  # to send with the request


class FileStore(Protocol):
    """Where file bytes live. Keys are server-generated (``<tenant>/<file-uuid>``), and every
    method takes the bucket (``clean`` unless given), so a key never names its own bucket."""

    async def put(self, key: str, data: bytes, content_type: str, *,
                  bucket: str = CLEAN_BUCKET) -> None:
        """Store ``data`` under a new ``key``; refuses a key that already exists."""
        ...

    async def get(self, key: str, *, bucket: str = CLEAN_BUCKET) -> bytes:
        """The bytes under ``key``; ``FileNotFoundError`` if there are none."""
        ...

    async def delete(self, key: str, *, bucket: str = CLEAN_BUCKET) -> None:
        """Remove ``key``; nothing happens if it is not there."""
        ...

    def presign_put(self, key: str, *, bucket: str, content_type: str, size_bytes: int,
                    expires: timedelta) -> SignedLink:
        """A link the browser ``PUT``s the bytes to, with ``Content-Type: content_type``; the
        store refuses a body of any other length than ``size_bytes`` where it can."""
        ...

    def presign_get(self, key: str, *, bucket: str, content_type: str,
                    expires: timedelta) -> SignedLink:
        """A link the browser ``GET``s the bytes from."""
        ...


def expiry(expires: timedelta, now: datetime | None = None) -> datetime:
    """When a link made now stops working, in whole seconds (Timestamp.yaml)."""
    return (now or datetime.now(UTC)).replace(microsecond=0) + expires


class LocalFileStore:
    """A ``FileStore`` in a folder: each key is a file. For tests and local development only.

    The clean bucket is ``root`` itself (where generated receipts have always been written);
    any other bucket is the folder of its name under ``root`` (``root/quarantine``), which no
    key can collide with, since keys start with a UUID. Keys must be ``<uuid>/<uuid>``, the only
    form the server generates, and the resolved path must stay under ``root``, so no key can
    reach outside it. Files are written to a temporary name and moved into place, so a reader
    never sees half a file, and are readable by the owner only. The content type is not kept:
    the ``binary_object`` row holds it.

    Its "pre-signed" links are plain ``file://`` URLs to that path: nothing signs or expires
    them, and only a process on this machine can follow one. Tests write an upload's bytes with
    ``put(..., bucket=QUARANTINE_BUCKET)`` instead of following the link.
    """

    def __init__(self, root: Path) -> None:
        self.root = root

    def path_for(self, key: str, bucket: str = CLEAN_BUCKET) -> Path:
        check_key(key, bucket)
        root = self.root.resolve()
        base = root if bucket == CLEAN_BUCKET else root / bucket
        path = (base / key).resolve()
        if not path.is_relative_to(base) or path == base:
            raise ValueError("Storage key is outside the store")
        return path

    async def put(self, key: str, data: bytes, content_type: str, *,
                  bucket: str = CLEAN_BUCKET) -> None:
        await asyncio.to_thread(self._put, self.path_for(key, bucket), data)

    async def get(self, key: str, *, bucket: str = CLEAN_BUCKET) -> bytes:
        return await asyncio.to_thread(self.path_for(key, bucket).read_bytes)

    async def delete(self, key: str, *, bucket: str = CLEAN_BUCKET) -> None:
        await asyncio.to_thread(self.path_for(key, bucket).unlink, missing_ok=True)

    def presign_put(self, key: str, *, bucket: str, content_type: str, size_bytes: int,
                    expires: timedelta) -> SignedLink:
        return SignedLink(url=self.path_for(key, bucket).as_uri(), expires_at=expiry(expires),
                          headers={"Content-Type": content_type})

    def presign_get(self, key: str, *, bucket: str, content_type: str,
                    expires: timedelta) -> SignedLink:
        return SignedLink(url=self.path_for(key, bucket).as_uri(), expires_at=expiry(expires))

    @staticmethod
    def _put(path: Path, data: bytes) -> None:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.exists():
            raise FileExistsError("Storage key already used")
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".part-")
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            os.link(temporary, path)  # fails if the key appeared meanwhile: never overwrites
        finally:
            os.unlink(temporary)


_INSERT = text("""
    INSERT INTO admin.binary_object
        (id, tenant_id, bucket, storage_key, content_type, size_bytes, sha256, purpose, state,
         created_by_user_id, updated_by_user_id)
    VALUES (:id, :tenant_id, :bucket, :storage_key, :content_type, :size_bytes, :sha256,
            :purpose, 'clean', NULLIF(current_setting('app.current_user_id', true), '')::uuid,
            NULLIF(current_setting('app.current_user_id', true), '')::uuid)
""")


async def store_generated(db: AsyncSession, store: FileStore, *, purpose: str,
                          content_type: str, data: bytes) -> UUID:
    """Store a file the server made and return its file ID.

    Writes the bytes under ``<tenant>/<file-uuid>``, then inserts its ``admin.binary_object``
    row (bucket ``clean``, state ``clean``, with its size and SHA-256) through the request's
    session, so the row commits or rolls back with the caller's other writes. It does not
    commit. If the insert fails, the bytes are removed again; if the caller's transaction rolls
    back later, they stay as an orphan (module docstring).
    """
    if purpose not in GENERATED_PURPOSES:
        raise ValueError(f"{purpose!r} is not a purpose the server generates")
    tenant_id = db.info.get(TENANT_ID_INFO_KEY)
    if not isinstance(tenant_id, UUID):
        raise RuntimeError("store_generated needs a clinic session (tenant_db)")
    file_id = uuid4()
    key = storage_key(tenant_id, file_id)
    await store.put(key, data, content_type)
    try:
        await db.execute(_INSERT, {
            "id": file_id, "tenant_id": tenant_id, "bucket": CLEAN_BUCKET, "storage_key": key,
            "content_type": content_type, "size_bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "purpose": purpose})
    except Exception:
        await store.delete(key)
        raise
    return file_id


def configured_store() -> FileStore | None:
    """The store the environment configures, or None.

    TEMPORARY SEAM. Core has no file-store setting yet (asked of Thulasi on #13), so it comes
    from environment variables: the object store when ``SHRI_S3_ENDPOINT`` and the rest of
    ``s3.S3Config``'s variables are set, else a folder (``SHRI_FILE_STORE_DIR``). When core's
    setting lands, only this function changes; endpoints and tests that override
    ``file_store`` do not.
    """
    from .s3 import S3Config, S3FileStore  # s3 builds on this module

    config = S3Config.from_env()
    if config is not None:
        return S3FileStore(config)
    folder = os.environ.get(FILE_STORE_DIR_ENV)
    return LocalFileStore(Path(folder)) if folder else None


#: Until core's data-key encryption is wired in, files are stored unencrypted, so a store is
#: given out only where the data is synthetic (Thulasi's review of #118).
UNENCRYPTED_ENVIRONMENTS = frozenset({"development", "test"})


def file_store(request: Request) -> FileStore:
    """FastAPI dependency: the file store (``configured_store()``); without one, endpoints that
    store or link to a file answer ``503 service-unavailable``. Files aren't encrypted yet
    (core's ``new_data_key()`` is pending), so outside development and test this always answers
    503: patient data is never stored in the clear."""
    if request.app.state.settings.environment not in UNENCRYPTED_ENVIRONMENTS:
        raise ServiceUnavailable("File storage is not available until files are encrypted")
    store = configured_store()
    if store is None:
        raise ServiceUnavailable("File storage is not configured")
    return store
