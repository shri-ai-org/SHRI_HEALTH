"""The diagnoses, notes and close endpoints with in-memory fakes (notes_fakes.py): a success, a
permission-denied and a validation-error test for each, plus the rules the service owns (the
first note starts the visit, the sign and close guards, author-only edits, BIL's signed-only
reads). The real database is test_notes_live.py's. Synthetic data only."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.deps import DEV_USERS

from .. import api, diagnoses_api, notes_api, notes_service
from .fakes import DOCTOR, World
from .notes_fakes import (
    ICD10CM,
    TEMPLATE,
    FakeClinicalStore,
    FakeDiagnosisRepository,
    FakeNoteRepository,
    NotesWorld,
)

API = "/api/v1"
MERGE = {"Content-Type": "application/merge-patch+json"}
Client = Callable[[str], TestClient]


@pytest.fixture
def notes(world: World, fake_app: FastAPI, monkeypatch: pytest.MonkeyPatch
          ) -> Iterator[NotesWorld]:
    w = NotesWorld(world, practitioners={DEV_USERS["md"].id: DOCTOR})
    fake_app.dependency_overrides[api.fhir_store] = lambda: FakeClinicalStore(w)
    fake_app.dependency_overrides[diagnoses_api.diagnosis_repository] = (
        lambda: FakeDiagnosisRepository(w))
    fake_app.dependency_overrides[notes_api.note_repository] = lambda: FakeNoteRepository(w)
    fake_app.dependency_overrides[notes_api.template_reader] = lambda: w.template

    async def publish(db: Any, kind: str, subject: str, *args: Any, **kw: Any) -> UUID:
        w.published.append((kind, subject))
        return uuid4()

    monkeypatch.setattr(notes_service, "publish", publish)
    yield w


def _encounter(world: World, status: str = "in-progress") -> UUID:
    return world.add_encounter(status=status)


def _started(as_user: Client, encounter: UUID) -> dict[str, Any]:
    created = as_user("md").post(f"{API}/encounters/{encounter}/notes",
                                 json={"templateId": str(TEMPLATE)})
    assert created.status_code == 201, created.text
    body: dict[str, Any] = created.json()
    return body


def _tag(as_user: Client, note_id: str) -> str:
    tag: str = as_user("md").get(f"{API}/notes/{note_id}").headers["ETag"]
    return tag


# -------------------------------------------------------------------------------- diagnoses
def test_add_a_diagnosis(as_user: Client, world: World, notes: NotesWorld) -> None:
    encounter = _encounter(world)
    path = f"{API}/encounters/{encounter}/diagnoses"
    done = as_user("md").post(path, json={"code": {"system": ICD10CM, "code": "I10"}})
    assert done.status_code == 201, done.text
    assert done.json()["rank"] == 1
    assert done.json()["code"]["display"] == "Essential (primary) hypertension"
    assert world.audited == [world.encounters[encounter].patient_id]
    header = as_user("md").post(path, json={"code": {"system": ICD10CM, "code": "E11"}})
    assert header.status_code == 422 and header.json()["code"] == "business-rule-violation"


def test_add_a_diagnosis_permission_and_validation(as_user: Client, world: World,
                                                  notes: NotesWorld) -> None:
    path = f"{API}/encounters/{_encounter(world)}/diagnoses"
    body = {"code": {"system": ICD10CM, "code": "I10"}}
    assert as_user("fd").post(path, json=body).status_code == 403
    assert as_user("md").post(path, json={"rank": 1}).status_code == 422
    assert as_user("md").post(path, json={**body, "rank": 13}).status_code == 422
    restricted = _encounter(world)
    world.restricted.add(world.encounters[restricted].patient_id)
    refused = as_user("md").post(f"{API}/encounters/{restricted}/diagnoses", json=body)
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"


def test_remove_a_diagnosis(as_user: Client, world: World, notes: NotesWorld) -> None:
    encounter = _encounter(world)
    path = f"{API}/encounters/{encounter}/diagnoses"
    first = as_user("md").post(path, json={"code": {"system": ICD10CM, "code": "I10"}}).json()
    remove = f"{path}/{first['id']}/remove"
    assert as_user("ma").post(remove, json={"reason": "Wrong."}).status_code == 403
    assert as_user("md").post(remove, json={"reason": ""}).status_code == 422
    done = as_user("md").post(remove, json={"reason": "Added to the wrong encounter."})
    assert done.status_code == 200 and done.json()["verificationStatus"] == "entered-in-error"
    again = as_user("md").post(remove, json={"reason": "Again."})
    assert again.status_code == 409


# ------------------------------------------------------------------------------------ notes
def test_create_a_note_starts_the_visit(as_user: Client, world: World,
                                        notes: NotesWorld) -> None:
    encounter = _encounter(world, "triaged")
    note = _started(as_user, encounter)
    assert note["status"] == "preliminary" and note["title"] == "Follow-up visit"
    assert [s["code"] for s in note["sections"]] == ["10154-3", "69730-0"]
    assert world.encounters[encounter].status == "in-progress"
    assert ("encounter.status-changed", f"encounter/{encounter}") in notes.published


def test_create_a_note_permission_and_validation(as_user: Client, world: World,
                                                 notes: NotesWorld) -> None:
    path = f"{API}/encounters/{_encounter(world)}/notes"
    assert as_user("fd").post(path, json={"templateId": str(TEMPLATE)}).status_code == 403
    assert as_user("rn").post(path, json={"templateId": str(TEMPLATE)}).status_code == 403
    neither = as_user("md").post(path, json={})
    assert neither.status_code == 422 and neither.json()["errors"][0]["pointer"] == "/templateId"
    assert as_user("md").post(path, json={"templateId": str(uuid4())}).status_code == 422
    assert as_user("md").post(path, json={"title": 5}).status_code == 422
    finished = _encounter(world, "finished")
    closed = as_user("md").post(f"{API}/encounters/{finished}/notes",
                                json={"templateId": str(TEMPLATE)})
    assert closed.status_code == 409


def test_get_and_list_notes(as_user: Client, world: World, notes: NotesWorld) -> None:
    encounter = _encounter(world)
    note = _started(as_user, encounter)
    got = as_user("md").get(f"{API}/notes/{note['id']}")
    assert got.status_code == 200 and got.headers["ETag"] == '"1"'
    listed = as_user("md").get(f"{API}/encounters/{encounter}/notes")
    assert [n["id"] for n in listed.json()["items"]] == [note["id"]]
    assert as_user("fd").get(f"{API}/notes/{note['id']}").status_code == 403
    assert as_user("fd").get(f"{API}/encounters/{encounter}/notes").status_code == 403
    assert as_user("md").get(f"{API}/notes/nope").status_code == 422
    assert as_user("md").get(f"{API}/encounters/{encounter}/notes",
                             params={"status": "draft"}).status_code == 422
    # BIL reads signed notes only: a draft is 404.
    assert as_user("bil").get(f"{API}/notes/{note['id']}").status_code == 404
    assert as_user("bil").get(f"{API}/encounters/{encounter}/notes").json()["items"] == []


def test_autosave(as_user: Client, world: World, notes: NotesWorld) -> None:
    note = _started(as_user, _encounter(world))
    path = f"{API}/notes/{note['id']}"
    body = {"sections": [{"id": note["sections"][0]["id"], "text": "Headache."}]}
    assert as_user("md").patch(path, json=body, headers=MERGE).status_code == 428
    assert as_user("md").patch(path, json=body,
                               headers={"If-Match": '"9"', **MERGE}).status_code == 412
    saved = as_user("md").patch(path, json=body, headers={"If-Match": '"1"', **MERGE})
    assert saved.status_code == 200 and saved.headers["ETag"] == '"2"'
    assert saved.json()["sections"][0]["text"] == "Headache."
    assert as_user("ma").patch(path, json=body,
                               headers={"If-Match": '"2"', **MERGE}).status_code == 403
    notes.practitioners[DEV_USERS["rn"].id] = uuid4()  # a clinician, not the author
    assert as_user("rn").patch(path, json=body,
                               headers={"If-Match": '"2"', **MERGE}).status_code == 403
    bad = as_user("md").patch(path, json={"sections": [{"id": str(uuid4()), "text": "x"}]},
                              headers={"If-Match": '"2"', **MERGE})
    assert bad.status_code == 422 and bad.json()["errors"][0]["code"] == "invalid-reference"
    assert as_user("md").patch(path, json={"sections": "x"},
                               headers={"If-Match": '"2"', **MERGE}).status_code == 422


def test_sign_and_amend(as_user: Client, world: World, notes: NotesWorld) -> None:
    encounter = _encounter(world)
    note = _started(as_user, encounter)
    path = f"{API}/notes/{note['id']}"
    refused = as_user("md").post(f"{path}/sign", headers={"If-Match": '"1"'})
    assert refused.status_code == 422 and refused.json()["errors"] == [
        {"in": "body", "pointer": "/sections/0/text", "code": "required"}]
    assert as_user("ma").post(f"{path}/sign", headers={"If-Match": '"1"'}).status_code == 403
    assert as_user("md").post(f"{path}/sign").status_code == 428
    body = {"sections": [{"id": note["sections"][0]["id"], "text": "Headache."}]}
    as_user("md").patch(path, json=body, headers={"If-Match": '"1"', **MERGE})
    signed = as_user("md").post(f"{path}/sign", headers={"If-Match": '"2"'})
    assert signed.status_code == 200 and signed.json()["status"] == "final"
    assert ("note.signed", f"note/{note['id']}") in notes.published
    locked = as_user("md").patch(path, json=body, headers={"If-Match": '"3"', **MERGE})
    assert locked.status_code == 409 and locked.json()["code"] == "record-locked"
    addenda = f"{path}/addenda"
    assert as_user("ma").post(addenda, json={"text": "x"},
                              headers={"If-Match": '"3"'}).status_code == 403
    assert as_user("md").post(addenda, json={"text": ""},
                              headers={"If-Match": '"3"'}).status_code == 422
    amended = as_user("md").post(addenda, json={"text": "Reviewed the log."},
                                 headers={"If-Match": '"3"'})
    assert amended.status_code == 200 and amended.json()["status"] == "amended"
    assert [a["text"] for a in amended.json()["addenda"]] == ["Reviewed the log."]
    versions = as_user("md").get(f"{path}/versions")
    assert [v["status"] for v in versions.json()["items"]] == [
        "amended", "final", "preliminary", "preliminary"]
    assert as_user("fd").get(f"{path}/versions").status_code == 403
    assert as_user("md").get(f"{path}/versions", params={"limit": 0}).status_code == 422
    assert [v["status"] for v in as_user("bil").get(f"{path}/versions").json()["items"]] == [
        "amended", "final"]
    # Diagnoses are locked once a note is signed (D24).
    late = as_user("md").post(f"{API}/encounters/{encounter}/diagnoses",
                              json={"code": {"system": ICD10CM, "code": "I10"}})
    assert late.status_code == 409 and late.json()["code"] == "record-locked"


# ------------------------------------------------------------------------------------ close
def test_close(as_user: Client, world: World, notes: NotesWorld) -> None:
    encounter = _encounter(world)
    path = f"{API}/encounters/{encounter}/close"
    assert as_user("ma").post(path).status_code == 403
    assert as_user("md").post(f"{API}/encounters/nope/close").status_code == 422
    note = _started(as_user, encounter)
    refused = as_user("md").post(path)
    assert refused.status_code == 422 and [e["pointer"] for e in refused.json()["errors"]] == [
        "/notes", "/notes"]  # no signed note, an open draft; the fake visit has no appointment
    body = {"sections": [{"id": note["sections"][0]["id"], "text": "Headache."}]}
    as_user("md").patch(f"{API}/notes/{note['id']}", json=body,
                        headers={"If-Match": '"1"', **MERGE})
    as_user("md").post(f"{API}/notes/{note['id']}/sign", headers={"If-Match": '"2"'})
    closed = as_user("md").post(path)
    assert closed.status_code == 200, closed.text
    assert world.encounters[encounter].status == "finished"
    assert ("encounter.closed", f"encounter/{encounter}") in notes.published
    again = as_user("md").post(path)
    assert again.status_code == 409 and again.json()["currentState"] == "finished"
