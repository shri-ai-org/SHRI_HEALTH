"""The after-visit summary against a live database (#86, D98), as shri_app, with core's
tenant_db, chart check, audit, idempotency, operations and download tokens running for real, and
the visit read from the real tables: the signed note (written here as the notes helpers write
it), its patient instructions section, the practice, the patient and the follow-up request.

Anand's ``store`` and ``latest`` (#157) run for real through this module's adapter: the PDF is
rendered, sealed and stored, its DocumentReference recorded, and the link is the files module's
(D105), downloaded through ``GET /files/{fileId}/content``. Only the file store (a temporary
folder), the encryption's data keys and the token secret are the files module's test stand-ins
(its fakes.py), since no object store or key service runs here; ``spy`` keeps what the adapter
was given. getAfterVisitSummaryDownloadUrl waits for core's T50 permission; the clients here
grant it as T50 proposes. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import re
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

from app.core import download_tokens as core_tokens
from app.core.crypto import DataKey
from app.core.deps import CurrentUser
from app.core.errors import ServiceUnavailable
from app.db.models import MAPPERS, systems
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.files import crypto as files_crypto
from app.modules.files import storage
from app.modules.files.tests.fakes import FakeFileCrypto, download_tokens
from app.modules.scheduling.tests import pending_permissions
from app.modules.scheduling.tests.conftest import Practice, make_client, setup_session
from app.modules.scheduling.tests.test_check_in_live import _key, _sql
from app.modules.scheduling.tests.test_check_in_live import checked_in_visit as _visit

from .. import api
from ..after_visit_summary import DocumentsSummaryStore, StoredSummary, SummaryDetails

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
M = MAPPERS


class Spy(DocumentsSummaryStore):
    """The real adapter (#157's store), keeping what it was given and what it stored."""

    def __init__(self) -> None:
        self.given: list[dict[str, Any]] = []
        self.stored: list[StoredSummary] = []

    async def store(self, db: Any, file_store: Any, crypto: Any, **given: Any) -> StoredSummary:
        self.given.append(given)
        made = await super().store(db, file_store, crypto, **given)
        self.stored.append(made)
        return made


class NoDataKeys:
    """Core's key service unavailable: no data key, so no file (503)."""

    async def new_data_key(self) -> DataKey:
        raise ServiceUnavailable("File encryption is not available")

    async def unwrap_data_key(self, wrapped: str) -> bytes:
        raise ServiceUnavailable("File encryption is not available")


@pytest.fixture
def spy() -> Spy:
    return Spy()


@pytest.fixture
def files(tmp_path: Path) -> storage.LocalFileStore:
    return storage.LocalFileStore(tmp_path / "files")


@pytest.fixture
def summary_crypto() -> files_crypto.FileCrypto:
    return FakeFileCrypto()


@pytest.fixture
def summary_client(users: dict[str, CurrentUser], spy: Spy, files: storage.LocalFileStore,
                   summary_crypto: files_crypto.FileCrypto,
                   monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    pending_permissions.grant(monkeypatch)
    tokens = download_tokens()
    yield from make_client(users, pending=True, overrides={
        api.summary_store: lambda: spy, api.summary_files: lambda: (lambda: files),
        storage.file_store: lambda: files, files_crypto.file_crypto: lambda: summary_crypto,
        core_tokens.download_tokens: lambda: tokens})


def _text(data: bytes) -> list[str]:
    """The PDF's lines of text (#157's pdf.py writes one ``(...) Tj`` per line)."""
    return [m.decode("cp1252").replace("\\(", "(").replace("\\)", ")")
            for m in re.findall(rb"\((.*?)\) Tj", data)]


def _documents(practice: Practice, encounter: str) -> list[Any]:
    rows: list[Any] = _sql(
        practice, "SELECT d.id, c.attachment_binary_object_id, d.status, d.type_code, "
        "d.subject_patient_id, d.ext_composition_id FROM clinical.document_reference d "
        "JOIN clinical.document_reference_content c ON c.document_reference_id = d.id "
        "WHERE d.context_encounter_id = :e ORDER BY d.date", e=encounter)
    return rows


def _grant(practice: Practice, users: dict[str, CurrentUser], user: str, patient: UUID) -> None:
    now = dt.datetime.now(dt.UTC)
    _sql(practice, "INSERT INTO audit.break_glass_access (id, tenant_id, patient_id, user_id, "
         "reason_code, granted_at, expires_at) VALUES (:i, :t, :p, :u, 'emergency-care', :g, "
         ":x)", i=uuid.uuid4(), t=practice.clinic, p=patient, u=users[user].id,
         g=now - dt.timedelta(minutes=1), x=now + dt.timedelta(hours=4))


def _signed_note(practice: Practice, users: dict[str, CurrentUser], encounter: str,
                 patient: str = "kaia", instructions: str | None = None) -> UUID:
    """A signed progress note on the encounter, written and signed by the md user's own
    practitioner (the database requires the signer to be the signing user's)."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        now = dt.datetime.now(dt.UTC)
        signer = db.get_one(M["app_user"], users["md"].id).practitioner_id
        note = M["composition"](
            tenant_id=practice.clinic, status="preliminary", type_system=systems.LOINC,
            type_code="11506-3", type_display="Progress note",
            subject_patient_id=practice.patients[patient], encounter_id=UUID(encounter),
            date=now, title="Office visit")
        note.author = [M["composition_author"](practitioner_id=signer)]
        sections = [M["composition_section"](
            sequence=1, title="Assessment and plan", code_system=systems.LOINC,
            code_code="51847-2", text_status="generated",
            text_div='<div xmlns="http://www.w3.org/1999/xhtml">Tension headache.</div>')]
        if instructions:
            sections.append(M["composition_section"](
                sequence=2, title="Patient instructions", code_system=systems.LOINC,
                code_code="69730-0", text_status="generated",
                text_div=f'<div xmlns="http://www.w3.org/1999/xhtml">{instructions}</div>'))
        note.section = sections
        db.add(note)
        db.flush()
        db.add(M["composition_attester"](composition_id=note.id, mode="legal", time=now,
                                         party_practitioner_id=signer,
                                         ext_user_id=users["md"].id,
                                         ext_content_sha256="0" * 64))
        db.flush()
        note.status = "final"
        db.flush()
        note_id: UUID = note.id
        db.commit()
        return note_id
    finally:
        db.close()
        admin.dispose()


def _addendum(practice: Practice, users: dict[str, CurrentUser], note: UUID) -> UUID:
    """An addendum to the signed note, as the notes helpers write it: a signed Composition of its
    own on the same visit, with a later legal attester, that appends to the note (now amended)."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        now = dt.datetime.now(dt.UTC) + dt.timedelta(seconds=1)
        signed = db.get_one(M["composition"], note)
        signer = db.get_one(M["app_user"], users["md"].id).practitioner_id
        add = M["composition"](
            tenant_id=practice.clinic, status="preliminary", type_system=systems.LOINC,
            type_code="11506-3", type_display="Progress note",
            subject_patient_id=signed.subject_patient_id, encounter_id=signed.encounter_id,
            date=now, title="Addendum")
        add.author = [M["composition_author"](practitioner_id=signer)]
        add.section = [M["composition_section"](
            sequence=1, title="Addendum", text_status="generated",
            text_div='<div xmlns="http://www.w3.org/1999/xhtml">Reviewed with the patient.</div>')]
        db.add(add)
        db.flush()
        db.add(M["composition_relates_to"](composition_id=add.id, code="appends",
                                           target_composition_id=note))
        db.add(M["composition_attester"](composition_id=add.id, mode="legal", time=now,
                                         party_practitioner_id=signer,
                                         ext_user_id=users["md"].id,
                                         ext_content_sha256="0" * 64))
        db.flush()
        add.status = "final"
        signed.status = "amended"
        db.flush()
        add_id: UUID = add.id
        db.commit()
        return add_id
    finally:
        db.close()
        admin.dispose()


def _create(client: Any, encounter: str, user: str = "md", **body: Any) -> Any:
    return client(user).post(f"{API}/encounters/{encounter}/after-visit-summary",
                             json=body or None, headers=_key())


def _link(client: Any, encounter: str, user: str) -> Any:
    return client(user).get(f"{API}/encounters/{encounter}/after-visit-summary/download-url")


def test_the_summary_is_made_from_the_visit_and_downloaded(
        summary_client: Any, practice: Practice, users: dict[str, CurrentUser], spy: Spy,
        files: storage.LocalFileStore) -> None:
    client = summary_client
    _, encounter = _visit(client, practice)
    tag = client("md").get(f"{API}/encounters/{encounter}").headers["ETag"]
    client("md").put(f"{API}/encounters/{encounter}/follow-up", headers={"If-Match": tag},
                     json={"interval": {"value": 2, "unit": "week"}})
    note = _signed_note(practice, users, encounter,
                        instructions="<p>Rest &amp; drink water.</p><p>Call if it gets worse.</p>")
    done = _create(client, encounter)
    assert done.status_code == 202, done.text
    operation = done.json()
    (stored,) = spy.stored
    assert operation["status"] == "succeeded"
    assert operation["result"] == {"type": "document", "id": str(stored.document_id)}
    polled = client("md").get(done.headers["Location"])  # core's operation, the creator's
    assert polled.status_code == 200 and polled.json()["status"] == "succeeded"
    assert client("ma").get(done.headers["Location"]).status_code == 404  # T26
    given = spy.given[0]
    assert given["note_id"] == note and given["patient_id"] == practice.patients["kaia"]
    linked = _sql(practice, "SELECT practitioner_id FROM admin.app_user WHERE id = :u",
                  u=users["md"].id)[0][0]
    assert given["author_practitioner_id"] == linked  # who generated it (#157)
    details: SummaryDetails = given["details"]
    assert details.practice_name == "Riverbend test practice (synthetic)"
    assert details.facility_name == "Main office (synthetic)"
    assert details.patient_name == "Kaia401 Lindgren118"
    assert details.clinician_name == "Dr. Avery401 Lindqvist58"
    assert details.time_zone == "America/Chicago"
    assert details.reason_for_visit == "Follow-up on headaches."
    assert details.instructions == "Rest & drink water.\nCall if it gets worse."
    assert details.follow_up is not None and details.follow_up.startswith(
        "Please come back in 2 weeks, around ")
    assert _sql(practice, "SELECT status, result_type FROM admin.operation WHERE id = :o",
                o=operation["id"])[0] == ("succeeded", "document")
    # #157's DocumentReference, pointing at the sealed PDF
    (document,) = _documents(practice, encounter)
    assert tuple(document) == (stored.document_id, stored.file_id, "current", "34133-9",
                               practice.patients["kaia"], note)
    (obj,) = _sql(practice, "SELECT purpose, state, storage_key FROM admin.binary_object "
                  "WHERE id = :f", f=stored.file_id)
    assert (obj.purpose, obj.state) == ("after-visit-summary", "clean")
    assert b"After-visit summary" not in (files.root / obj.storage_key).read_bytes()  # sealed
    # the files module's one-time link, then the decrypting download (D105)
    link = _link(client, encounter, "md")
    assert link.status_code == 200, link.text
    assert link.json()["documentId"] == str(stored.document_id)
    url = link.json()["url"]
    assert urlsplit(url).path == f"{API}/files/{stored.file_id}/content"
    pdf = client("md").get(url)
    assert pdf.status_code == 200, pdf.text
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["cache-control"] == "no-store"
    assert pdf.headers["content-disposition"] == (
        f'attachment; filename="after-visit-summary-{stored.file_id}.pdf"')
    assert pdf.content.startswith(b"%PDF-1.4")
    shown = _text(pdf.content)
    for expected in ("Riverbend test practice (synthetic)", "After-visit summary",
                     "Patient: Kaia401 Lindgren118", "Seen by: Dr. Avery401 Lindqvist58",
                     "Location: Main office (synthetic)", "Follow-up on headaches.",
                     "Rest & drink water.", "Call if it gets worse."):
        assert expected in shown, expected
    assert any(line.startswith("Please come back in 2 weeks, around ") for line in shown)
    assert client("md").get(url).status_code == 404  # the token is accepted once
    another = _link(client, encounter, "md").json()["url"]
    assert client("ma").get(another).status_code == 404  # another user's token
    assert client("md").get(another).status_code == 200  # still unused: the refusal spent none


def test_an_addendum_never_replaces_the_note(summary_client: Any, practice: Practice,
                                             users: dict[str, CurrentUser], spy: Spy) -> None:
    client = summary_client
    _, encounter = _visit(client, practice)
    note = _signed_note(practice, users, encounter, instructions="<p>Rest.</p>")
    addendum = _addendum(practice, users, note)
    asked = _create(client, encounter, noteId=str(addendum))
    assert asked.status_code == 422
    assert asked.json()["errors"][0]["code"] == "invalid-reference"
    assert spy.given == []
    assert _create(client, encounter).status_code == 202
    (given,) = spy.given
    assert given["note_id"] == note and given["details"].instructions == "Rest."
    (document,) = _documents(practice, encounter)
    assert document.ext_composition_id == note


def test_the_front_desk_prints_the_summary(summary_client: Any, practice: Practice,
                                           users: dict[str, CurrentUser]) -> None:
    """D98: the front desk prints the latest summary at check-out (after-visit-summaries:read
    on the files module's link since #216)."""
    client = summary_client
    _, encounter = _visit(client, practice)
    _signed_note(practice, users, encounter)
    assert _create(client, encounter).status_code == 202
    link = _link(client, encounter, "fd")
    assert link.status_code == 200, link.text
    assert client("fd").get(link.json()["url"]).status_code == 200


def test_summary_refusals(summary_client: Any, practice: Practice,
                          users: dict[str, CurrentUser], spy: Spy) -> None:
    client = summary_client
    _, encounter = _visit(client, practice)
    assert _link(client, encounter, "fd").status_code == 404  # none generated yet
    unsigned = _create(client, encounter)
    assert unsigned.status_code == 422
    assert unsigned.json()["errors"] == [{"in": "body", "pointer": "/noteId", "code": "required"}]
    _signed_note(practice, users, encounter)
    for user in ("fd", "ma", "bil", "none"):
        assert _create(client, encounter, user).status_code == 403, user
    assert _link(client, encounter, "bil").status_code == 403
    assert _create(client, encounter, "md-b").status_code == 404
    elsewhere = _create(client, encounter, noteId=str(uuid.uuid4()))
    assert elsewhere.status_code == 422
    assert elsewhere.json()["errors"][0]["code"] == "invalid-reference"
    assert _create(client, encounter, noteId="nope").status_code == 422
    _, restricted = _visit(client, practice, "restricted", hour=14)
    _signed_note(practice, users, restricted, patient="restricted")
    refused = _create(client, restricted)
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    assert _link(client, restricted, "fd").status_code == 403
    assert spy.given == []
    assert _documents(practice, encounter) == [] and _documents(practice, restricted) == []


def test_a_restricted_summary_needs_break_glass_at_the_desk(
        summary_client: Any, practice: Practice, users: dict[str, CurrentUser],
        spy: Spy) -> None:
    """D109 with core's chart check running for real, in this module and again in the files
    module's link and download: on a restricted chart the front desk without a grant gets 403
    break-glass-required, and the refusal is audited as an access denial naming the patient; a
    care-team member (ma) gets the link and the PDF, and a user with a current break-glass grant
    (rn) the link, without break-glass (D37)."""
    client = summary_client
    patient = practice.patients["restricted"]
    _, encounter = _visit(client, practice, "restricted", hour=15)
    _signed_note(practice, users, encounter, patient="restricted")
    _grant(practice, users, "md", patient)  # the clinician generated it under a grant
    assert _create(client, encounter).status_code == 202
    (made,) = spy.stored

    def denials() -> int:
        count: int = _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE patient_id = :p "
                          "AND action = 'access-denied' AND actor_user_id = :u",
                          p=patient, u=users["fd"].id)[0][0]
        return count

    before = denials()
    refused = _link(client, encounter, "fd")
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    assert denials() == before + 1
    _sql(practice, "INSERT INTO admin.care_team_member (id, tenant_id, patient_id, user_id, "
         "role_code, period_start) VALUES (:i, :t, :p, :u, 'care-manager', :s)",
         i=uuid.uuid4(), t=practice.clinic, p=patient, u=users["ma"].id,
         s=dt.date.today() - dt.timedelta(days=30))
    care_team = _link(client, encounter, "ma")
    assert care_team.status_code == 200, care_team.text
    assert care_team.json()["documentId"] == str(made.document_id)
    assert client("ma").get(care_team.json()["url"]).status_code == 200
    refused_rn = _link(client, encounter, "rn")
    assert refused_rn.status_code == 403 and refused_rn.json()["code"] == "break-glass-required"
    _grant(practice, users, "rn", patient)
    granted = _link(client, encounter, "rn")
    assert granted.status_code == 200, granted.text
    assert denials() == before + 1


def test_the_files_link_keeps_d109_for_the_summary(
        summary_client: Any, practice: Practice, users: dict[str, CurrentUser],
        spy: Spy) -> None:
    """D109 on the files module's own route (createDownloadUrl, D105), not only this module's:
    the front desk without a grant gets 403 break-glass-required for a restricted chart's
    summary; a care-team member and the MD with a grant read it; the front desk prints a normal
    chart's summary. The content route needs the same user's session and the one-time ticket."""
    client = summary_client

    def files_link(file_id: UUID, user: str) -> Any:
        return client(user).get(f"{API}/files/{file_id}/download-url")

    patient = practice.patients["restricted"]
    _, restricted = _visit(client, practice, "restricted", hour=15)
    _signed_note(practice, users, restricted, patient="restricted")
    _grant(practice, users, "md", patient)
    assert _create(client, restricted).status_code == 202
    (hidden,) = spy.stored
    refused = files_link(hidden.file_id, "fd")
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    _sql(practice, "INSERT INTO admin.care_team_member (id, tenant_id, patient_id, user_id, "
         "role_code, period_start) VALUES (:i, :t, :p, :u, 'care-manager', :s)",
         i=uuid.uuid4(), t=practice.clinic, p=patient, u=users["ma"].id,
         s=dt.date.today() - dt.timedelta(days=30))
    for user in ("ma", "md"):  # care team; the MD under the grant
        link = files_link(hidden.file_id, user)
        assert link.status_code == 200, (user, link.text)
        assert client(user).get(link.json()["url"]).status_code == 200, user
    # A normal chart: the front desk prints it.
    _, normal = _visit(client, practice, hour=16)
    _signed_note(practice, users, normal)
    assert _create(client, normal).status_code == 202
    shown = spy.stored[-1]
    link = files_link(shown.file_id, "fd")
    assert link.status_code == 200, link.text
    url = link.json()["url"]
    # The ticket alone isn't enough: no session, or another user's, is refused and spends nothing.
    anonymous = TestClient(client("fd").app, raise_server_exceptions=False)  # no session at all
    without = anonymous.get(url)
    assert without.status_code == 401 and without.json()["code"] == "unauthenticated"
    assert client("ma").get(url).status_code == 404
    pdf = client("fd").get(url)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF-1.4")
    assert client("fd").get(url).status_code == 404  # accepted once


def test_without_a_data_key_nothing_is_left_behind(
        summary_client: Any, practice: Practice, users: dict[str, CurrentUser],
        summary_crypto: Any, files: storage.LocalFileStore, monkeypatch: pytest.MonkeyPatch
        ) -> None:
    """No key, no summary (#157, #145): 503, and the operation, the document and the file row
    roll back with the request; no bytes are written."""
    monkeypatch.setattr(summary_crypto, "_keys", NoDataKeys())
    _, encounter = _visit(summary_client, practice)
    _signed_note(practice, users, encounter)
    refused = _create(summary_client, encounter)
    assert refused.status_code == 503 and refused.json()["code"] == "service-unavailable"
    assert _sql(practice, "SELECT count(*) FROM admin.operation WHERE created_by_user_id = :u",
                u=users["md"].id)[0][0] == 0
    assert _documents(practice, encounter) == []
    assert _sql(practice, "SELECT count(*) FROM admin.binary_object WHERE tenant_id = :t "
                "AND purpose = 'after-visit-summary'", t=practice.clinic)[0][0] == 0
    assert not files.root.exists() or not any(p.is_file() for p in files.root.rglob("*"))
