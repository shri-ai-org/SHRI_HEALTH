"""The local file store and store_generated() without a database. Synthetic data only."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest

from app.core.db import TENANT_ID_INFO_KEY
from app.core.errors import ServiceUnavailable

from ..storage import FILE_STORE_DIR_ENV, LocalFileStore, file_store, store_generated

TENANT = UUID("0a000000-0000-4000-8000-00000000000a")


def _key() -> str:
    return f"{TENANT}/{uuid4()}"


async def test_put_get_delete(tmp_path: Path) -> None:
    store, key = LocalFileStore(tmp_path), _key()

    await store.put(key, b"%PDF-1.4 test", "application/pdf")

    assert await store.get(key) == b"%PDF-1.4 test"
    assert (tmp_path / key).stat().st_mode & 0o077 == 0  # the owner's only
    assert not [p for p in (tmp_path / str(TENANT)).iterdir() if p.name.startswith(".part-")]
    with pytest.raises(FileExistsError):
        await store.put(key, b"again", "application/pdf")
    assert await store.get(key) == b"%PDF-1.4 test"
    await store.delete(key)
    await store.delete(key)  # already gone: nothing happens
    with pytest.raises(FileNotFoundError):
        await store.get(key)


@pytest.mark.parametrize("key", [
    "../escape", f"{TENANT}/../../etc/passwd", f"/{TENANT}/{uuid4()}", f"{TENANT}", "",
    f"{TENANT}/{uuid4()}/more", f"{TENANT}/Not-A-UUID", f"{TENANT}\\{uuid4()}",
    f"{str(TENANT).upper()}/{uuid4()}",
])
async def test_only_generated_keys_inside_the_root(tmp_path: Path, key: str) -> None:
    store = LocalFileStore(tmp_path / "root")
    for call in (store.put(key, b"x", "text/plain"), store.get(key), store.delete(key)):
        with pytest.raises(ValueError):
            await call
    assert not (tmp_path / "root").exists()


class _Session:
    def __init__(self, fail: bool = False) -> None:
        self.info: dict[str, Any] = {TENANT_ID_INFO_KEY: TENANT}
        self.rows: list[dict[str, Any]] = []
        self.fail = fail

    async def execute(self, statement: Any, params: dict[str, Any]) -> None:
        if self.fail:
            raise RuntimeError("insert refused")
        self.rows.append(params)


async def test_store_generated_writes_the_bytes_and_the_row(tmp_path: Path) -> None:
    session, store = _Session(), LocalFileStore(tmp_path)
    data = b"%PDF-1.4 receipt"

    file_id = await store_generated(session, store, purpose="receipt",  # type: ignore[arg-type]
                                    content_type="application/pdf", data=data)

    (row,) = session.rows
    assert row["id"] == file_id and row["tenant_id"] == TENANT
    assert row["storage_key"] == f"{TENANT}/{file_id}"
    assert (row["bucket"], row["purpose"], row["content_type"]) == (
        "clean", "receipt", "application/pdf")
    assert row["size_bytes"] == len(data) and row["sha256"] == hashlib.sha256(data).hexdigest()
    assert await store.get(row["storage_key"]) == data


async def test_a_failed_insert_removes_the_bytes(tmp_path: Path) -> None:
    store = LocalFileStore(tmp_path)
    with pytest.raises(RuntimeError):
        await store_generated(_Session(fail=True), store,  # type: ignore[arg-type]
                              purpose="receipt", content_type="application/pdf", data=b"x")
    assert not list((tmp_path / str(TENANT)).iterdir())


async def test_only_generated_purposes(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        await store_generated(_Session(), LocalFileStore(tmp_path),  # type: ignore[arg-type]
                              purpose="insurance-card", content_type="image/jpeg", data=b"x")


def test_the_store_needs_its_folder(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv(FILE_STORE_DIR_ENV, raising=False)
    with pytest.raises(ServiceUnavailable):
        file_store()
    monkeypatch.setenv(FILE_STORE_DIR_ENV, str(tmp_path))
    store = file_store()
    assert isinstance(store, LocalFileStore) and store.root == tmp_path
