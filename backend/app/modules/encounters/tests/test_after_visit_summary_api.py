"""The after-visit summary's hand-off (#86, D98) with the in-memory fakes (fakes.py):
createAfterVisitSummary and getAfterVisitSummaryDownloadUrl, each with a success, a
permission-denied and a validation-error case, plus their rules. Anand's store (#157) and the
file service's link are fakes here; the app's own placeholders answer 503 (last test).
getAfterVisitSummaryDownloadUrl waits for core's T50 permission; the test app grants it as T50
proposes. Synthetic data only."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.deps import DEV_USERS

from .. import api
from ..repository import ReasonIn
from .fakes import DOCTOR, World

Client = Callable[[str], TestClient]
API = "/api/v1"
MD = DEV_USERS["md"].id


def _create(client: TestClient, encounter: Any, **body: Any) -> Any:
    return client.post(f"{API}/encounters/{encounter}/after-visit-summary", json=body or None)


# ------------------------------------------------------------------- createAfterVisitSummary
def test_the_summary_is_made_from_the_signed_note(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="in-progress",
                                    reasons=[ReasonIn(None, None, None, "Headaches.")],
                                    participants=[("rendering", DOCTOR)])
    world.sign_note(encounter, instructions="Drink water &amp; rest.<br/>Call if worse.")
    world.ask_follow_up(encounter, by=MD)
    done = _create(as_user("md"), encounter)
    assert done.status_code == 202, done.text
    operation = done.json()
    assert operation["kind"] == "encounter.after-visit-summary"
    assert operation["status"] == "succeeded"
    stored = world.summaries[encounter][0]
    assert operation["result"] == {"type": "document", "id": str(stored.document_id)}
    assert done.headers["Location"] == f"/api/v1/operations/{operation['id']}"
    details = world.details[0]
    assert details.patient_name == "Kaia401 Lindgren118"
    assert details.time_zone == "America/Chicago"
    assert details.reason_for_visit == "Headaches."
    assert details.instructions == "Drink water & rest.\nCall if worse."
    assert details.follow_up is not None and "3 months" in details.follow_up
    assert details.follow_up.endswith("around February 3, 2027. The front desk will help you "
                                      "book it.")
    assert details.medications == () and details.orders == ()  # Thulasi's, not built yet
    assert world.audited == [world.encounters[encounter].patient_id]
    again = _create(as_user("app"), encounter)  # generating again makes a new version
    assert again.status_code == 202 and len(world.summaries[encounter]) == 2


def test_create_summary_refusals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="in-progress")
    for role in ("fd", "ma", "rn", "bil", "none"):  # MD and APP only
        assert _create(as_user(role), encounter).status_code == 403, role
    assert _create(as_user("md-b"), encounter).status_code == 404
    unsigned = _create(as_user("md"), encounter)
    assert unsigned.status_code == 422 and unsigned.json()["code"] == "business-rule-violation"
    assert unsigned.json()["errors"] == [{"in": "body", "pointer": "/noteId", "code": "required"}]
    world.sign_note(encounter)
    other = _create(as_user("md"), encounter, noteId=str(DOCTOR))  # not a signed note here
    assert other.status_code == 422
    assert other.json()["errors"][0]["code"] == "invalid-reference"
    assert _create(as_user("md"), encounter, noteId="nope").status_code == 422
    assert _create(as_user("md"), encounter, extra=True).status_code == 422
    world.restricted.add(world.encounters[encounter].patient_id)
    restricted = _create(as_user("md"), encounter)
    assert restricted.status_code == 403 and restricted.json()["code"] == "break-glass-required"
    wrong = world.add_encounter(status="entered-in-error")
    world.sign_note(wrong)
    gone = _create(as_user("md"), wrong)
    assert gone.status_code == 409 and gone.json()["currentState"] == "entered-in-error"
    assert world.summaries == {}


def test_the_note_asked_for_is_used(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="finished")
    first = world.sign_note(encounter, instructions="First.")
    world.sign_note(encounter, instructions="Second.")
    assert _create(as_user("md"), encounter, noteId=str(first)).status_code == 202
    assert _create(as_user("md"), encounter).status_code == 202  # the latest signed note
    assert [d.instructions for d in world.details] == ["First.", "Second."]


# ----------------------------------------------------------- getAfterVisitSummaryDownloadUrl
def test_the_front_desk_gets_the_latest_summary(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="finished")
    path = f"{API}/encounters/{encounter}/after-visit-summary/download-url"
    assert as_user("fd").get(path).status_code == 404  # none generated yet
    world.sign_note(encounter)
    _create(as_user("md"), encounter)
    _create(as_user("md"), encounter)
    latest = world.summaries[encounter][-1]
    found = as_user("fd").get(path)
    assert found.status_code == 200, found.text
    assert found.json()["documentId"] == str(latest.document_id)
    assert found.json()["url"].endswith(str(latest.file_id))
    assert set(found.json()) == {"documentId", "generatedAt", "url", "expiresAt"}
    assert world.audited[-1] == world.encounters[encounter].patient_id  # a chart read


def test_download_url_refusals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="finished")
    world.sign_note(encounter)
    _create(as_user("md"), encounter)
    path = f"{API}/encounters/{encounter}/after-visit-summary/download-url"
    for role in ("bil", "dsp", "none"):
        assert as_user(role).get(path).status_code == 403, role
    for role in ("fd", "ma", "rn", "md", "app", "adm"):
        assert as_user(role).get(path).status_code == 200, role
    assert as_user("md-b").get(path).status_code == 404
    bad = as_user("fd").get(f"{API}/encounters/nope/after-visit-summary/download-url")
    assert bad.status_code == 422 and bad.json()["code"] == "validation-failed"
    world.restricted.add(world.encounters[encounter].patient_id)
    restricted = as_user("fd").get(path)
    assert restricted.status_code == 403 and restricted.json()["code"] == "break-glass-required"


def test_until_the_documents_service_is_wired_it_is_503(fake_app: FastAPI,
                                                      as_user: Client, world: World) -> None:
    """The app's own placeholders (after_visit_summary.py), not the fakes."""
    fake_app.dependency_overrides.pop(api.summary_store)
    fake_app.dependency_overrides.pop(api.summary_links)
    encounter = world.add_encounter(status="finished")
    world.sign_note(encounter)
    created = _create(as_user("md"), encounter)
    assert created.status_code == 503 and created.json()["code"] == "service-unavailable"
    link = as_user("fd").get(f"{API}/encounters/{encounter}/after-visit-summary/download-url")
    assert link.status_code == 503
    assert world.audited == [] and world.operations[-1].status == "queued"  # never finished
