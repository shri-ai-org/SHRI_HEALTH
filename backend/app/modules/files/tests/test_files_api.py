"""createUploadUrl, completeUpload, createDownloadUrl and downloadFileContent with the in-memory
fakes (fakes.py), real AES-256-GCM and core's download tokens: every route's success, permission
refusal and main 4xx. test_files_live.py runs them on a real
database. Synthetic data only."""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import download_tokens as core_tokens
from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS
from app.core.download_tokens import TTL_SECONDS, DownloadTokens

from .. import crypto, service
from ..repository import FileRecord
from ..storage import CLEAN_BUCKET, QUARANTINE_BUCKET
from .fakes import (
    EICAR,
    JPEG,
    PNG,
    FakeFileCrypto,
    FakeOperations,
    FakeScanner,
    MemoryFileStore,
    World,
    download_tokens,
)

Client = Callable[[str], TestClient]
PATIENT = UUID("5a000000-0000-4000-8000-000000000001")


def _body(data: bytes = JPEG, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"purpose": "insurance-card", "contentType": "image/jpeg",
                            "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    body.update(overrides)
    return body


def _ask(client: TestClient, **body: Any) -> Any:
    return client.post("/api/v1/files/upload-url", json=_body(**body))


def _uploaded(client: TestClient, store: MemoryFileStore, data: bytes = JPEG, *,
              sent: bytes | None = None, **body: Any) -> UUID:
    """Steps 1 and 2: the ticket, and the bytes PUT into quarantine."""
    response = _ask(client, data=data, **body)
    assert response.status_code == 201, response.text
    file_id = UUID(response.json()["fileId"])
    key = f"{DEV_USERS[client.headers['X-Dev-User']].organization_id}/{file_id}"
    store.objects[(QUARANTINE_BUCKET, key)] = (data if sent is None else sent, "image/jpeg")
    return file_id


def _complete(client: TestClient, file_id: UUID) -> Any:
    return client.post(f"/api/v1/files/{file_id}/complete")


def _download(client: TestClient, file_id: UUID) -> Any:
    return client.get(f"/api/v1/files/{file_id}/download-url")


def _file(world: World, store: MemoryFileStore, *, purpose: str = "insurance-card",
          state: str = "clean", owner: str = "fd", clinic: UUID = CLINIC_A,
          content_type: str = "image/jpeg") -> FileRecord:
    """A file already in the store, in any state."""
    file_id = uuid4()
    key = f"{clinic}/{file_id}"
    bucket = CLEAN_BUCKET if state == "clean" else QUARANTINE_BUCKET
    store.objects[(bucket, key)] = (JPEG, content_type)
    return world.add(FileRecord(
        id=file_id, tenant_id=clinic, bucket=bucket, storage_key=key,
        content_type=content_type, size_bytes=len(JPEG),
        sha256=hashlib.sha256(JPEG).hexdigest(), purpose=purpose, state=state,
        created_by_user_id=DEV_USERS[owner].id))


def _problem(response: Any, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()
    assert body["code"] == code, body
    return body


# ================================================================================ createUploadUrl
def test_an_upload_link_into_quarantine(as_user: Client, world: World) -> None:
    before = datetime.now(UTC)
    response = _ask(as_user("fd"))

    assert response.status_code == 201, response.text
    assert "Location" not in response.headers
    ticket = response.json()
    file_id = UUID(ticket["fileId"])
    record = world.file(CLINIC_A, file_id)
    assert (record.state, record.bucket, record.purpose) == (
        "pending-upload", QUARANTINE_BUCKET, "insurance-card")
    assert record.storage_key == f"{CLINIC_A}/{file_id}"
    assert record.sha256 == hashlib.sha256(JPEG).hexdigest() and record.size_bytes == len(JPEG)
    assert record.created_by_user_id == DEV_USERS["fd"].id
    assert ticket["uploadUrl"] == f"memory://quarantine/{CLINIC_A}/{file_id}?put"
    assert ticket["uploadHeaders"] == {"Content-Type": "image/jpeg"}
    expires = datetime.fromisoformat(ticket["expiresAt"])
    assert before + timedelta(minutes=14) < expires <= before + timedelta(minutes=15, seconds=1)
    assert world.sessions[-1].commits == 1


def test_png_identity_images_too(as_user: Client) -> None:
    response = _ask(as_user("fd"), data=PNG, purpose="identity", contentType="image/png")
    assert response.status_code == 201, response.text


@pytest.mark.parametrize("name", ["bil", "co", "none", "dsp"])
def test_upload_needs_files_create(as_user: Client, world: World, name: str) -> None:
    _problem(_ask(as_user(name)), 403, "permission-denied")
    assert not world.files


@pytest.mark.parametrize(("overrides", "errors"), [
    ({"contentType": "application/pdf"}, [("/contentType", "not-allowed-value")]),
    ({"contentType": "image/heic"}, [("/contentType", "not-allowed-value")]),
    ({"sizeBytes": 10 * 1024 * 1024 + 1}, [("/sizeBytes", "out-of-range")]),
    ({"contentType": "image/gif", "sizeBytes": 20_000_000},
     [("/contentType", "not-allowed-value"), ("/sizeBytes", "out-of-range")]),
    ({"purpose": "receipt"}, [("/purpose", "not-allowed-value")]),
    ({"purpose": "after-visit-summary"}, [("/purpose", "not-allowed-value")]),
    ({"purpose": "document"}, [("/purpose", "not-allowed-value")]),
    ({"purpose": "encounter-audio"}, [("/purpose", "not-allowed-value")]),
])
def test_type_size_and_purpose_rules(as_user: Client, world: World, overrides: dict[str, Any],
                                     errors: list[tuple[str, str]]) -> None:
    body = _problem(_ask(as_user("fd"), **overrides), 422, "business-rule-violation")
    assert [(e["pointer"], e["code"]) for e in body["errors"]] == errors
    assert not world.files.get(CLINIC_A)


@pytest.mark.parametrize("overrides", [
    {"fileName": "card.jpg"},  # client file names are never accepted
    {"sha256": "ABC"}, {"sizeBytes": 0}, {"purpose": "selfie"},
])
def test_malformed_bodies(as_user: Client, world: World, overrides: dict[str, Any]) -> None:
    _problem(_ask(as_user("fd"), **overrides), 422, "validation-failed")
    assert not world.files.get(CLINIC_A)


# ================================================================================ completeUpload
def test_a_clean_upload(as_user: Client, world: World, store: MemoryFileStore,
                        fake_scanner: FakeScanner, fake_crypto: FakeFileCrypto,
                        fake_operations: FakeOperations) -> None:
    fd = as_user("fd")
    file_id = _uploaded(fd, store)

    response = _complete(fd, file_id)

    assert response.status_code == 202, response.text
    operation = response.json()
    assert operation["kind"] == "file.scan" and operation["status"] == "succeeded"
    assert operation["result"] == {"type": "file", "id": str(file_id)}
    assert "error" not in operation and operation["completedAt"]
    assert response.headers["Location"] == f"/api/v1/operations/{operation['id']}"
    assert response.headers["Retry-After"] == "2"  # core's accepted()
    assert fake_operations.operations[UUID(operation["id"])].status == "succeeded"
    assert fake_operations.events == [(file_id, "clean")]
    record = world.file(CLINIC_A, file_id)
    assert (record.state, record.bucket) == ("clean", CLEAN_BUCKET)
    assert world.scan_status[file_id] == "clean"
    assert world.wrapped_keys[file_id] == fake_crypto.wrapped[-1]   # only through FileCrypto
    key = f"{CLINIC_A}/{file_id}"
    stored = store.objects[(CLEAN_BUCKET, key)][0]
    assert stored.startswith(b"SHF1") and JPEG not in stored  # sealed, never plain
    assert (QUARANTINE_BUCKET, key) not in store.objects
    assert fake_scanner.scanned == [JPEG]
    assert world.sessions[-1].commits == 1


def test_complete_needs_files_create(as_user: Client, store: MemoryFileStore,
                                     world: World) -> None:
    file_id = _uploaded(as_user("fd"), store)
    _problem(_complete(as_user("bil"), file_id), 403, "permission-denied")
    assert world.file(CLINIC_A, file_id).state == "pending-upload"


def test_complete_twice(as_user: Client, store: MemoryFileStore) -> None:
    fd = as_user("fd")
    file_id = _uploaded(fd, store)
    assert _complete(fd, file_id).status_code == 202
    body = _problem(_complete(fd, file_id), 409, "invalid-state-transition")
    assert body["currentState"] == "clean"


def test_complete_without_the_bytes(as_user: Client, world: World,
                                    fake_scanner: FakeScanner) -> None:
    fd = as_user("fd")
    file_id = UUID(_ask(fd).json()["fileId"])
    body = _problem(_complete(fd, file_id), 409, "invalid-state-transition")
    assert body["currentState"] == "pending-upload"
    assert world.file(CLINIC_A, file_id).state == "pending-upload" and not fake_scanner.scanned


def test_a_generated_file_is_never_completed(as_user: Client, world: World,
                                             store: MemoryFileStore) -> None:
    receipt = _file(world, store, purpose="receipt")
    body = _problem(_complete(as_user("fd"), receipt.id), 409, "invalid-state-transition")
    assert body["currentState"] == "clean"


@pytest.mark.parametrize("name", ["md", "md-b"])
def test_only_the_uploader_completes(as_user: Client, store: MemoryFileStore, world: World,
                                     name: str) -> None:
    file_id = _uploaded(as_user("fd"), store)
    _problem(_complete(as_user(name), file_id), 404, "not-found")
    assert world.file(CLINIC_A, file_id).state == "pending-upload"


@pytest.mark.parametrize(("sent", "body", "scan_status", "scanned"), [
    (JPEG + b"x", {}, "pending", False),                          # not the declared bytes
    (b"\xff\xd8\xff" + b"other synthetic bytes", {}, "pending", False),  # hash mismatch
    (PNG, {"data": PNG}, "pending", False),                       # a PNG declared as JPEG
    (JPEG + EICAR, {"data": JPEG + EICAR}, "infected", True),     # malware
])
def test_rejected_uploads(as_user: Client, world: World, store: MemoryFileStore,
                          fake_scanner: FakeScanner, fake_crypto: FakeFileCrypto,
                          fake_operations: FakeOperations, sent: bytes,
                          body: dict[str, Any], scan_status: str, scanned: bool) -> None:
    fd = as_user("fd")
    file_id = _uploaded(fd, store, sent=sent, **body)

    response = _complete(fd, file_id)

    assert response.status_code == 202, response.text
    operation = response.json()
    assert operation["status"] == "failed" and "result" not in operation
    error = operation["error"]
    assert error["code"] == "file-not-ready" and error["status"] == 422
    assert error["fileId"] == str(file_id)
    assert error["type"].endswith("problem/file-not-ready")
    assert fake_operations.operations[UUID(operation["id"])].status == "failed"
    assert fake_operations.events == [(file_id, "rejected")]
    assert world.file(CLINIC_A, file_id).state == "rejected"
    assert world.scan_status[file_id] == scan_status
    assert bool(fake_scanner.scanned) is scanned
    assert not fake_crypto.wrapped and file_id not in world.wrapped_keys
    key = f"{CLINIC_A}/{file_id}"
    assert (CLEAN_BUCKET, key) not in store.objects
    assert (QUARANTINE_BUCKET, key) in store.objects  # kept for the purge
    # Downloads are clean only.
    refused = _problem(_download(fd, file_id), 409, "invalid-state-transition")
    assert refused["currentState"] == "rejected"


def test_scanner_down_leaves_the_upload_pending(as_user: Client, world: World,
                                                store: MemoryFileStore,
                                                fake_scanner: FakeScanner,
                                                fake_operations: FakeOperations) -> None:
    fd = as_user("fd")
    file_id = _uploaded(fd, store)
    fake_scanner.unavailable = True
    _problem(_complete(fd, file_id), 503, "service-unavailable")
    # The fake session has no rollback; the real one rolls back (test_files_live.py). Nothing
    # was committed and nothing reached the clean bucket.
    assert world.sessions[-1].commits == 0
    assert (CLEAN_BUCKET, f"{CLINIC_A}/{file_id}") not in store.objects
    assert not fake_operations.events


def test_no_data_key_leaves_the_upload_pending(as_user: Client, world: World,
                                               store: MemoryFileStore,
                                               fake_crypto: FakeFileCrypto) -> None:
    fd = as_user("fd")
    file_id = _uploaded(fd, store)
    fake_crypto.data_keys.unavailable = True
    _problem(_complete(fd, file_id), 503, "service-unavailable")
    assert world.sessions[-1].commits == 0
    assert (CLEAN_BUCKET, f"{CLINIC_A}/{file_id}") not in store.objects


def test_without_the_key_service_no_clean_file(app: FastAPI, as_user: Client, world: World,
                                               store: MemoryFileStore) -> None:
    """The real dependency, with OpenBao Transit not configured: core fails closed, and the
    file service answers 503, never a clean file in clear."""
    app.dependency_overrides.pop(crypto.file_crypto)
    fd = as_user("fd")
    file_id = _uploaded(fd, store)
    _problem(_complete(fd, file_id), 503, "service-unavailable")
    assert world.sessions[-1].commits == 0
    assert (CLEAN_BUCKET, f"{CLINIC_A}/{file_id}") not in store.objects


# ============================================================================= createDownloadUrl
def test_a_link_to_the_decrypting_endpoint(as_user: Client, store: MemoryFileStore,
                                           fake_tokens: DownloadTokens) -> None:
    fd = as_user("fd")
    file_id = _uploaded(fd, store)
    assert _complete(fd, file_id).status_code == 202
    before = datetime.now(UTC)

    response = _download(fd, file_id)

    assert response.status_code == 200, response.text
    link = response.json()
    url = urlsplit(link["url"])
    assert url.path == f"/api/v1/files/{file_id}/content" and not url.netloc
    (token,) = parse_qs(url.query)["token"]
    claims = fake_tokens.verify(token, user_id=DEV_USERS["fd"].id, file_id=file_id,
                                tenant_id=CLINIC_A)
    assert claims is not None
    assert (claims.file_id, claims.user_id, claims.tenant_id) == (
        file_id, DEV_USERS["fd"].id, CLINIC_A)
    assert link["contentType"] == "image/jpeg" and link["sizeBytes"] == len(JPEG)
    expires = datetime.fromisoformat(link["expiresAt"])
    assert expires == claims.expires_at <= before + timedelta(seconds=TTL_SECONDS + 1)


def test_a_generated_file_links_the_same_way(as_user: Client, world: World,
                                             store: MemoryFileStore) -> None:
    receipt = _file(world, store, purpose="receipt", owner="fd")
    link = _download(as_user("fd"), receipt.id).json()
    assert urlsplit(link["url"]).path == f"/api/v1/files/{receipt.id}/content"


def test_no_tokens_no_download(app: FastAPI, as_user: Client, store: MemoryFileStore) -> None:
    """Core's own dependency, without a SESSION_SECRET: no link is made (503)."""
    app.dependency_overrides.pop(core_tokens.download_tokens)
    fd = as_user("fd")
    file_id = _uploaded(fd, store)
    assert _complete(fd, file_id).status_code == 202
    _problem(_download(fd, file_id), 503, "service-unavailable")


@pytest.mark.parametrize("name", ["none", "dsp", "sup"])
def test_download_needs_files_read(as_user: Client, world: World, store: MemoryFileStore,
                                   name: str) -> None:
    _problem(_download(as_user(name), _file(world, store).id), 403, "permission-denied")


@pytest.mark.parametrize("state", ["pending-upload", "quarantined", "rejected"])
def test_downloads_are_clean_only(as_user: Client, world: World, store: MemoryFileStore,
                                  state: str) -> None:
    record = _file(world, store, state=state)
    body = _problem(_download(as_user("fd"), record.id), 409, "invalid-state-transition")
    assert body["currentState"] == state


def test_an_unattached_file_is_its_uploaders_only(as_user: Client, world: World,
                                                  store: MemoryFileStore) -> None:
    record = _file(world, store, owner="fd")
    _problem(_download(as_user("md"), record.id), 404, "not-found")
    # Not even its state is told.
    pending = _file(world, store, owner="fd", state="quarantined")
    _problem(_download(as_user("md"), pending.id), 404, "not-found")


def test_another_clinics_file_is_not_found(as_user: Client, world: World,
                                           store: MemoryFileStore) -> None:
    record = _file(world, store, owner="md-b", clinic=CLINIC_B)
    _problem(_download(as_user("fd"), record.id), 404, "not-found")
    _problem(_download(as_user("fd"), uuid4()), 404, "not-found")


@pytest.mark.parametrize(("purpose", "allowed", "refused"), [
    ("insurance-card", ["fd", "bil", "md"], ["co"]),        # coverages:read
    ("identity", ["fd", "co", "md"], []),                   # patients:read
    ("receipt", ["fd", "bil", "md"], ["ma", "rn", "co"]),   # payments:create or superbills:read
    ("after-visit-summary", ["md", "bil", "co"], ["fd", "adm"]),  # encounters:read
])
def test_the_purpose_decides_who_downloads(as_user: Client, world: World,
                                           store: MemoryFileStore, purpose: str,
                                           allowed: list[str], refused: list[str]) -> None:
    record = _file(world, store, purpose=purpose, owner="adm")
    world.attachments[record.id] = {PATIENT}
    for name in allowed:
        assert _download(as_user(name), record.id).status_code == 200, (name, purpose)
    for name in refused:
        _problem(_download(as_user(name), record.id), 403, "permission-denied")


@pytest.mark.parametrize("purpose", ["encounter-audio", "document", "fax", "ccda", "export",
                                     "onboarding-import"])
def test_purposes_not_built_yet_are_denied(as_user: Client, world: World,
                                           store: MemoryFileStore, purpose: str) -> None:
    record = _file(world, store, purpose=purpose, owner="adm")
    _problem(_download(as_user("adm"), record.id), 403, "permission-denied")


def test_a_restricted_patients_file_needs_break_glass(as_user: Client, world: World,
                                                      store: MemoryFileStore) -> None:
    record = _file(world, store, owner="fd")
    world.attachments[record.id] = {PATIENT}
    world.restricted.add(PATIENT)
    body = _problem(_download(as_user("fd"), record.id), 403, "break-glass-required")
    assert "url" not in body
    world.granted.add((DEV_USERS["fd"].id, PATIENT))
    assert _download(as_user("fd"), record.id).status_code == 200


def test_an_attached_file_is_checked_before_its_state(as_user: Client, world: World,
                                                      store: MemoryFileStore) -> None:
    record = _file(world, store, owner="fd", state="quarantined")
    world.attachments[record.id] = {PATIENT}
    world.restricted.add(PATIENT)
    _problem(_download(as_user("bil"), record.id), 403, "break-glass-required")


def test_the_lifetimes() -> None:
    assert service.UPLOAD_LINK_LIFETIME == timedelta(minutes=15)
    assert TTL_SECONDS <= 60  # a download link: about a minute (D105)



# =========================================================================== downloadFileContent
def _clean_upload(client: TestClient, store: MemoryFileStore, data: bytes = JPEG) -> UUID:
    file_id = _uploaded(client, store, data)
    assert _complete(client, file_id).json()["status"] == "succeeded"
    return file_id


def _link(client: TestClient, file_id: UUID) -> str:
    response = _download(client, file_id)
    assert response.status_code == 200, response.text
    url = urlsplit(response.json()["url"])
    return f"{url.path}?{url.query}"


def test_the_link_downloads_the_file_once(as_user: Client, world: World,
                                          store: MemoryFileStore) -> None:
    fd = as_user("fd")
    file_id = _clean_upload(fd, store)
    link = _link(fd, file_id)

    response = fd.get(link)

    assert response.status_code == 200, response.text
    assert response.content == JPEG  # decrypted
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["content-length"] == str(len(JPEG))
    assert response.headers["content-disposition"] == (
        f'attachment; filename="insurance-card-{file_id}.jpg"')
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert world.audited == [[], []]  # the link and the download; unattached: no patient
    # Accepted once: the same link again is not found, as for any bad token.
    _problem(fd.get(link), 404, "not-found")
    # A new link works.
    assert fd.get(_link(fd, file_id)).content == JPEG


def test_an_expired_link_is_not_found(app: FastAPI, as_user: Client,
                                      store: MemoryFileStore) -> None:
    now = [datetime.now(UTC).timestamp()]
    app.dependency_overrides[core_tokens.download_tokens] = (
        lambda tokens=download_tokens(lambda: now[0]): tokens)
    fd = as_user("fd")
    link = _link(fd, _clean_upload(fd, store))
    now[0] += TTL_SECONDS + 1
    _problem(fd.get(link), 404, "not-found")


def test_the_token_is_not_enough_on_its_own(as_user: Client, store: MemoryFileStore) -> None:
    fd = as_user("fd")
    file_id = _clean_upload(fd, store)
    link = _link(fd, file_id)
    anonymous = as_user("fd")
    del anonymous.headers["X-Dev-User"]
    _problem(anonymous.get(link), 401, "unauthenticated")
    _problem(as_user("bil").get(link), 404, "not-found")  # another user's token
    assert fd.get(link).content == JPEG  # and neither refusal used it up


def test_a_token_for_another_file_is_not_found(as_user: Client, store: MemoryFileStore) -> None:
    fd = as_user("fd")
    first, second = _clean_upload(fd, store), _clean_upload(fd, store, JPEG + b"2")
    token = parse_qs(urlsplit(_link(fd, first)).query)["token"][0]
    _problem(fd.get(f"/api/v1/files/{second}/content", params={"token": token}),
             404, "not-found")


@pytest.mark.parametrize("token", ["", "short", "x" * 513, "not a token with spaces" * 3,
                                   "a.b" * 20])
def test_a_malformed_token(as_user: Client, store: MemoryFileStore, token: str) -> None:
    fd = as_user("fd")
    file_id = _clean_upload(fd, store)
    _problem(fd.get(f"/api/v1/files/{file_id}/content", params={"token": token}),
             422, "validation-failed")


def test_a_tampered_file_is_refused(as_user: Client, store: MemoryFileStore) -> None:
    fd = as_user("fd")
    file_id = _clean_upload(fd, store)
    key = (CLEAN_BUCKET, f"{CLINIC_A}/{file_id}")
    sealed, content_type = store.objects[key]
    flipped = bytes([sealed[-1] ^ 1])
    store.objects[key] = (sealed[:-1] + flipped, content_type)

    response = fd.get(_link(fd, file_id))

    _problem(response, 500, "internal-error")
    assert JPEG not in response.content


def test_another_files_bytes_do_not_open(as_user: Client, store: MemoryFileStore) -> None:
    """Ciphertext is bound to its file: moved under another file's key, it doesn't verify."""
    fd = as_user("fd")
    first, second = _clean_upload(fd, store), _clean_upload(fd, store, JPEG + b"2")
    store.objects[(CLEAN_BUCKET, f"{CLINIC_A}/{second}")] = (
        store.objects[(CLEAN_BUCKET, f"{CLINIC_A}/{first}")])
    _problem(fd.get(_link(fd, second)), 500, "internal-error")


def test_the_checks_run_again(as_user: Client, world: World, store: MemoryFileStore) -> None:
    fd = as_user("fd")
    file_id = _clean_upload(fd, store)
    link = _link(fd, file_id)
    world.attachments[file_id] = {PATIENT}
    world.restricted.add(PATIENT)  # restricted after the link was made
    _problem(fd.get(link), 403, "break-glass-required")


def test_the_download_names_the_files_patient(as_user: Client, world: World,
                                              store: MemoryFileStore) -> None:
    fd = as_user("fd")
    file_id = _clean_upload(fd, store)
    world.attachments[file_id] = {PATIENT}
    assert fd.get(_link(fd, file_id)).status_code == 200
    assert world.audited == [[PATIENT], [PATIENT]]  # the link, then the download
