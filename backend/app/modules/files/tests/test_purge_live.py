"""The purge of unusable files (purge.py, migration 0014) against a live database, as
shri_maintenance, with a LocalFileStore in a temporary folder. Runs where ``TEST_DATABASE_URL``
is set. Synthetic data only.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
import pytest_asyncio
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db.models import MAPPERS
from app.db.tests import builders as b
from app.db.tests.conftest import (
    TEST_DATABASE_URL,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)

from .. import purge
from ..storage import CLEAN_BUCKET, QUARANTINE_BUCKET, LocalFileStore

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
M = MAPPERS
DATA = b"\xff\xd8\xff synthetic stored bytes"


@pytest.fixture
def admin() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    yield engine
    engine.dispose()


@pytest_asyncio.fixture
async def maintenance() -> AsyncIterator[AsyncEngine]:
    assert TEST_DATABASE_URL
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    switch_to_role(engine.sync_engine, "shri_maintenance", require_search_path=False)
    yield engine
    await engine.dispose()


@pytest.fixture
def store(tmp_path: Path) -> LocalFileStore:
    return LocalFileStore(tmp_path / "files")


async def _file(admin: Engine, store: LocalFileStore, tenant: UUID, *, state: str,
                age: timedelta, purpose: str = "insurance-card") -> UUID:
    """A file in ``state`` whose last change was ``age`` ago, with its bytes in the store."""
    file_id = uuid.uuid4()
    key = f"{tenant}/{file_id}"
    bucket = CLEAN_BUCKET if state == "clean" else QUARANTINE_BUCKET
    await store.put(key, DATA, "image/jpeg", bucket=bucket)
    scanned = state in ("clean", "rejected")
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, content_type, "
            "size_bytes, sha256, purpose, state, scan_status, scanned_at, created_at, "
            "updated_at) VALUES (:i, :t, :b, :k, 'image/jpeg', :n, :h, :p, :s, :ss, "
            "CASE WHEN :sc THEN now() END, now() - CAST(:age AS interval), "
            "now() - CAST(:age AS interval))"),
            {"i": file_id, "t": tenant, "b": bucket, "k": key, "n": len(DATA),
             "h": hashlib.sha256(DATA).hexdigest(), "p": purpose, "s": state,
             "ss": {"clean": "clean", "rejected": "infected"}.get(state, "pending"),
             "sc": scanned, "age": f"{int(age.total_seconds())} seconds"})
    return file_id


def _exists(admin: Engine, file_id: UUID) -> bool:
    with admin.connect() as c:
        found: int = c.execute(text("SELECT count(*) FROM admin.binary_object WHERE id = :i"),
                               {"i": file_id}).scalar_one()
    return found == 1


async def _stored(store: LocalFileStore, tenant: UUID, file_id: UUID, bucket: str) -> bool:
    try:
        await store.get(f"{tenant}/{file_id}", bucket=bucket)
    except FileNotFoundError:
        return False
    return True


OLD, RECENT = timedelta(hours=25), timedelta(hours=23)


async def test_old_unusable_files_go_row_and_object(admin: Engine, maintenance: AsyncEngine,
                                                    store: LocalFileStore) -> None:
    assert purge.PURGE_AFTER == timedelta(hours=24)  # the window 0014 fixes
    t1, t2 = make_tenant(admin), make_tenant(admin)
    gone = {await _file(admin, store, t1, state="pending-upload", age=OLD): t1,
            await _file(admin, store, t2, state="quarantined", age=OLD): t2,
            await _file(admin, store, t1, state="rejected", age=OLD): t1}
    kept = {await _file(admin, store, t1, state="pending-upload", age=RECENT): (t1, "quarantine"),
            await _file(admin, store, t2, state="rejected", age=RECENT): (t2, "quarantine"),
            await _file(admin, store, t1, state="clean", age=timedelta(days=30)): (t1, "clean")}

    report = await purge.purge(maintenance, store)

    assert report.deleted >= 3  # at least ours (another test's old files may go too)
    for file_id, tenant in gone.items():
        assert not _exists(admin, file_id)
        assert not await _stored(store, tenant, file_id, QUARANTINE_BUCKET)
    for file_id, (tenant, bucket) in kept.items():
        assert _exists(admin, file_id)
        assert await _stored(store, tenant, file_id, bucket)
    assert (await purge.purge(maintenance, store)).deleted == 0  # nothing left of ours


async def test_a_referenced_row_is_skipped_not_fatal(admin: Engine, maintenance: AsyncEngine,
                                                     store: LocalFileStore) -> None:
    tenant = make_tenant(admin)
    referenced = await _file(admin, store, tenant, state="rejected", age=OLD)
    loose = await _file(admin, store, tenant, state="rejected", age=OLD)
    app_engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(app_engine, "shri_app")
    db: Session = open_session(app_engine, tenant)
    try:
        patient = b.patient(db, "Okafor", "Ada")
        cov = M["coverage"](status="active", beneficiary_patient_id=patient.id, order=1,
                            relationship_code="self", subscriber_id="W123456789")
        db.add(cov)
        db.flush()
        cov.card_image = [M["coverage_card_image"](side="front", binary_object_id=referenced)]
        db.commit()
    finally:
        db.close()
        app_engine.dispose()

    report = await purge.purge_once(maintenance, store)

    assert report.skipped >= 1
    assert _exists(admin, referenced)  # kept, with its object
    assert await _stored(store, tenant, referenced, QUARANTINE_BUCKET)
    assert not _exists(admin, loose)  # the run went on
    assert not await _stored(store, tenant, loose, QUARANTINE_BUCKET)


class _FailingStore(LocalFileStore):
    """Deletes the first object, then fails."""

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.calls = 0

    async def delete(self, key: str, *, bucket: str = CLEAN_BUCKET) -> None:
        self.calls += 1
        if self.calls > 1:
            raise OSError("synthetic store failure")
        await super().delete(key, bucket=bucket)


async def test_a_failure_leaves_at_most_rows_without_objects(
        admin: Engine, maintenance: AsyncEngine, tmp_path: Path) -> None:
    tenant = make_tenant(admin)
    store = _FailingStore(tmp_path / "files")
    files = [await _file(admin, store, tenant, state="pending-upload", age=OLD)
             for _ in range(3)]

    with pytest.raises(OSError):
        await purge.purge_once(maintenance, store)

    assert all(_exists(admin, f) for f in files)  # the row deletes rolled back
    objects = [await _stored(store, tenant, f, QUARANTINE_BUCKET) for f in files]
    assert objects.count(False) <= 1  # at most the one deleted before the failure
    # The next run removes them all, the row whose object is already gone included.
    await purge.purge(maintenance, LocalFileStore(tmp_path / "files"))
    assert not any(_exists(admin, f) for f in files)


async def test_rows_outside_the_file_service_are_left(admin: Engine, maintenance: AsyncEngine,
                                                      store: LocalFileStore) -> None:
    tenant, file_id = make_tenant(admin), uuid.uuid4()
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, content_type, "
            "size_bytes, sha256, purpose, state, updated_at) VALUES (:i, :t, 'docs', :k, "
            "'application/pdf', 1, :h, 'document', 'quarantined', now() - interval '3 days')"),
            {"i": file_id, "t": tenant, "k": f"k/{file_id}.pdf", "h": "c" * 64})
    await purge.purge(maintenance, store)
    assert _exists(admin, file_id)


async def _call(engine: AsyncEngine, sql: str, params: dict[str, Any]) -> Any:
    async with engine.connect() as conn:
        result = (await conn.execute(text(sql), params)).all()
        await conn.rollback()
        return result


async def test_the_functions_check_their_arguments_and_their_callers(
        admin: Engine, maintenance: AsyncEngine) -> None:
    for sql, params in (("SELECT * FROM admin.list_unusable_files(:n)", {"n": 0}),
                        ("SELECT * FROM admin.list_unusable_files(:n)", {"n": 1001})):
        with pytest.raises(DBAPIError) as refused:
            await _call(maintenance, sql, params)
        assert refused.value.orig.sqlstate == "22023"  # type: ignore[union-attr]
    # Not a clean file, and not a recent one, even when named.
    tenant = make_tenant(admin)
    clean = uuid.uuid4()
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, content_type, "
            "size_bytes, sha256, purpose, state, scan_status, scanned_at, updated_at) VALUES "
            "(:i, :t, 'clean', :k, 'image/jpeg', 1, :h, 'identity', 'clean', 'clean', now(), "
            "now() - interval '30 days')"),
            {"i": clean, "t": tenant, "k": f"{tenant}/{clean}", "h": "d" * 64})
    async with maintenance.connect() as conn:
        deleted = (await conn.execute(text("SELECT id FROM admin.delete_unusable_files(:ids)"),
                                      {"ids": [clean, uuid.uuid4()]})).all()
        await conn.commit()
    assert deleted == [] and _exists(admin, clean)
    # shri_maintenance sees no table; shri_app can't run either function.
    with pytest.raises(DBAPIError) as refused:
        await _call(maintenance, "SELECT count(*) FROM admin.binary_object", {})
    assert refused.value.orig.sqlstate == "42501"  # type: ignore[union-attr]
    assert TEST_DATABASE_URL
    app_engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    switch_to_role(app_engine.sync_engine, "shri_app")
    try:
        for sql in ("SELECT * FROM admin.list_unusable_files(10)",
                    "SELECT * FROM admin.delete_unusable_files(ARRAY[]::uuid[])"):
            with pytest.raises(DBAPIError) as refused:
                await _call(app_engine, sql, {})
            assert refused.value.orig.sqlstate == "42501"  # type: ignore[union-attr]
    finally:
        await app_engine.dispose()
