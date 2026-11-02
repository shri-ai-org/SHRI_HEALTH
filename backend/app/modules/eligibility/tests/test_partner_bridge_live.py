"""The bridge's functions against a live database, as shri_app, in a clinic's system session (the
worker's and the callback receiver's session, with no user): the 270 built from what the outbox
row names, the recorded synthetic 271 filed with the operation from that row, a late answer filed
after core already ended the operation, and a dead-lettered 270 timing the check out. Core's
registries and the whole loop are in test_partner_loop_live.py (they need #186). Synthetic data
only."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.long_running import finish_operation, problem_body
from app.db.tests.conftest import TEST_DATABASE_URL
from app.integration.worker import DeliveryError
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (fixtures)
    Practice,
    client,
    practice,
    users,
)
from app.modules.scheduling.tests.test_check_in_live import _sql

from .. import partner_bridge as bridge
from .schema_check import errors
from .test_eligibility_live import (
    API,
    _clearinghouse,
    _in_clinic,
    _insured,
    _reply,
    _run,
    _today_appointment,
)
from .test_messages import REQUEST

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
#: Finishing an operation in a system session (no user) needs core's fix in #186 (56bace3:
#: session_user_id() is None there, not UUID("")); the bridge registers exactly when #186 is in.
WITH_186 = pytest.mark.skipif(not bridge.REGISTERED,
                              reason="a system session finishes operations from #186 (56bace3)")


def _outbox(practice: Practice, operation_id: str) -> dict[str, Any]:  # noqa: F811
    """The outbox payload of the operation's 270, as the worker and core's match read it."""
    rows = _sql(practice, "SELECT payload FROM admin.integration_message "
                "WHERE payload->>'operationId' = :o", o=operation_id)
    assert len(rows) == 1
    found: dict[str, Any] = rows[0][0]
    return found


def _started(client: Any, practice: Practice) -> tuple[str, dict[str, Any]]:  # noqa: F811
    coverage = _insured(practice)
    _clearinghouse(practice)
    started = _run(client, coverage, _today_appointment(practice))
    assert started.status_code == 202, started.text
    operation = started.json()["id"]
    return operation, _outbox(practice, operation)


@WITH_186
def test_the_270_is_built_from_the_outbox_row_and_the_271_filed_with_its_operation(
        client: Any, practice: Practice) -> None:  # noqa: F811
    operation, payload = _started(client, practice)
    check_id = payload["eligibilityCheckId"]

    async def build(db: AsyncSession) -> dict[str, Any]:
        return await bridge.build_270(db, payload)

    request = _in_clinic(practice, build)
    assert errors(REQUEST, request) == [] and request["correlationId"] == check_id

    async def file(db: AsyncSession) -> bridge.Answered:
        return await bridge.file_271(db, _reply("response-active-copay.json", UUID(check_id)),
                                     payload)

    answered = _in_clinic(practice, file)
    assert answered == bridge.Answered(UUID(check_id), "active", False,
                                       practice.patients["kaia"])
    body = client("fd").get(f"{API}/eligibility-checks/{check_id}").json()
    assert (body["status"], body["copay"], body["deductible"]) == (
        "complete", {"value": "25.00", "currency": "USD"},
        {"value": "1500.00", "currency": "USD"})
    done = client("fd").get(f"{API}/operations/{operation}").json()
    assert (done["status"], done["result"]) == ("succeeded", {"type": "eligibility-check",
                                                              "id": check_id})
    again = _in_clinic(practice, file)  # the same reply again changes nothing
    assert again.duplicate is True and again.patient_id == practice.patients["kaia"]
    assert client("fd").get(f"{API}/eligibility-checks/{check_id}").json() == body


def test_a_270_whose_check_was_answered_is_dead_lettered_not_resent(
        client: Any, practice: Practice) -> None:  # noqa: F811
    _, payload = _started(client, practice)
    check_id = UUID(payload["eligibilityCheckId"])
    _in_clinic(practice, lambda db: bridge.file_271(  # an automatic check's payload: no operation
        db, _reply("response-inactive.json", check_id), {"eligibilityCheckId": str(check_id)}))

    async def build(db: AsyncSession) -> dict[str, Any]:
        return await bridge.build_270(db, payload)

    with pytest.raises(DeliveryError) as refused:
        _in_clinic(practice, build)
    assert (refused.value.code, refused.value.permanent) == ("check-not-pending", True)


def test_a_late_answer_is_filed_after_core_ended_the_operation(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:  # noqa: F811
    operation, payload = _started(client, practice)
    check_id = UUID(payload["eligibilityCheckId"])

    async def time_limit(db: AsyncSession) -> Any:  # as core does when its creator polls late
        return await finish_operation(db, UUID(operation), "failed", error=problem_body(
            "upstream-timeout", "The work did not finish in time"))

    _in_clinic(practice, time_limit, user=users["fd"])

    async def file(db: AsyncSession) -> bridge.Answered:
        return await bridge.file_271(db, _reply("response-active-copay.json", check_id), payload)

    assert _in_clinic(practice, file).status == "active"  # not undone by core's 409
    body = client("fd").get(f"{API}/eligibility-checks/{check_id}").json()
    assert (body["status"], body["coverageStatus"]) == ("complete", "active")
    assert client("fd").get(f"{API}/operations/{operation}").json()["status"] == "failed"


@pytest.mark.parametrize("operation_ended", [pytest.param(False, marks=WITH_186), True])
def test_a_dead_lettered_270_times_out_the_check_and_its_operation(
        client: Any, practice: Practice, users: dict[str, CurrentUser],  # noqa: F811
        operation_ended: bool) -> None:
    operation, payload = _started(client, practice)
    check_id = payload["eligibilityCheckId"]
    if operation_ended:
        _in_clinic(practice, lambda db: finish_operation(
            db, UUID(operation), "failed",
            error=problem_body("upstream-timeout", "The work did not finish in time")),
            user=users["fd"])

    async def dead(db: AsyncSession) -> bool:
        return await bridge.dead_letter_270(db, payload, "http-503")

    assert _in_clinic(practice, dead) is True
    body = client("fd").get(f"{API}/eligibility-checks/{check_id}").json()
    assert (body["status"], body["errorCode"]) == ("error", "timeout")
    assert "http-503" not in str(body)  # the worker's code is not shown
    failed = client("fd").get(f"{API}/operations/{operation}").json()
    assert (failed["status"], failed["error"]["code"]) == ("failed", "upstream-timeout")
    assert _in_clinic(practice, dead) is False  # only from pending



def test_a_reply_stamped_before_the_request_is_filed_as_answered_when_asked(
        client: Any, practice: Practice) -> None:  # noqa: F811
    """A payer clock behind ours, or whole-second times (the simulated payer's), must not lose
    the 271 to the check's response-after-request constraint."""
    _, payload = _started(client, practice)
    check_id = UUID(payload["eligibilityCheckId"])
    early = _reply("response-active-copay.json", check_id) | {
        "respondedAt": "2026-01-01T00:00:00Z"}

    async def file(db: AsyncSession) -> bridge.Answered:  # an automatic check: no operation
        return await bridge.file_271(db, early, {"eligibilityCheckId": str(check_id)})

    assert _in_clinic(practice, file).status == "active"
    ((requested, responded),) = _sql(practice, "SELECT requested_at, responded_at FROM "
                                     "admin.eligibility_check WHERE id = :c", c=check_id)
    assert responded == requested
