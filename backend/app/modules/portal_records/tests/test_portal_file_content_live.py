"""The patient portal's file download (downloadPortalFileContent) against a live database: the
real app, the portal as ``shri_portal``, the patient development sign-in (X-Dev-Patient, D108),
core's portal download tokens (#409), real AES-256-GCM over test data keys and an in-memory
store. Only a clean after-visit summary of the session patient's downloads; every other file is
the same 404 (D84, D90, D105). Synthetic data only."""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core import download_tokens as core_tokens
from app.core.download_tokens import PortalDownloadTokens
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.files import crypto as files_crypto
from app.modules.files import storage
from app.modules.files.tests.fakes import TOKEN_SECRET, FakeFileCrypto, MemoryFileStore
from app.modules.scheduling.tests.conftest import setup_session
from app.modules.scheduling.tests.portal_live import PortalChart, audit_rows, portal_client

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

PDF = b"%PDF-1.4\n% synthetic after-visit summary for tests\n%%EOF\n"


@pytest.fixture
def files(portal_app: TestClient) -> Iterator[dict[str, Any]]:
    """The app's file store, crypto and portal tokens, swapped for test ones."""
    world = {"store": MemoryFileStore(), "crypto": FakeFileCrypto(),
             "tokens": PortalDownloadTokens(TOKEN_SECRET)}
    overrides = portal_app.app.dependency_overrides  # type: ignore[attr-defined]
    overrides[storage.file_store] = lambda: world["store"]
    overrides[files_crypto.file_crypto] = lambda: world["crypto"]
    overrides[core_tokens.portal_download_tokens] = lambda: world["tokens"]
    yield world
    overrides.clear()


def _sql(chart: PortalChart, sql: str, **params: Any) -> None:
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, chart.practice.clinic)
    try:
        db.execute(text(sql), params)
        db.commit()
    finally:
        db.close()
        admin.dispose()


def _attach(chart: PortalChart, files: dict[str, Any], document: uuid.UUID,
            purpose: str = "after-visit-summary", data: bytes = PDF) -> uuid.UUID:
    """A server-made file as the file service leaves it (clean, encrypted at rest), attached to
    the document."""
    file_id = uuid.uuid4()
    key = storage.storage_key(chart.practice.clinic, file_id)
    sealed = asyncio.run(files["crypto"].seal(data, context=key))
    asyncio.run(files["store"].put(key, sealed.data, "application/pdf"))
    _sql(chart, """
        INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, content_type,
               size_bytes, sha256, purpose, state, scan_status, wrapped_data_key)
        VALUES (:i, :t, 'clean', :k, 'application/pdf', :n, :h, :p, 'clean', 'pending', :w)""",
         i=file_id, t=chart.practice.clinic, k=key, n=len(data),
         h=hashlib.sha256(data).hexdigest(), p=purpose, w=sealed.wrapped_data_key)
    _sql(chart, """
        INSERT INTO clinical.document_reference_content (id, tenant_id, document_reference_id,
               attachment_content_type, attachment_binary_object_id)
        VALUES (:i, :t, :d, 'application/pdf', :f)""",
         i=uuid.uuid4(), t=chart.practice.clinic, d=document, f=file_id)
    return file_id


def _link(files: dict[str, Any], chart: PortalChart, patient: uuid.UUID,
          file_id: uuid.UUID) -> str:
    tokens: PortalDownloadTokens = files["tokens"]
    token = tokens.sign(tokens.claims(file_id, patient, chart.practice.clinic))
    return f"/api/v1/portal/me/files/{file_id}/content?token={token}"


def test_my_summary_downloads_decrypted_once_and_is_audited_as_an_export(
        portal_app: Any, portal_chart: PortalChart, files: dict[str, Any]) -> None:
    a = portal_chart.a
    mine = _attach(portal_chart, files, portal_chart.ids["a-avs"])
    me = portal_client(portal_app, portal_chart, a)
    link = _link(files, portal_chart, a, mine)
    got = me.get(link)
    assert got.status_code == 200, got.text
    assert got.content == PDF                                      # decrypted, whole
    assert got.headers["content-disposition"] == (
        f'attachment; filename="after-visit-summary-{mine}.pdf"')  # never patient data
    assert got.headers["cache-control"] == "no-store"
    assert got.headers["referrer-policy"] == "no-referrer"
    assert me.get(link).status_code == 404                         # a token is used once
    rows = audit_rows(portal_chart.practice.clinic)
    assert any(r.patient_id == a and r.category == "export" and r.actor_type == "patient"
               for r in rows)


def test_every_other_file_is_the_same_404(portal_app: Any, portal_chart: PortalChart,
                                          files: dict[str, Any]) -> None:
    a, b, ids = portal_chart.a, portal_chart.b, portal_chart.ids
    me = portal_client(portal_app, portal_chart, a)
    refused = {
        "imaging": _attach(portal_chart, files, ids["a-avs"], purpose="imaging"),
        "held": _attach(portal_chart, files, ids["a-held-avs"]),
        "preliminary": _attach(portal_chart, files, ids["a-draft-avs"]),
        "theirs": _attach(portal_chart, files, ids["b-avs"]),
        "missing": uuid.uuid4(),
    }
    for why, file_id in refused.items():
        got = me.get(_link(files, portal_chart, a, file_id))
        assert got.status_code == 404, why
        assert got.json()["code"] == "not-found", why
    mine = _attach(portal_chart, files, ids["a-avs"])
    their_token = _link(files, portal_chart, b, mine)              # bound to B, used by A
    assert me.get(their_token).status_code == 404
    assert me.get(_link(files, portal_chart, a, mine)).status_code == 200


def test_a_token_is_required_and_a_staff_session_is_refused(
        portal_app: Any, portal_chart: PortalChart, files: dict[str, Any]) -> None:
    mine = _attach(portal_chart, files, portal_chart.ids["a-avs"])
    me = portal_client(portal_app, portal_chart, portal_chart.a)
    assert me.get(f"/api/v1/portal/me/files/{mine}/content").status_code == 422
    assert me.get(f"/api/v1/portal/me/files/{mine}/content?token=short").status_code == 422
    staff = portal_app.get(_link(files, portal_chart, portal_chart.a, mine),
                           headers={"X-Dev-User": "md"})
    assert staff.status_code in (401, 403), staff.status_code
