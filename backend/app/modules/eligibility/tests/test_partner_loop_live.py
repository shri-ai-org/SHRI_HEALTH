"""The whole eligibility loop on a live database, with core's partner callbacks (#186): a check run
through the API queues its 270; the outbox worker (shri_integration) builds it through the bridge
and sends it to the simulated payer, whose signed 271 comes back to /hooks/clearinghouse (shri_app)
and is filed on the check with its copay and deductible, finishing the operation. A replayed or
resent reply changes nothing, an unknown correlation is refused, and a 270 that can't be built is
dead-lettered and times the check out. Skipped where #186 isn't present, and until shri_integration
has its grants (D23, Anand). Synthetic data only."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI

from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (fixtures)
    Practice,
    client,
    practice,
    users,
)
from app.modules.scheduling.tests.test_check_in_live import _sql

from . import partner_loop as loop
from .test_eligibility_live import API, _insured, _run, _today_appointment

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
#: What the 270 builder reads (eligibility/repository.py _REQUEST, _SERVICE_TYPES, _PATIENT).
READS = ("admin.eligibility_check", "admin.eligibility_service_type", "clinical.coverage",
         "clinical.patient", "clinical.human_name", "admin.payer", "clinical.identifier")


@pytest.fixture
async def hooks() -> AsyncIterator[FastAPI]:
    async for app in loop.hook_app():
        yield app


def _started(client: Any, practice: Practice) -> tuple[str, str, UUID, UUID]:  # noqa: F811
    """A manual check at today's appointment, through the API: (operation, check, outbox
    message, coverage)."""
    loop.require_worker_grants(*READS)
    coverage = _insured(practice)
    loop.endpoint(practice.clinic, "clearinghouse", "simulated-clearinghouse")
    started = _run(client, coverage, _today_appointment(practice))
    assert started.status_code == 202, started.text
    operation = started.json()["id"]
    (row,) = _sql(practice, "SELECT id, payload FROM admin.integration_message "
                  "WHERE payload->>'operationId' = :o", o=operation)
    return operation, row.payload["eligibilityCheckId"], row.id, coverage


def _completed_events(practice: Practice, check_id: str) -> int:  # noqa: F811
    found: int = _sql(practice, "SELECT count(*) FROM admin.event_log WHERE "
                      "type = 'eligibility.completed' AND subject = :s",
                      s=f"eligibility-check/{check_id}")[0][0]
    return found


async def test_a_check_goes_to_the_payer_and_comes_back_with_copay_and_deductible(
        client: Any, practice: Practice, hooks: FastAPI) -> None:  # noqa: F811
    operation, check_id, message_id, _ = _started(client, practice)

    posted = await loop.deliver(hooks, "clearinghouse", "simulated-clearinghouse", message_id)

    sent = loop.outbound(message_id)
    assert (sent.status, sent.last_error) == ("sent", None), sent
    assert sent.control_id.startswith("SIM-271-")
    assert len(posted) == 1
    body = client("fd").get(f"{API}/eligibility-checks/{check_id}").json()
    assert (body["status"], body["coverageStatus"], body["planName"]) == (
        "complete", "active", "Simulated PPO (synthetic)")
    assert body["copay"] == {"value": "25.00", "currency": "USD"}
    assert body["deductible"] == {"value": "1500.00", "currency": "USD"}
    assert body["deductibleRemainingAmount"] == {"value": "640.00", "currency": "USD"}
    done = client("fd").get(f"{API}/operations/{operation}").json()
    assert (done["status"], done["result"]) == ("succeeded", {"type": "eligibility-check",
                                                              "id": check_id})
    assert loop.inbound(practice.clinic) == [("processed", None)]
    assert loop.partner_audit(practice.clinic) == [("success", practice.patients["kaia"], None)]
    assert _completed_events(practice, check_id) == 1

    # The same callback replayed (same webhook-id): accepted and ignored, not even recorded.
    (reply,) = posted
    assert await loop.post(hooks, "clearinghouse", practice.clinic, reply.body,
                           headers=reply.headers) == 200
    # The partner sending it again under a new webhook-id: filed, but changes nothing.
    assert await loop.post(hooks, "clearinghouse", practice.clinic, reply.body,
                           "SIM-271-RESENT") == 200
    assert loop.inbound(practice.clinic) == [("processed", None)] * 2
    assert client("fd").get(f"{API}/eligibility-checks/{check_id}").json() == body
    assert client("fd").get(f"{API}/operations/{operation}").json() == done
    assert _completed_events(practice, check_id) == 1

    # A reply to nothing we asked, and one naming our operation instead of the check.
    answer = json.loads(reply.body)
    for n, correlation in enumerate((str(uuid4()), operation)):
        stray = json.dumps(answer | {"correlationId": correlation,
                                     "responseId": f"SIM-271-STRAY{n}"}).encode()
        assert await loop.post(hooks, "clearinghouse", practice.clinic, stray,
                               f"SIM-271-STRAY{n}") == 200
    assert loop.inbound(practice.clinic)[2:] == [("failed", "unknown-correlation")] * 2
    assert [a[0] for a in loop.partner_audit(practice.clinic)] == [
        "success", "success", "failure", "failure"]
    assert client("fd").get(f"{API}/eligibility-checks/{check_id}").json() == body


async def test_a_270_that_cant_be_built_is_dead_lettered_and_times_the_check_out(
        client: Any, practice: Practice, hooks: FastAPI) -> None:  # noqa: F811
    operation, check_id, message_id, coverage = _started(client, practice)
    _sql(practice, "UPDATE clinical.identifier SET type_code = 'SN' "  # no member ID any more
         "WHERE coverage_id = :c AND type_code = 'MB'", c=coverage)

    posted = await loop.deliver(hooks, "clearinghouse", "simulated-clearinghouse", message_id)

    dead = loop.outbound(message_id)
    assert (dead.status, dead.last_error, dead.attempts) == ("dead-letter", "member-id-missing",
                                                             1)
    assert posted == []
    body = client("fd").get(f"{API}/eligibility-checks/{check_id}").json()
    assert (body["status"], body["errorCode"]) == ("error", "timeout")
    failed = client("fd").get(f"{API}/operations/{operation}").json()
    assert (failed["status"], failed["error"]["code"]) == ("failed", "upstream-timeout")
