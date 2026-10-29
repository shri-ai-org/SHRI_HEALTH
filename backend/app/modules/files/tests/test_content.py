"""service.serve_content, the decrypting download (proposed GET /files/{fileId}/content on
#128; no route yet), with the in-memory fakes. Synthetic data only."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS
from app.core.errors import Conflict, Forbidden, NotFound, ServiceUnavailable

from .. import service
from ..crypto import UnconfiguredFileCrypto
from ..repository import FileRecord
from ..storage import CLEAN_BUCKET
from ..tokens import DownloadClaims, UnconfiguredDownloadTokens
from .fakes import (
    JPEG,
    FakeDownloadTokens,
    FakeFileCrypto,
    FakeRepository,
    FakeSession,
    MemoryFileStore,
    World,
)

PATIENT = UUID("5a000000-0000-4000-8000-000000000002")
# What _readable needs of a request: record_denial skips its row without a database.
REQUEST: Any = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=None)))


class Setup:
    def __init__(self) -> None:
        self.world, self.store = World(), MemoryFileStore()
        self.crypto, self.tokens = FakeFileCrypto(), FakeDownloadTokens()
        self.repo = FakeRepository(self.world)

    async def file(self, *, purpose: str = "insurance-card", owner: str = "fd",
                   encrypted: bool = True, data: bytes = JPEG) -> FileRecord:
        file_id = uuid4()
        key = f"{CLINIC_A}/{file_id}"
        wrapped = None
        stored = data
        if encrypted:
            sealed = await self.crypto.seal(data)
            stored, wrapped = sealed.data, sealed.wrapped_data_key
        self.store.objects[(CLEAN_BUCKET, key)] = (stored, "image/jpeg")
        return self.world.add(FileRecord(
            id=file_id, tenant_id=CLINIC_A, bucket=CLEAN_BUCKET, storage_key=key,
            content_type="image/jpeg", size_bytes=len(data),
            sha256=hashlib.sha256(data).hexdigest(), purpose=purpose, state="clean",
            created_by_user_id=DEV_USERS[owner].id, wrapped_data_key=wrapped))

    def token(self, file: FileRecord, user: str = "fd", **changes: Any) -> str:
        claims = {"file_id": file.id, "user_id": DEV_USERS[user].id,
                  "tenant_id": DEV_USERS[user].organization_id,
                  "expires_at": datetime.now(UTC) + timedelta(minutes=5), **changes}
        return self.tokens.sign(DownloadClaims(**claims))

    async def serve(self, file: FileRecord, token: str, user: str = "fd", *,
                    crypto: Any = None) -> service.FileContent:
        person = DEV_USERS[user]
        return await service.serve_content(
            REQUEST, FakeSession(person.organization_id), self.repo, self.store,  # type: ignore[arg-type]
            crypto or self.crypto, self.tokens, person, file.id, token)


async def _read(content: service.FileContent) -> bytes:
    return b"".join([chunk async for chunk in content.body])


@pytest.fixture
def setup() -> Setup:
    return Setup()


async def test_an_encrypted_file_is_decrypted_as_it_streams(setup: Setup) -> None:
    file = await setup.file()
    assert setup.store.objects[(CLEAN_BUCKET, file.storage_key)][0] != JPEG  # stored sealed

    content = await setup.serve(file, setup.token(file))

    chunks = [chunk async for chunk in content.body]
    assert b"".join(chunks) == JPEG and len(chunks) > 1
    assert content.headers == {
        "Content-Type": "image/jpeg", "Content-Length": str(len(JPEG)),
        "Content-Disposition": "attachment", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"}


async def test_a_file_stored_as_it_is_streams_as_it_is(setup: Setup) -> None:
    receipt = await setup.file(purpose="receipt", encrypted=False, data=b"%PDF-1.4 receipt")
    content = await setup.serve(receipt, setup.token(receipt))
    assert await _read(content) == b"%PDF-1.4 receipt"


@pytest.mark.parametrize("change", [
    {"file_id": uuid4()},                                   # another file's token
    {"user_id": DEV_USERS["md"].id},                        # another user's
    {"tenant_id": CLINIC_B},                                # another clinic's
    {"expires_at": datetime.now(UTC) - timedelta(seconds=1)},  # expired
])
async def test_a_token_for_anything_else_is_not_found(setup: Setup,
                                                      change: dict[str, Any]) -> None:
    file = await setup.file()
    with pytest.raises(NotFound):
        await setup.serve(file, setup.token(file, **change))


async def test_an_unknown_token_is_not_found(setup: Setup) -> None:
    with pytest.raises(NotFound):
        await setup.serve(await setup.file(), "not-a-token")


async def test_every_check_runs_again(setup: Setup) -> None:
    """A valid token opens nothing the user may no longer read."""
    card = await setup.file(owner="co")
    with pytest.raises(Forbidden) as denied:  # CO lacks coverages:read
        await setup.serve(card, setup.token(card, user="co"), user="co")
    assert denied.value.code == "permission-denied"

    other = await setup.file(owner="fd")  # unattached, someone else's upload
    with pytest.raises(NotFound):
        await setup.serve(other, setup.token(other, user="md"), user="md")

    restricted = await setup.file()
    setup.world.attachments[restricted.id] = {PATIENT}
    setup.world.restricted.add(PATIENT)
    with pytest.raises(Forbidden) as glass:
        await setup.serve(restricted, setup.token(restricted))
    assert glass.value.code == "break-glass-required"


async def test_only_a_clean_file(setup: Setup) -> None:
    file = await setup.file()
    token = setup.token(file)
    setup.world.files[CLINIC_A][file.id] = FileRecord(**{**file.__dict__, "state": "rejected"})
    with pytest.raises(Conflict) as refused:
        await setup.serve(file, token)
    assert refused.value.extensions["currentState"] == "rejected"


async def test_missing_bytes_are_not_found(setup: Setup) -> None:
    file = await setup.file()
    del setup.store.objects[(CLEAN_BUCKET, file.storage_key)]
    with pytest.raises(NotFound):
        await setup.serve(file, setup.token(file))


async def test_bytes_that_do_not_open_are_never_served(setup: Setup) -> None:
    file = await setup.file()
    setup.store.objects[(CLEAN_BUCKET, file.storage_key)] = (b"tampered", "image/jpeg")
    content = await setup.serve(file, setup.token(file))
    with pytest.raises(ValueError):
        await _read(content)


async def test_the_seams_refuse_until_core_has_them(setup: Setup) -> None:
    file = await setup.file()
    content = await setup.serve(file, setup.token(file), crypto=UnconfiguredFileCrypto())
    with pytest.raises(ServiceUnavailable):
        await _read(content)
    unconfigured = UnconfiguredDownloadTokens()
    with pytest.raises(ServiceUnavailable):
        unconfigured.verify("anything")
    with pytest.raises(ServiceUnavailable):
        unconfigured.sign(DownloadClaims(file.id, DEV_USERS["fd"].id, CLINIC_A,
                                         datetime.now(UTC)))
