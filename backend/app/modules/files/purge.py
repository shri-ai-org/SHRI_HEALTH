"""The purge of unusable files, ``python -m app.modules.files.purge`` (migration 0014).

A file that is not clean ``PURGE_AFTER`` (24 hours) after its last change can never be attached
or downloaded: an upload never completed, a scan that never finished, a rejected file. This job
removes both its row and its stored object, for every clinic, as ``shri_maintenance``, which may
only run the two purge functions (D23) and sees no table.

Each batch:

1. ``admin.list_unusable_files(batch)`` gives the files past the window
   (``id, tenant_id, bucket, storage_key``);
2. in one transaction, ``admin.delete_unusable_files(ids)`` deletes the rows that are still
   unusable and old, skipping (keeping) any row another table still references, and returns
   the IDs it deleted; the job deletes each of those rows' stored objects; then it commits.

So the rows are committed gone only after their objects are, and a failure (the store or the
database, at any point) leaves at most a row whose object is already gone, which the next run
removes (deleting a missing object is not an error). A skipped row keeps its object. Batches
repeat while a full batch deleted something.

Not covered: stored objects without any row (the bytes of a generated file whose transaction
rolled back; storage.py). Finding those means listing the store and asking the database which
keys have rows, which needs its own function; a later job.

TEMPORARY SEAM: the database URL comes from ``MAINTENANCE_DATABASE_URL`` (an async SQLAlchemy
URL, ``postgresql+asyncpg://shri_maintenance:…``), because core has no setting for the
maintenance role yet; the store is ``storage.configured_store()``. When core adds the setting
(and the scheduler that runs 0005's purge), only ``main()`` changes. Nothing is logged but
counts and file IDs: no keys, no patient data.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from .storage import FileStore, check_key, configured_store

log = logging.getLogger(__name__)

#: How long an unusable file is kept after its last change. The functions in migration 0014
#: fix the same interval (so the caller can't shorten it); a test checks they agree.
PURGE_AFTER = timedelta(hours=24)
MAINTENANCE_DATABASE_URL_ENV = "MAINTENANCE_DATABASE_URL"
BATCH = 500

_LIST = text("SELECT id, tenant_id, bucket, storage_key FROM admin.list_unusable_files(:limit)")
_DELETE = text("SELECT id FROM admin.delete_unusable_files(:ids)").bindparams(
    bindparam("ids", type_=ARRAY(PgUUID(as_uuid=True))))


@dataclass
class PurgeReport:
    listed: int = 0
    deleted: int = 0

    @property
    def skipped(self) -> int:
        """Listed but kept: still referenced, or changed since it was listed."""
        return self.listed - self.deleted


async def purge_once(engine: AsyncEngine, store: FileStore, *, batch: int = BATCH
                     ) -> PurgeReport:
    """One batch (module docstring)."""
    report = PurgeReport()
    async with engine.connect() as conn:
        files = (await conn.execute(_LIST, {"limit": batch})).all()
        await conn.rollback()
        report.listed = len(files)
        purgeable = [file for file in files if _ours(file)]
        if not purgeable:
            return report
        async with conn.begin():
            deleted: set[UUID] = set((await conn.execute(
                _DELETE, {"ids": [file.id for file in purgeable]})).scalars())
            for file in purgeable:
                if file.id in deleted:
                    await store.delete(file.storage_key, bucket=file.bucket)
        report.deleted = len(deleted)
    return report


def _ours(file: Any) -> bool:
    """Only a file-service key (``<clinic>/<file>``, in a file-service bucket, in the file's own
    clinic) is deleted from the store. Any other row (one stored before 0012, say) is left, row
    and object, for a person to look at: the job never deletes a row whose object it can't."""
    try:
        check_key(file.storage_key, file.bucket)
    except ValueError:
        log.warning("File %s has no file-service key; left in place", file.id)
        return False
    if not file.storage_key.startswith(f"{file.tenant_id}/"):
        log.warning("File %s has a key outside its clinic; left in place", file.id)
        return False
    return True


async def purge(engine: AsyncEngine, store: FileStore, *, batch: int = BATCH) -> PurgeReport:
    """Every batch, while a full batch deleted something."""
    total = PurgeReport()
    while True:
        report = await purge_once(engine, store, batch=batch)
        total.listed += report.listed
        total.deleted += report.deleted
        if report.listed < batch or report.deleted == 0:
            return total


async def _run(url: str, store: FileStore) -> PurgeReport:
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        return await purge(engine, store)
    finally:
        await engine.dispose()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    url = os.environ.get(MAINTENANCE_DATABASE_URL_ENV)
    store = configured_store()
    if not url or store is None:
        log.error("Set %s and the file store's variables (storage.configured_store)",
                  MAINTENANCE_DATABASE_URL_ENV)
        return 2
    report = asyncio.run(_run(url, store))
    log.info("File purge: %d deleted, %d kept (still referenced or changed)",
             report.deleted, report.skipped)
    return 0


if __name__ == "__main__":
    sys.exit(main())
