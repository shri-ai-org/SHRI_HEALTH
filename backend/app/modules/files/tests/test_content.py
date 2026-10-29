"""service.serve_content, the decrypting download (GET /files/{fileId}/content, D105), and the
module's AES-256-GCM, with the in-memory fakes and core's download tokens. Synthetic data only."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS
from app.core.download_tokens import TTL_SECONDS, DownloadClaims
from app.core.errors import Conflict, Forbidden, NotFound, ServiceUnavailable

from .. import service
from ..crypto import FORMAT, FileTampered
from ..repository import FileRecord
from ..storage import CLEAN_BUCKET
from .fakes import (
    JPEG,
    FakeFileCrypto,
    FakeRepository,
    FakeSession,
    MemoryFileStore,
    World,
    download_tokens,
)

PATIENT = UUID("5a000000-0000-4000-8000-000000000002")
# What _readable needs of a request: record_denial skips its row without a database.
REQUEST: Any = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=None)))


class Setup:
    def __init__(self) -> None:
        self.world, self.store = World(), MemoryFileStore()
        self.crypto = FakeFileCrypto()
        self.now = datetime.now(UTC).timestamp()
        self.tokens = download_tokens(lambda: self.now)
        self.repo = FakeRepository(self.world)

    async def file(self, *, purpose: str = "insurance-card", owner: str = "fd",
                   data: bytes = JPEG) -> FileRecord:
        file_id = uuid4()
        key = f"{CLINIC_A}/{file_id}"
        sealed = await self.crypto.seal(data, context=key)
        self.store.objects[(CLEAN_BUCKET, key)] = (sealed.data, "image/jpeg")
        return self.world.add(FileRecord(
            id=file_id, tenant_id=CLINIC_A, bucket=CLEAN_BUCKET, storage_key=key,
            content_type="image/jpeg", size_bytes=len(data),
            sha256=hashlib.sha256(data).hexdigest(), purpose=purpose, state="clean",
            created_by_user_id=DEV_USERS[owner].id, wrapped_data_key=sealed.wrapped_data_key))

    def token(self, file: FileRecord, user: str = "fd", **changes: Any) -> str:
        claims = self.tokens.claims(file.id, DEV_USERS[user].id,
                                    DEV_USERS[user].organization_id)
        if changes:
            claims = DownloadClaims(**{**claims.__dict__, **changes})
        return self.tokens.sign(claims)

    async def serve(self, file: FileRecord, token: str, user: str = "fd") -> service.FileContent:
        person = DEV_USERS[user]
        return await service.serve_content(
            REQUEST, FakeSession(person.organization_id), self.repo, self.store,  # type: ignore[arg-type]
            self.crypto, self.tokens, person, file.id, token)


async def _read(content: service.FileContent) -> bytes:
    return b"".join([chunk async for chunk in content.body])


@pytest.fixture
def setup() -> Setup:
    return Setup()


# ==================================================================================== the format
async def test_sealed_bytes_are_not_the_file_and_open_only_with_their_key() -> None:
    crypto = FakeFileCrypto()
    key = f"{CLINIC_A}/{uuid4()}"
    sealed = await crypto.seal(JPEG, context=key)

    assert sealed.data.startswith(FORMAT) and JPEG not in sealed.data
    assert len(sealed.data) == len(FORMAT) + 12 + len(JPEG) + 16
    assert await crypto.open(sealed.data, sealed.wrapped_data_key, context=key) == JPEG
    again = await crypto.seal(JPEG, context=key)  # a fresh key and nonce every time
    assert again.data != sealed.data and again.wrapped_data_key != sealed.wrapped_data_key
    assert repr(sealed) == "SealedFile()"  # neither the bytes nor the key


@pytest.mark.parametrize("change", ["byte", "truncate", "format", "key", "context", "plain"])
async def test_anything_changed_does_not_open(change: str) -> None:
    crypto = FakeFileCrypto()
    key = f"{CLINIC_A}/{uuid4()}"
    sealed = await crypto.seal(JPEG, context=key)
    other = await crypto.seal(JPEG, context=key)
    data, wrapped, context = sealed.data, sealed.wrapped_data_key, key
    if change == "byte":
        data = data[:20] + bytes([data[20] ^ 1]) + data[21:]
    elif change == "truncate":
        data = data[:-1]
    elif change == "format":
        data = b"SHF2" + data[4:]
    elif change == "key":
        wrapped = other.wrapped_data_key
    elif change == "context":
        context = f"{CLINIC_B}/{key.split('/')[1]}"  # the same file ID in another clinic
    else:
        data = JPEG  # a file stored without encryption
    with pytest.raises(FileTampered):
        await crypto.open(data, wrapped, context=context)


async def test_no_wrapped_key_never_opens() -> None:
    crypto = FakeFileCrypto()
    with pytest.raises(FileTampered):
        await crypto.open(JPEG, None, context=f"{CLINIC_A}/{uuid4()}")


async def test_no_key_service_no_seal_and_no_open() -> None:
    crypto = FakeFileCrypto()
    key = f"{CLINIC_A}/{uuid4()}"
    sealed = await crypto.seal(JPEG, context=key)
    crypto.data_keys.unavailable = True
    with pytest.raises(ServiceUnavailable):
        await crypto.seal(JPEG, context=key)
    with pytest.raises(ServiceUnavailable):
        await crypto.open(sealed.data, sealed.wrapped_data_key, context=key)


# ============================================================================== the download
async def test_a_file_is_decrypted_and_streamed(setup: Setup) -> None:
    file = await setup.file()
    assert JPEG not in setup.store.objects[(CLEAN_BUCKET, file.storage_key)][0]

    content = await setup.serve(file, setup.token(file))

    chunks = [chunk async for chunk in content.body]
    assert b"".join(chunks) == JPEG
    assert content.headers == {
        "Content-Type": "image/jpeg", "Content-Length": str(len(JPEG)),
        "Content-Disposition": f'attachment; filename="insurance-card-{file.id}.jpg"',
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"}
    assert content.patient_ids == frozenset()


async def test_large_files_stream_in_chunks(setup: Setup) -> None:
    data = JPEG + bytes(3 * service.CONTENT_CHUNK_BYTES)
    file = await setup.file(data=data)
    chunks = [chunk async for chunk in (await setup.serve(file, setup.token(file))).body]
    assert b"".join(chunks) == data and len(chunks) == 4


async def test_the_files_patients_are_reported_for_the_audit(setup: Setup) -> None:
    file = await setup.file()
    setup.world.attachments[file.id] = {PATIENT}
    content = await setup.serve(file, setup.token(file))
    assert content.patient_ids == frozenset({PATIENT})


async def test_a_link_works_once(setup: Setup) -> None:
    file = await setup.file()
    token = setup.token(file)
    assert await _read(await setup.serve(file, token)) == JPEG
    with pytest.raises(NotFound):
        await setup.serve(file, token)


async def test_a_link_expires(setup: Setup) -> None:
    file = await setup.file()
    token = setup.token(file)
    setup.now += TTL_SECONDS + 1
    with pytest.raises(NotFound):
        await setup.serve(file, token)


@pytest.mark.parametrize("change", [
    {"file_id": uuid4()},          # another file's token
    {"tenant_id": CLINIC_B},       # another clinic's
])
async def test_a_token_for_anything_else_is_not_found(setup: Setup,
                                                      change: dict[str, Any]) -> None:
    file = await setup.file()
    with pytest.raises(NotFound):
        await setup.serve(file, setup.token(file, **change))


async def test_another_users_token_is_not_found_and_not_used_up(setup: Setup) -> None:
    file = await setup.file()
    token = setup.token(file)
    with pytest.raises(NotFound):
        await setup.serve(file, token, user="md")
    assert await _read(await setup.serve(file, token)) == JPEG


@pytest.mark.parametrize("token", ["not-a-token", "a.b", "x" * 300])
async def test_an_unknown_token_is_not_found(setup: Setup, token: str) -> None:
    with pytest.raises(NotFound):
        await setup.serve(await setup.file(), token)


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


async def test_a_tampered_file_is_never_served(setup: Setup) -> None:
    """Refused before the first byte: the response never starts."""
    file = await setup.file()
    sealed, content_type = setup.store.objects[(CLEAN_BUCKET, file.storage_key)]
    setup.store.objects[(CLEAN_BUCKET, file.storage_key)] = (sealed[:-1] + b"\x00",
                                                             content_type)
    with pytest.raises(FileTampered) as refused:
        await setup.serve(file, setup.token(file))
    assert refused.value.status == 500


async def test_a_file_stored_in_clear_is_never_served(setup: Setup) -> None:
    file = await setup.file()
    setup.store.objects[(CLEAN_BUCKET, file.storage_key)] = (JPEG, "image/jpeg")
    setup.world.files[CLINIC_A][file.id] = FileRecord(
        **{**file.__dict__, "wrapped_data_key": None})
    with pytest.raises(FileTampered):
        await setup.serve(file, setup.token(file))


async def test_no_key_service_is_503(setup: Setup) -> None:
    file = await setup.file()
    setup.crypto.data_keys.unavailable = True
    with pytest.raises(ServiceUnavailable):
        await setup.serve(file, setup.token(file))
