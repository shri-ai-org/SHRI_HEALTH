"""The after-visit summary's hand-off against a live database (#86, D98), as shri_app, with core's
tenant_db, chart check, audit, idempotency and operations running for real, and the visit read
from the real tables: the signed note (written here as the notes helpers will write it, since
the notes API isn't built yet), its patient instructions section, the practice, the patient and
the follow-up request.

Anand's store (#157) isn't merged: ``recording`` stands in for it and keeps what it was given;
the app's own placeholder answers 503, and nothing is left behind (last test).
getAfterVisitSummaryDownloadUrl waits for core's T50 permission; the clients here grant it as
T50 proposes. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

from app.core.deps import CurrentUser
from app.db.models import MAPPERS, systems
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests import pending_permissions
from app.modules.scheduling.tests.conftest import Practice, make_client, setup_session
from app.modules.scheduling.tests.test_check_in_live import _key, _sql
from app.modules.scheduling.tests.test_check_in_live import checked_in_visit as _visit

from .. import api
from ..after_visit_summary import SummaryDetails, SummaryLink

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
M = MAPPERS


@dataclass
class Stored:
    document_id: UUID
    file_id: UUID
    generated_at: dt.datetime


@dataclass
class Recording:
    """Stands in for #157's store and latest, and the file service's link."""
    given: list[dict[str, Any]] = field(default_factory=list)
    stored: dict[UUID, list[Stored]] = field(default_factory=dict)

    async def store(self, db: Any, file_store: Any, *, patient_id: UUID, encounter_id: UUID,
                    note_id: UUID, author_practitioner_id: UUID, details: SummaryDetails
                    ) -> Stored:
        self.given.append({"patient_id": patient_id, "note_id": note_id,
                           "author": author_practitioner_id, "details": details})
        made = Stored(uuid.uuid4(), uuid.uuid4(), dt.datetime.now(dt.UTC))
        self.stored.setdefault(encounter_id, []).append(made)
        return made

    async def latest(self, db: Any, encounter_id: UUID) -> Stored | None:
        found = self.stored.get(encounter_id)
        return found[-1] if found else None

    async def link(self, db: Any, user: CurrentUser, file_id: UUID) -> SummaryLink:
        return SummaryLink(url=f"https://files.company-domain.invalid/clean/TEST-{file_id}",
                           expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(minutes=1))


@pytest.fixture
def recording() -> Recording:
    return Recording()


@pytest.fixture
def summary_client(users: dict[str, CurrentUser], recording: Recording,
                   monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    pending_permissions.grant(monkeypatch)
    yield from make_client(users, pending=True, overrides={
        api.summary_store: lambda: recording, api.summary_links: lambda: recording,
        api.summary_files: lambda: (lambda: None)})


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


def _create(client: Any, encounter: str, user: str = "md", **body: Any) -> Any:
    return client(user).post(f"{API}/encounters/{encounter}/after-visit-summary",
                             json=body or None, headers=_key())


def test_the_summary_is_made_from_the_visit(summary_client: Any, practice: Practice,
                                            users: dict[str, CurrentUser],
                                            recording: Recording) -> None:
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
    stored = recording.stored[UUID(encounter)][0]
    assert operation["status"] == "succeeded"
    assert operation["result"] == {"type": "document", "id": str(stored.document_id)}
    polled = client("md").get(done.headers["Location"])  # core's operation, the creator's
    assert polled.status_code == 200 and polled.json()["status"] == "succeeded"
    assert client("ma").get(done.headers["Location"]).status_code == 404  # T26
    given = recording.given[0]
    assert given["note_id"] == note and given["patient_id"] == practice.patients["kaia"]
    linked = _sql(practice, "SELECT practitioner_id FROM admin.app_user WHERE id = :u",
                  u=users["md"].id)[0][0]
    assert given["author"] == linked  # the practitioner who generated it (#157)
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
    link = client("fd").get(f"{API}/encounters/{encounter}/after-visit-summary/download-url")
    assert link.status_code == 200, link.text
    assert link.json()["documentId"] == str(stored.document_id)
    assert link.json()["url"].endswith(str(stored.file_id))


def test_summary_refusals(summary_client: Any, practice: Practice,
                          users: dict[str, CurrentUser], recording: Recording) -> None:
    client = summary_client
    _, encounter = _visit(client, practice)
    link = f"{API}/encounters/{encounter}/after-visit-summary/download-url"
    assert client("fd").get(link).status_code == 404  # none generated yet
    unsigned = _create(client, encounter)
    assert unsigned.status_code == 422
    assert unsigned.json()["errors"] == [{"in": "body", "pointer": "/noteId", "code": "required"}]
    _signed_note(practice, users, encounter)
    for user in ("fd", "ma", "bil", "none"):
        assert _create(client, encounter, user).status_code == 403, user
    assert client("bil").get(link).status_code == 403
    assert _create(client, encounter, "md-b").status_code == 404
    elsewhere = _create(client, encounter, noteId=str(uuid.uuid4()))
    assert elsewhere.status_code == 422
    assert elsewhere.json()["errors"][0]["code"] == "invalid-reference"
    assert _create(client, encounter, noteId="nope").status_code == 422
    _, restricted = _visit(client, practice, "restricted", hour=14)
    _signed_note(practice, users, restricted, patient="restricted")
    refused = _create(client, restricted)
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    assert client("fd").get(
        f"{API}/encounters/{restricted}/after-visit-summary/download-url").status_code == 403
    assert recording.given == []


def test_until_the_documents_service_is_wired_it_is_503(pending_client: Any,
                                                      practice: Practice,
                                                      users: dict[str, CurrentUser]) -> None:
    """The app's own placeholders: 503, and the operation rolls back with the request."""
    _, encounter = _visit(pending_client, practice)
    _signed_note(practice, users, encounter)
    refused = _create(pending_client, encounter)
    assert refused.status_code == 503 and refused.json()["code"] == "service-unavailable"
    link = pending_client("fd").get(
        f"{API}/encounters/{encounter}/after-visit-summary/download-url")
    assert link.status_code == 503
    assert _sql(practice, "SELECT count(*) FROM admin.operation WHERE created_by_user_id = :u",
                u=users["md"].id)[0][0] == 0
