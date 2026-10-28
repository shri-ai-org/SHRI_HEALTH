"""The file service against a live database, as shri_app, with a LocalFileStore in a temporary
folder: core's tenant_db, idempotency, audit and restricted-chart check, and the real
repository. Only the sign-in, the scanner and the encryption are fakes (fakes.py), since clamd
and core's new_data_key() don't exist yet. Runs where ``TEST_DATABASE_URL`` is set. Synthetic
data only.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from urllib.request import url2pathname
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import CLINIC_A, CLINIC_B, DEV_USER_HEADER, DEV_USERS, CurrentUser, current_user
from app.db.models import MAPPERS
from app.db.tests import builders as b
from app.db.tests.conftest import (
    TEST_DATABASE_URL,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)
from app.main import create_app

from .. import crypto, scanner, storage
from .fakes import EICAR, JPEG, FakeFileCrypto, FakeScanner

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
M = MAPPERS
USERS = {"fd": CLINIC_A, "md": CLINIC_A, "bil": CLINIC_A, "fd-b": CLINIC_B}


@pytest.fixture
def admin() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    yield engine
    engine.dispose()


@pytest.fixture
def clinics(admin: Engine) -> dict[UUID, UUID]:
    return {CLINIC_A: make_tenant(admin), CLINIC_B: make_tenant(admin)}


@pytest.fixture
def app_engine() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_app")
    yield engine
    engine.dispose()


@pytest.fixture
def chart(app_engine: Engine, clinics: dict[UUID, UUID]) -> Iterator[Callable[[UUID], Session]]:
    opened: list[Session] = []

    def open_in(clinic: UUID) -> Session:
        session = open_session(app_engine, clinics[clinic])
        opened.append(session)
        return session
    yield open_in
    for session in opened:
        session.close()
        session.bind.close()  # type: ignore[union-attr]


@pytest.fixture
def users(chart: Callable[[UUID], Session], clinics: dict[UUID, UUID]
          ) -> dict[str, CurrentUser]:
    signed: dict[str, CurrentUser] = {}
    for name, clinic in USERS.items():
        session = chart(clinic)
        made = b.practitioner(session, "Lindqvist58", name.replace("-", ""))
        session.commit()
        dev = DEV_USERS[name.removesuffix("-b")]
        signed[name] = CurrentUser(id=made["user"].id, organization_id=clinics[clinic],
                                   roles=dev.roles, facility_ids=dev.facility_ids,
                                   display_name=dev.display_name)
    return signed


@pytest.fixture
def fake_scanner() -> FakeScanner:
    return FakeScanner()


@pytest.fixture
def fake_crypto() -> FakeFileCrypto:
    return FakeFileCrypto()


@pytest.fixture
def app(users: dict[str, CurrentUser], tmp_path: Path, fake_scanner: FakeScanner,
        fake_crypto: FakeFileCrypto) -> Iterator[FastAPI]:
    application = create_app(Settings(environment="test", auth_mode="dev_header",
                                      database_url=TEST_DATABASE_URL))
    switch_to_role(application.state.db.engine.sync_engine, "shri_app")

    def signed_in(request: Request) -> CurrentUser:
        return users[request.headers[DEV_USER_HEADER]]

    application.dependency_overrides[current_user] = signed_in
    application.dependency_overrides[storage.file_store] = (
        lambda: storage.LocalFileStore(tmp_path / "files"))
    application.dependency_overrides[scanner.scanner] = lambda: fake_scanner
    application.dependency_overrides[crypto.file_crypto] = lambda: fake_crypto
    yield application


@pytest.fixture
def client(app: FastAPI) -> Iterator[Callable[[str], TestClient]]:
    with TestClient(app, raise_server_exceptions=False) as test_client:
        def as_user(name: str) -> TestClient:
            test_client.headers[DEV_USER_HEADER] = name
            return test_client
        yield as_user
        assert test_client.portal is not None
        test_client.portal.call(app.state.db.dispose)


def _row(admin: Engine, file_id: Any) -> Any:
    with admin.connect() as c:
        return c.execute(text("SELECT * FROM admin.binary_object WHERE id = :i"),
                         {"i": file_id}).one_or_none()


def _path(url: str) -> Path:
    parts = urlsplit(url)
    assert parts.scheme == "file"
    return Path(url2pathname(parts.path))


def _upload(client: TestClient, data: bytes, *, sent: bytes | None = None,
            purpose: str = "insurance-card") -> UUID:
    """Steps 1 and 2: ask for the link, then "PUT" the bytes where it points."""
    response = client.post("/api/v1/files/upload-url", headers={
        "Idempotency-Key": str(uuid.uuid4())}, json={
        "purpose": purpose, "contentType": "image/jpeg", "sizeBytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest()})
    assert response.status_code == 201, response.text
    ticket = response.json()
    target = _path(ticket["uploadUrl"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data if sent is None else sent)
    return UUID(ticket["fileId"])


def test_upload_complete_clean_download(client: Callable[[str], TestClient], admin: Engine,
                                        clinics: dict[UUID, UUID], users: dict[str, CurrentUser],
                                        tmp_path: Path, fake_crypto: FakeFileCrypto) -> None:
    fd = client("fd")
    file_id = _upload(fd, JPEG)
    pending = _row(admin, file_id)
    assert (pending.state, pending.bucket, pending.scan_status) == (
        "pending-upload", "quarantine", "pending")
    assert pending.tenant_id == clinics[CLINIC_A] and pending.created_by_user_id == users["fd"].id
    assert pending.storage_key == f"{clinics[CLINIC_A]}/{file_id}"
    assert pending.original_filename is None and pending.wrapped_data_key is None

    completed = fd.post(f"/api/v1/files/{file_id}/complete")

    assert completed.status_code == 202, completed.text
    assert completed.json()["status"] == "succeeded"
    clean = _row(admin, file_id)
    assert (clean.state, clean.bucket, clean.scan_status) == ("clean", "clean", "clean")
    assert clean.scanned_at is not None and clean.wrapped_data_key == fake_crypto.wrapped[-1]
    assert clean.updated_by_user_id == users["fd"].id
    assert not (tmp_path / "files" / "quarantine" / clean.storage_key).exists()

    link = fd.get(f"/api/v1/files/{file_id}/download-url")

    assert link.status_code == 200, link.text
    assert _path(link.json()["url"]).read_bytes() == b"SEALED:" + JPEG
    with admin.connect() as c:
        audited = c.execute(text(
            "SELECT action, category FROM audit.audit_event WHERE tenant_id = :t "
            "AND actor_user_id = :u AND entity_id = :f ORDER BY chain_seq"),
            {"t": clinics[CLINIC_A], "u": users["fd"].id, "f": str(file_id)}).all()
    # completeUpload (U, phi-write) and createDownloadUrl (R, export) name the file in the path.
    assert [tuple(r) for r in audited] == [("update", "phi-write"), ("export", "export")]


def test_an_infected_file_is_rejected_and_never_downloaded(
        client: Callable[[str], TestClient], admin: Engine, tmp_path: Path) -> None:
    fd = client("fd")
    data = JPEG + EICAR
    file_id = _upload(fd, data)

    completed = fd.post(f"/api/v1/files/{file_id}/complete")

    assert completed.status_code == 202, completed.text
    assert completed.json()["status"] == "failed"
    assert completed.json()["error"]["code"] == "file-not-ready"
    row = _row(admin, file_id)
    assert (row.state, row.scan_status, row.bucket) == ("rejected", "infected", "quarantine")
    assert row.scanned_at is not None and row.wrapped_data_key is None
    assert not (tmp_path / "files" / row.storage_key).exists()  # never in the clean bucket
    refused = fd.get(f"/api/v1/files/{file_id}/download-url")
    assert refused.status_code == 409 and refused.json()["currentState"] == "rejected"
    again = fd.post(f"/api/v1/files/{file_id}/complete")
    assert again.status_code == 409 and again.json()["currentState"] == "rejected"


def test_a_hash_mismatch_is_rejected_unscanned(client: Callable[[str], TestClient],
                                               admin: Engine, fake_scanner: FakeScanner) -> None:
    fd = client("fd")
    file_id = _upload(fd, JPEG, sent=JPEG + b"tampered")
    assert fd.post(f"/api/v1/files/{file_id}/complete").json()["status"] == "failed"
    row = _row(admin, file_id)
    assert (row.state, row.scan_status, row.scanned_at) == ("rejected", "pending", None)
    assert not fake_scanner.scanned


def test_scanner_down_rolls_back_to_pending(client: Callable[[str], TestClient],
                                            admin: Engine, fake_scanner: FakeScanner) -> None:
    fd = client("fd")
    file_id = _upload(fd, JPEG)
    fake_scanner.unavailable = True
    assert fd.post(f"/api/v1/files/{file_id}/complete").status_code == 503
    assert _row(admin, file_id).state == "pending-upload"
    fake_scanner.unavailable = False
    assert fd.post(f"/api/v1/files/{file_id}/complete").status_code == 202  # finished later
    assert _row(admin, file_id).state == "clean"


def test_complete_without_bytes_and_by_others(client: Callable[[str], TestClient],
                                              admin: Engine) -> None:
    fd = client("fd")
    response = fd.post("/api/v1/files/upload-url", json={
        "purpose": "identity", "contentType": "image/png", "sizeBytes": 10,
        "sha256": "a" * 64})
    file_id = response.json()["fileId"]
    missing = fd.post(f"/api/v1/files/{file_id}/complete")
    assert missing.status_code == 409 and missing.json()["currentState"] == "pending-upload"
    assert client("md").post(f"/api/v1/files/{file_id}/complete").status_code == 404
    assert client("fd-b").post(f"/api/v1/files/{file_id}/complete").status_code == 404
    assert client("fd-b").get(f"/api/v1/files/{file_id}/download-url").status_code == 404
    assert client("bil").post(f"/api/v1/files/{file_id}/complete").status_code == 403
    assert _row(admin, file_id).state == "pending-upload"


def _clean_file(admin: Engine, clinic: UUID, owner: UUID, purpose: str, tmp_path: Path) -> UUID:
    """A clean file in the store, as a finished scan (or the server) leaves it."""
    file_id = uuid.uuid4()
    key = f"{clinic}/{file_id}"
    path = tmp_path / "files" / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(JPEG)
    generated = purpose in storage.GENERATED_PURPOSES
    with admin.begin() as c:
        c.execute(text(
            "INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, content_type, "
            "size_bytes, sha256, purpose, state, scan_status, scanned_at, wrapped_data_key, "
            "created_by_user_id) VALUES (:i, :t, 'clean', :k, 'image/jpeg', :n, :h, :p, "
            "'clean', :s, CASE WHEN :g THEN NULL ELSE now() END, "
            "CASE WHEN :g THEN NULL ELSE 'test-wrapped-key' END, :u)"),
            {"i": file_id, "t": clinic, "k": key, "n": len(JPEG),
             "h": hashlib.sha256(JPEG).hexdigest(), "p": purpose,
             "s": "pending" if generated else "clean", "g": generated, "u": owner})
    return file_id


def test_attached_files_follow_their_patient(
        client: Callable[[str], TestClient], chart: Callable[[UUID], Session], admin: Engine,
        clinics: dict[UUID, UUID], users: dict[str, CurrentUser], tmp_path: Path) -> None:
    """Each demo purpose's attachment, read as the repository reads it: a card image of a
    coverage, an identity document, a payment's receipt. A restricted patient's file needs
    break-glass (audited), whoever uploaded it."""
    clinic, owner = clinics[CLINIC_A], users["fd"].id
    db = chart(CLINIC_A)
    open_patient = b.patient(db, "Okafor", "Ada")
    restricted = b.patient(db, "Achebe", "Chinua", meta_security=["R"])
    db.commit()
    card = _clean_file(admin, clinic, owner, "insurance-card", tmp_path)
    identity = _clean_file(admin, clinic, owner, "identity", tmp_path)
    receipt = _clean_file(admin, clinic, owner, "receipt", tmp_path)
    cov = M["coverage"](status="active", beneficiary_patient_id=restricted.id, order=1,
                        relationship_code="self", subscriber_id="W123456789")
    db.add(cov)
    db.flush()
    cov.card_image = [M["coverage_card_image"](side="front", binary_object_id=card)]
    doc = M["document_reference"](status="current", type_system="http://loinc.org",
                                  type_code="34133-9", subject_patient_id=open_patient.id,
                                  date=b.NOW)
    doc.content = [M["document_reference_content"](attachment_content_type="image/jpeg",
                                                   attachment_binary_object_id=identity)]
    db.add(doc)
    db.add(M["patient_payment"](patient_id=open_patient.id, amount=25, method="cash",
                                collected_at=b.NOW, collected_by_user_id=owner,
                                is_refund=False, receipt_file_id=receipt))
    db.commit()

    # Attached: no longer the uploader's only. md and bil may read these purposes.
    assert client("md").get(f"/api/v1/files/{identity}/download-url").status_code == 200
    assert client("bil").get(f"/api/v1/files/{receipt}/download-url").status_code == 200
    # The card is the restricted patient's: break-glass, even for its uploader.
    for name in ("fd", "bil"):
        refused = client(name).get(f"/api/v1/files/{card}/download-url")
        assert refused.status_code == 403, refused.text
        assert refused.json()["code"] == "break-glass-required"
    with admin.connect() as c:
        denied = c.execute(text(
            "SELECT count(*) FROM audit.audit_event WHERE tenant_id = :t AND patient_id = :p "
            "AND action = 'access-denied'"), {"t": clinic, "p": restricted.id}).scalar_one()
    assert denied == 2
    # The care team opens it without break-glass (D37).
    db.add(M["care_team_member"](patient_id=restricted.id, user_id=users["bil"].id,
                                 role_code="billing", period_start=dt.date(2026, 1, 1)))
    db.commit()
    assert client("bil").get(f"/api/v1/files/{card}/download-url").status_code == 200
