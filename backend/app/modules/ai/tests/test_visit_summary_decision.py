"""decideVisitSummary without a database (D70, D119; Vimal on #85, 17 Nov): the requester's one
accept, edit or reject; accepted and edited text goes into the named draft note in the decision's
transaction, rejected writes nothing; each field only with its decision; a second decision is
refused; a signed note refuses the text and the summary stays pending. The route itself: a
success and a permission-denied. The encounters' seam (the top of the note's first section, the
author only, a draft only) is tested with the encounters' note fakes. Synthetic data only."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.deps import DEV_USERS, CurrentUser, current_user, tenant_db
from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.db.models.enums import AIDecision, AIFeature
from app.main import create_app
from app.modules.ai import api
from app.modules.ai import visit_summaries as vs
from app.modules.ai.repository import SuggestionRecord
from app.modules.ai.schemas import VisitSummaryDecision
from app.modules.encounters import ai_drafts
from app.modules.encounters import repository as encounters_repository
from app.modules.encounters.tests.fakes import DOCTOR, FakeRepository, FakeSession, World
from app.modules.encounters.tests.notes_fakes import (
    FakeClinicalStore,
    FakeNote,
    FakeNoteRepository,
    FakeSection,
    NotesWorld,
)

from .fakes import FakeAIRepository

API = "/api/v1"
MD = DEV_USERS["md"]
STATEMENTS = [
    {"sequence": 1, "text": "Seen for a cough of three days.", "sources": [
        {"resourceType": "Encounter", "resourceId": str(uuid4()), "label": "Reason for visit"}]},
    {"sequence": 2, "text": "Temperature 98.4 °F.", "sources": [
        {"resourceType": "Observation", "resourceId": str(uuid4()), "label": "Vital sign"}]},
]


class DB:
    commits = 0

    async def commit(self) -> None:
        self.commits += 1


async def _stored(repo: FakeAIRepository, requester: CurrentUser = MD,
                  statements: list[dict[str, Any]] | None = None) -> UUID:
    found = STATEMENTS if statements is None else statements
    stored = await repo.record_suggestion(None, SuggestionRecord(  # type: ignore[arg-type]
        request_id=uuid4(), feature=AIFeature.CHART_SUMMARY, patient_id=uuid4(),
        encounter_id=uuid4(), target_resource_type=vs.VISIT_SUMMARY,
        content={"statements": found, "insufficientEvidence": not found},
        confidence="medium", rationale="r", unknowns=()))
    repo.requested_by[stored] = requester.id
    return stored


async def _open(*_: Any) -> None:
    return None


class Place:
    """The encounters' seam, recorded; raises ``refuse`` when set."""

    def __init__(self, refuse: Exception | None = None) -> None:
        self.calls: list[tuple[UUID, UUID, str]] = []
        self.refuse = refuse
        self.note_id = uuid4()

    async def __call__(self, db: Any, user: CurrentUser, encounter_id: UUID, note_id: UUID,
                       text: str) -> UUID:
        if self.refuse is not None:
            raise self.refuse
        self.calls.append((encounter_id, note_id, text))
        return note_id


async def _decide(repo: FakeAIRepository, place: Place, summary_id: UUID, user: CurrentUser = MD,
                  db: DB | None = None, **body: Any) -> Any:
    named: list[UUID] = []
    found = await vs.decide(db or DB(), repo, _open, place, user,  # type: ignore[arg-type]
                            summary_id, VisitSummaryDecision(**body), named.append)
    assert named
    return found


async def test_accepted_puts_the_statements_in_the_note_and_shows_the_decision() -> None:
    repo, place, db = FakeAIRepository(), Place(), DB()
    summary_id = await _stored(repo)
    pending = await vs.get(None, repo, _open, MD, summary_id)  # type: ignore[arg-type]
    assert pending.decision == "pending" and pending.note_id is None
    note = uuid4()
    found = await _decide(repo, place, summary_id, db=db, decision="accepted", note_id=note)
    assert place.calls == [(repo.suggestions[summary_id].encounter_id, note,
                            "Seen for a cough of three days. Temperature 98.4 °F.")]
    assert repo.decisions[summary_id] is AIDecision.ACCEPTED
    assert repo.targets[summary_id] == note
    assert db.commits == 1
    assert found.decision == "accepted" and found.note_id == note
    assert found.edited_text is None and found.rejection_reason is None
    assert found.decided_at is not None


async def test_edited_puts_the_clinicians_text_in_the_note() -> None:
    repo, place = FakeAIRepository(), Place()
    summary_id = await _stored(repo)
    note = uuid4()
    found = await _decide(repo, place, summary_id, decision="edited", note_id=note,
                          text="  Cough for three days, afebrile.  ")
    assert place.calls[0][2] == "Cough for three days, afebrile."
    assert found.decision == "edited" and found.note_id == note
    assert found.edited_text == "Cough for three days, afebrile."


