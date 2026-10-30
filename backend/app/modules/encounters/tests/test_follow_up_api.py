"""The follow-up request (D98) with the in-memory fakes (fakes.py): setFollowUpRequest,
withdrawFollowUpRequest and declineFollowUpRequest, each with a success, a permission-denied and
a validation-error case, plus their rules. declineFollowUpRequest waits for core's T50
permission; the test app grants it as T50 proposes (pending_permissions.py). Synthetic data
only."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

from fastapi.testclient import TestClient

from app.core.deps import DEV_USERS

from .. import schemas, service
from .fakes import DOCTOR, VISIT_TYPE, World

Client = Callable[[str], TestClient]
API = "/api/v1"
ASK: dict[str, Any] = {"interval": {"value": 3, "unit": "month"},
                       "appointmentTypeId": str(VISIT_TYPE), "providerId": str(DOCTOR),
                       "note": "Recheck blood pressure."}
MD = DEV_USERS["md"].id


def _errors(response: Any) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = response.json()["errors"]
    return errors


def _tag(version: int) -> dict[str, str]:
    return {"If-Match": f'"{version}"'}


# ------------------------------------------------------------------------ setFollowUpRequest
def test_the_clinician_asks_for_a_follow_up(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="in-progress")
    done = as_user("md").put(f"{API}/encounters/{encounter}/follow-up", json=ASK,
                             headers=_tag(1))
    assert done.status_code == 200, done.text
    body = done.json()
    assert body["interval"] == {"value": 3, "unit": "month"} and body["status"] == "open"
    assert body["requestedBy"] == str(MD) and body["note"] == "Recheck blood pressure."
    assert done.headers["ETag"] == '"2"'  # the encounter's: the request moved it
    assert world.audited == [world.encounters[encounter].patient_id]
    again = as_user("md").put(f"{API}/encounters/{encounter}/follow-up",
                              json={"interval": {"value": 6, "unit": "week"}}, headers=_tag(2))
    assert again.status_code == 200, again.text
    assert again.json()["interval"] == {"value": 6, "unit": "week"}  # replaced while open
    assert "note" not in again.json() and "providerId" not in again.json()
    workspace = as_user("md").get(f"{API}/encounters/{encounter}").json()
    assert workspace["followUp"]["interval"] == {"value": 6, "unit": "week"}


def test_set_follow_up_refusals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="in-progress")
    path = f"{API}/encounters/{encounter}/follow-up"
    assert as_user("fd").put(path, json=ASK, headers=_tag(1)).status_code == 403  # no update
    assert as_user("none").put(path, json=ASK, headers=_tag(1)).status_code == 403
    nurse = as_user("ma").put(path, json=ASK, headers=_tag(1))  # rooming: reasons only (T52)
    assert nurse.status_code == 403 and nurse.json()["code"] == "permission-denied"
    assert as_user("md-b").put(path, json=ASK, headers=_tag(1)).status_code == 404
    assert as_user("md").put(path, json=ASK).status_code == 428
    stale = as_user("md").put(path, json=ASK, headers=_tag(5))
    assert stale.status_code == 412 and stale.headers["ETag"] == '"1"'
    for bad in ({"interval": {"value": 0, "unit": "month"}},
                {"interval": {"value": 3, "unit": "year"}},
                {"interval": {"value": 3, "unit": "month"}, "status": "booked"},
                {"interval": {"value": 3, "unit": "month"}, "note": "x" * 501}, {}):
        refused = as_user("md").put(path, json=bad, headers=_tag(1))
        assert refused.status_code == 422, bad
        assert refused.json()["code"] == "validation-failed", bad
    unknown = as_user("md").put(path, json={**ASK, "appointmentTypeId": str(DOCTOR),
                                            "providerId": str(VISIT_TYPE)}, headers=_tag(1))
    assert unknown.status_code == 422 and unknown.json()["code"] == "business-rule-violation"
    assert {e["pointer"] for e in _errors(unknown)} == {"/appointmentTypeId", "/providerId"}
    world.restricted.add(world.encounters[encounter].patient_id)
    restricted = as_user("md").put(path, json=ASK, headers=_tag(1))
    assert restricted.status_code == 403 and restricted.json()["code"] == "break-glass-required"


def test_a_booked_or_closed_request_no_longer_changes(as_user: Client, world: World) -> None:
    for status in ("booked", "declined", "withdrawn"):
        encounter = world.add_encounter(status="in-progress")
        world.ask_follow_up(encounter, by=MD, status=status,
                            reason=None if status == "booked" else "Will call.")
        refused = as_user("md").put(f"{API}/encounters/{encounter}/follow-up", json=ASK,
                                    headers=_tag(1))
        assert refused.status_code == 409 and refused.json()["currentState"] == status
    for status in ("entered-in-error", "cancelled"):
        encounter = world.add_encounter(status=status)
        refused = as_user("md").put(f"{API}/encounters/{encounter}/follow-up", json=ASK,
                                    headers=_tag(1))
        assert refused.status_code == 409 and refused.json()["currentState"] == status


# -------------------------------------------------------------------- withdrawFollowUpRequest
def test_the_clinician_who_asked_withdraws_it(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="in-progress")
    world.ask_follow_up(encounter, by=MD)
    done = as_user("md").post(f"{API}/encounters/{encounter}/follow-up/withdraw",
                              json={"reason": "Not needed after the results."}, headers=_tag(1))
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "withdrawn"
    assert done.json()["withdrawnReason"] == "Not needed after the results."
    assert "declinedReason" not in done.json() and done.headers["ETag"] == '"2"'
    again = as_user("md").post(f"{API}/encounters/{encounter}/follow-up/withdraw",
                               json={"reason": "Again."}, headers=_tag(2))
    assert again.status_code == 409 and again.json()["currentState"] == "withdrawn"


def test_withdraw_refusals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="in-progress")
    path = f"{API}/encounters/{encounter}/follow-up/withdraw"
    body = {"reason": "Not needed."}
    nothing = as_user("md").post(path, json=body, headers=_tag(1))
    assert nothing.status_code == 404  # no request on this encounter
    world.ask_follow_up(encounter, by=DEV_USERS["app"].id)
    other = as_user("md").post(path, json=body, headers=_tag(1))  # not who asked
    assert other.status_code == 403 and other.json()["code"] == "permission-denied"
    assert as_user("fd").post(path, json=body, headers=_tag(1)).status_code == 403
    assert as_user("none").post(path, json=body, headers=_tag(1)).status_code == 403
    assert as_user("app").post(path, json=body).status_code == 428
    assert as_user("app").post(path, json={}, headers=_tag(1)).status_code == 422
    blank = as_user("app").post(path, json={"reason": "   "}, headers=_tag(1))
    assert blank.status_code == 422 and _errors(blank)[0]["pointer"] == "/reason"
    assert as_user("app").post(path, json=body, headers=_tag(9)).status_code == 412


# --------------------------------------------------------------------- declineFollowUpRequest
def test_the_front_desk_declines_an_open_request(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="in-progress")
    world.ask_follow_up(encounter, by=MD)
    done = as_user("fd").post(f"{API}/encounters/{encounter}/follow-up/decline",
                              json={"reason": "Patient will call to book."}, headers=_tag(1))
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "declined"
    assert done.json()["declinedReason"] == "Patient will call to book."
    assert world.audited == [world.encounters[encounter].patient_id]
    by_admin = world.add_encounter(status="in-progress")
    world.ask_follow_up(by_admin, by=MD)
    assert as_user("adm").post(f"{API}/encounters/{by_admin}/follow-up/decline",
                               json={"reason": "Moving away."},
                               headers=_tag(1)).status_code == 200


def test_decline_refusals(as_user: Client, world: World) -> None:
    encounter = world.add_encounter(status="in-progress")
    path = f"{API}/encounters/{encounter}/follow-up/decline"
    body = {"reason": "Will call."}
    nothing = as_user("fd").post(path, json=body, headers=_tag(1))
    assert nothing.status_code == 409 and nothing.json()["code"] == "invalid-state-transition"
    world.ask_follow_up(encounter, by=MD)
    for clinician in ("md", "ma", "rn", "app", "none"):  # D67: clinicians never decline
        assert as_user(clinician).post(path, json=body, headers=_tag(1)).status_code == 403
    assert as_user("fd").post(path, json=body).status_code == 428
    assert as_user("fd").post(path, json={"reason": ""}, headers=_tag(1)).status_code == 422
    assert as_user("fd").post(path, json={**body, "x": 1}, headers=_tag(1)).status_code == 422
    stale = as_user("fd").post(path, json=body, headers=_tag(3))
    assert stale.status_code == 412 and stale.headers["ETag"] == '"1"'
    world.restricted.add(world.encounters[encounter].patient_id)
    restricted = as_user("fd").post(path, json=body, headers=_tag(1))
    assert restricted.status_code == 403 and restricted.json()["code"] == "break-glass-required"
    booked = world.add_encounter(status="in-progress")
    world.ask_follow_up(booked, by=MD, status="booked")
    refused = as_user("fd").post(f"{API}/encounters/{booked}/follow-up/decline", json=body,
                                 headers=_tag(1))
    assert refused.status_code == 409 and refused.json()["currentState"] == "booked"


# ----------------------------------------------------------------------- the interval (D40)
def test_the_interval_counts_from_the_visits_day_in_the_facilitys_zone() -> None:
    assert service.due_date(date(2026, 11, 3), 2, "week") == date(2026, 11, 17)
    assert service.due_date(date(2026, 11, 3), 10, "day") == date(2026, 11, 13)
    assert service.due_date(date(2026, 11, 3), 3, "month") == date(2027, 2, 3)
    assert service.due_date(date(2027, 1, 31), 1, "month") == date(2027, 2, 28)
    assert service.due_date(date(2028, 1, 31), 1, "month") == date(2028, 2, 29)
    # 03:30 UTC on 4 November is still 3 November in Chicago: the visit's day there counts.
    late = datetime(2026, 11, 4, 3, 30, tzinfo=UTC)
    asked = schemas.FollowUpRequest(
        interval=schemas.FollowUpInterval(value=1, unit="week"), status="open",
        requested_by=MD, requested_at=late)
    text = service.follow_up_text(asked, late, "America/Chicago", None)
    assert text is not None and "November 10, 2026" in text
    assert "November 11" in (service.follow_up_text(asked, late, "UTC", None) or "")
    booked = asked.model_copy(update={"status": "booked"})
    on = datetime(2027, 2, 2, 15, 0, tzinfo=UTC)
    assert service.follow_up_text(booked, late, "America/Chicago", on) == (
        "Your next visit is booked for February 2, 2027 at 9:00 AM.")
    for closed in ("declined", "withdrawn"):
        assert service.follow_up_text(asked.model_copy(update={"status": closed}), late,
                                      "America/Chicago", None) is None
