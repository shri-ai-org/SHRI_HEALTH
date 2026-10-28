"""Storing files the server makes itself (a payment receipt, later the after-visit summary).

Only what server-generated files need; the file service proper (uploads, the malware scan,
download URLs, purge) is a later PR. Three pieces:

- ``FileStore``, where the bytes live, and ``LocalFileStore``, a folder on disk;
- ``store_generated()``, which writes the bytes and records the ``admin.binary_object`` row in
  the request's own transaction;
- ``file_store()``, the FastAPI dependency that gives an endpoint its store.

**Encryption is not wired in yet.** Core's data-key calls don't exist, so the bytes are written
as they are and ``wrapped_data_key`` stays NULL. When core provides ``new_data_key()``,
``store_generated()`` encrypts the bytes with a fresh data key and records the wrapped key
(``admin.binary_object.wrapped_data_key``, kept only for a clean file); nothing here invents
encryption meanwhile (D3: encryption is core's).

**Orphans.** The bytes are written before the row, and the row commits with the caller's
transaction. If that transaction then rolls back (a later step fails, or the commit itself), the
object stays in the store with no row pointing at it. Nothing reads such an object: a file is
reached only through its row. The file service's purge removes these orphans.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
from pathlib import Path
from typing import Protocol
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.core.db import TENANT_ID_INFO_KEY
from app.core.errors import ServiceUnavailable

#: The bucket of a file that is clean: a generated file is clean from the start (0012).
CLEAN_BUCKET = "clean"
#: Purposes the server makes itself, clean from the start (``ck_binary_object_generated_clean``).
GENERATED_PURPOSES = frozenset({"receipt", "after-visit-summary"})
#: The environment variable that names the store's folder, until core has a setting for it.
FILE_STORE_DIR_ENV = "SHRI_FILE_STORE_DIR"

# A storage key is two generated UUIDs, the clinic and the file: never client input, no PHI.
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_KEY = re.compile(rf"^{_UUID}/{_UUID}$")


class FileStore(Protocol):
    """Where file bytes live. Keys are server-generated (``<tenant>/<file-uuid>``)."""

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        """Store ``data`` under a new ``key``; refuses a key that already exists."""
        ...

    async def get(self, key: str) -> bytes:
        """The bytes under ``key``; ``FileNotFoundError`` if there are none."""
        ...

    async def delete(self, key: str) -> None:
        """Remove ``key``; nothing happens if it is not there."""
        ...


class LocalFileStore:
    """A ``FileStore`` in a folder: each key is a file under ``root``.

    Keys must be ``<uuid>/<uuid>``, the only form the server generates, and the resolved path
    must stay under ``root``, so no key can reach outside it. Files are written to a temporary
    name and moved into place, so a reader never sees half a file, and are readable by the
    owner only. The content type is not kept: the ``binary_object`` row holds it.
    """

    def __init__(self, root: Path) -> None:
        self.root = root

    def path_for(self, key: str) -> Path:
        if not _KEY.fullmatch(key):
            raise ValueError("Not a generated storage key")
        root = self.root.resolve()
        path = (root / key).resolve()
        if not path.is_relative_to(root) or path == root:
            raise ValueError("Storage key is outside the store")
        return path

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(self._put, self.path_for(key), data)

    async def get(self, key: str) -> bytes:
        return await asyncio.to_thread(self.path_for(key).read_bytes)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self.path_for(key).unlink, missing_ok=True)

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
    back later, they stay as an orphan for the purge (module docstring).
    """
    if purpose not in GENERATED_PURPOSES:
        raise ValueError(f"{purpose!r} is not a purpose the server generates")
    tenant_id = db.info.get(TENANT_ID_INFO_KEY)
    if not isinstance(tenant_id, UUID):
        raise RuntimeError("store_generated needs a clinic session (tenant_db)")
    file_id = uuid4()
    key = f"{tenant_id}/{file_id}"
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


#: Until core's data-key encryption is wired in, files are stored unencrypted, so a store is
#: given out only where the data is synthetic (Thulasi's review of #118).
UNENCRYPTED_ENVIRONMENTS = frozenset({"development", "test"})


def file_store(request: Request) -> FileStore:
    """FastAPI dependency: the store for generated files.

    TEMPORARY SEAM. Core has no file-store setting yet (asked of Thulasi on #13), so the folder
    comes from the ``SHRI_FILE_STORE_DIR`` environment variable; without it, endpoints that
    store a file answer ``503 service-unavailable``. Files aren't encrypted yet (core's
    ``new_data_key()`` is pending), so outside development and test this always answers 503:
    patient data is never stored in the clear. When core's setting, its encryption and the real
    object store land, only this function changes; endpoints and tests that override it do not.
    """
    if request.app.state.settings.environment not in UNENCRYPTED_ENVIRONMENTS:
        raise ServiceUnavailable("File storage is not available until files are encrypted")
    folder = os.environ.get(FILE_STORE_DIR_ENV)
    if not folder:
        raise ServiceUnavailable("File storage is not configured")
    return LocalFileStore(Path(folder))