async def test_rejected_writes_nothing_in_the_note() -> None:
    repo, place = FakeAIRepository(), Place()
    summary_id = await _stored(repo)
    found = await _decide(repo, place, summary_id, decision="rejected",
                          reason="Leaves out the examination.")
    assert place.calls == [] and summary_id not in repo.targets
    assert found.decision == "rejected" and found.note_id is None
    assert found.rejection_reason == "Leaves out the examination."


@pytest.mark.parametrize(("body", "pointer"), [
    ({"decision": "edited", "note_id": uuid4()}, "/text"),             # edited without text
    ({"decision": "rejected"}, "/reason"),                              # rejected, no reason
    ({"decision": "accepted"}, "/noteId"),                              # no note to go into
    ({"decision": "rejected", "reason": "No.", "note_id": uuid4()}, "/noteId"),
    ({"decision": "accepted", "note_id": uuid4(), "text": "Mine."}, "/text"),
    ({"decision": "accepted", "note_id": uuid4(), "reason": "No."}, "/reason"),
])
async def test_each_field_only_with_its_decision(body: dict[str, Any], pointer: str) -> None:
    repo, place = FakeAIRepository(), Place()
    summary_id = await _stored(repo)
    with pytest.raises(ValidationFailed) as refused:
        await _decide(repo, place, summary_id, **body)
    assert refused.value.code == "validation-failed"
    assert pointer in [e["pointer"] for e in refused.value.extensions["errors"]]
    assert place.calls == [] and summary_id not in repo.decisions


async def test_a_second_decision_is_refused() -> None:
    repo, place = FakeAIRepository(), Place()
    summary_id = await _stored(repo)
    await _decide(repo, place, summary_id, decision="rejected", reason="Not useful.")
    with pytest.raises(Conflict) as refused:
        await _decide(repo, place, summary_id, decision="accepted", note_id=uuid4())
    assert refused.value.code == "invalid-state-transition"
    assert refused.value.extensions["currentState"] == "rejected"
    assert place.calls == []


async def test_a_signed_note_refuses_the_text_and_the_summary_stays_pending() -> None:
    repo = FakeAIRepository()
    place = Place(Conflict("The note is signed: changes go in an addendum",
                           code="record-locked"))
    summary_id = await _stored(repo)
    with pytest.raises(Conflict) as refused:
        await _decide(repo, place, summary_id, decision="accepted", note_id=uuid4())
    assert refused.value.code == "record-locked"
    assert summary_id not in repo.decisions and summary_id not in repo.targets


async def test_only_its_requester_decides() -> None:
    repo, place = FakeAIRepository(), Place()
    summary_id = await _stored(repo)
    for user in (DEV_USERS["app"], DEV_USERS["md-b"]):
        with pytest.raises(NotFound):
            await _decide(repo, place, summary_id, user=user, decision="rejected",
                          reason="Not mine.")
    with pytest.raises(NotFound):
        await _decide(repo, place, uuid4(), decision="rejected", reason="No such summary.")
    assert summary_id not in repo.decisions


async def test_an_empty_summary_cannot_be_accepted() -> None:
    repo, place = FakeAIRepository(), Place()
    summary_id = await _stored(repo, statements=[])
    with pytest.raises(ValidationFailed) as refused:
        await _decide(repo, place, summary_id, decision="accepted", note_id=uuid4())
    assert refused.value.code == "business-rule-violation"
    found = await _decide(repo, place, summary_id, decision="edited", note_id=uuid4(),
                          text="Seen today; nothing else recorded yet.")
    assert found.decision == "edited"


# ------------------------------------------------------------------------------- the route
@pytest.fixture
def route() -> Iterator[tuple[FastAPI, FakeAIRepository, Place]]:
    application = create_app(Settings(environment="test", auth_mode="dev_header"))
    repo, place = FakeAIRepository(), Place()

    async def fake_db(user: CurrentUser = Depends(current_user)) -> FakeSession:
        return FakeSession(user.organization_id)

    application.dependency_overrides[tenant_db] = fake_db
    application.dependency_overrides[api.repository] = lambda: repo
    application.dependency_overrides[api.chart_check] = lambda: _open
    application.dependency_overrides[api.audit_patients] = lambda: (lambda request, ids: None)
    application.dependency_overrides[api.summary_placer] = lambda: place
    yield application, repo, place
    application.dependency_overrides.clear()


def _as(application: FastAPI, name: str) -> TestClient:
    c = TestClient(application, raise_server_exceptions=False)
    c.headers["X-Dev-User"] = name
    return c


async def test_the_route_decides_and_needs_the_permission(
        route: tuple[FastAPI, FakeAIRepository, Place]) -> None:
    application, repo, place = route
    summary_id = await _stored(repo)
    path = f"{API}/ai/visit-summaries/{summary_id}/decision"
    note = str(uuid4())
    denied = _as(application, "fd").post(path, json={"decision": "accepted", "noteId": note})
    assert denied.status_code == 403, denied.text
    assert denied.json()["code"] == "permission-denied"
    assert place.calls == []
    done = _as(application, "md").post(path, json={"decision": "accepted", "noteId": note})
    assert done.status_code == 200, done.text
    assert done.json()["decision"] == "accepted" and done.json()["noteId"] == note
    assert done.json()["aiGenerated"] is True
    unknown = _as(application, "md").post(path, json={"decision": "accepted", "noteId": note,
                                                      "extra": 1})
    assert unknown.status_code == 422


# ------------------------------------------------------------------- the encounters' seam
Seam = tuple[NotesWorld, ai_drafts.EncounterNoteDrafts, list[UUID]]


@pytest.fixture
def seam(monkeypatch: pytest.MonkeyPatch) -> Seam:
    """The encounters' note fakes; the AI-assisted mark (one SQL update) is recorded."""
    world = NotesWorld(World(), practitioners={MD.id: DOCTOR})
    marked: list[UUID] = []

    async def mark(db: Any, note_id: UUID) -> None:
        marked.append(note_id)

    monkeypatch.setattr(encounters_repository, "mark_ai_assisted", mark)
    store: Any = FakeClinicalStore(world)   # the note helpers this seam uses, not all of them
    drafts = ai_drafts.EncounterNoteDrafts(store=store, repo=FakeRepository(world.base),
                                           notes=FakeNoteRepository(world))
    return world, drafts, marked


def _note(world: NotesWorld, encounter_id: UUID, first: str = "Cough.",
          status: str = "preliminary", author: UUID = DOCTOR) -> FakeNote:
    e = world.base.encounters[encounter_id]
    n = FakeNote(uuid4(), encounter_id, e.patient_id, "SOAP progress note", "11506-3", author,
                 [FakeSection(uuid4(), "61150-9", "Subjective", True, first),
                  FakeSection(uuid4(), "18776-5", "Plan", True, "Rest.")], None,
                 status=status)
    world.notes[n.id] = n
    return n


async def test_the_seam_puts_the_text_at_the_top_of_the_first_section(seam: Seam) -> None:
    world, drafts, marked = seam
    encounter = world.base.add_encounter(status="in-progress")
    note = _note(world, encounter)
    db = FakeSession(MD.organization_id)
    placed = await drafts.place_visit_summary(db, world.base.chart_check, MD,  # type: ignore[arg-type]
                                              encounter, note.id, "Summary.")
    assert placed == note.id
    assert note.sections[0].text == "Summary.\n\nCough."
    assert note.sections[1].text == "Rest."
    assert note.version == 2 and db.commits == 0      # the caller commits
    assert marked == [note.id]
    empty = _note(world, encounter, first="")
    await drafts.place_visit_summary(db, world.base.chart_check, MD,  # type: ignore[arg-type]
                                     encounter, empty.id, "Summary.")
    assert empty.sections[0].text == "Summary."


async def test_the_seam_refuses_a_signed_note_another_visit_and_another_author(
        seam: Seam) -> None:
    world, drafts, marked = seam
    encounter = world.base.add_encounter(status="in-progress")
    other_visit = world.base.add_encounter(status="in-progress")
    db = FakeSession(MD.organization_id)
    check = world.base.chart_check
    signed = _note(world, encounter, status="final")
    with pytest.raises(Conflict) as locked:
        await drafts.place_visit_summary(db, check, MD, encounter,  # type: ignore[arg-type]
                                         signed.id, "Summary.")
    assert locked.value.code == "record-locked"
    assert signed.sections[0].text == "Cough."
    elsewhere = _note(world, other_visit)
    with pytest.raises(ValidationFailed) as wrong:
        await drafts.place_visit_summary(db, check, MD, encounter,  # type: ignore[arg-type]
                                         elsewhere.id, "Summary.")
    assert wrong.value.code == "business-rule-violation"
    theirs = _note(world, encounter, author=uuid4())
    with pytest.raises(Forbidden):
        await drafts.place_visit_summary(db, check, MD, encounter,  # type: ignore[arg-type]
                                         theirs.id, "Summary.")
    assert theirs.sections[0].text == "Cough."
    assert marked == []
