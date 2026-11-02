"""The whole prescription loop on a live database, with core's partner callbacks (#186): sign-and-
send through the API queues the NewRx; the outbox worker (shri_integration) builds it through the
bridge, sends it to the simulated pharmacy and records it ``sent``; the pharmacy's signed RxStatus
comes back to /hooks/erx (shri_app) and the prescription is ``accepted`` (D97: queued, sent,
accepted). A replayed or resent reply changes nothing and an unknown correlation is refused.
Skipped where #186 isn't present, and until shri_integration has its grants (D23, Anand).
Synthetic data only."""

# ruff: noqa: F811 (scheduling's live fixtures are parameters here)
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI

from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.eligibility.tests import partner_loop as loop
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (fixtures)
    Practice,
    client,
    practice,
    users,
)
from app.modules.scheduling.tests.test_check_in_live import _sql

from .test_medications_live import API, Rx, rx  # noqa: F401 (rx: a fixture)
from .test_partner_bridge_live import _events, _signed

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
#: What the NewRx builder reads (medications/repository.py _NEW_RX).
READS = ("clinical.medication_request", "clinical.dosage", "clinical.patient",
         "clinical.human_name", "clinical.identifier", "admin.pharmacy")


@pytest.fixture
async def hooks() -> AsyncIterator[FastAPI]:
    async for app in loop.hook_app():
        yield app


async def test_a_prescription_goes_to_the_pharmacy_sent_then_accepted(
        client: Any, practice: Practice, rx: Rx, hooks: FastAPI) -> None:
    loop.require_worker_grants(*READS)
    _sql(practice, "UPDATE admin.integration_endpoint SET adapter = 'simulated-erx' "
         "WHERE tenant_id = :t AND kind = 'erx'", t=practice.clinic)
    prescription_id, _ = _signed(client, practice, rx)
    (message_id,) = [r.id for r in _sql(
        practice, "SELECT id FROM admin.integration_message WHERE payload->>'prescriptionId' = :r",
        r=prescription_id)]

    # The reply comes after a short delay, as a real pharmacy's would: the send commits first.
    posted = await loop.deliver(hooks, "erx", "simulated-erx", message_id, delay=0.5)

    sent = loop.outbound(message_id)
    assert (sent.status, sent.last_error) == ("sent", None), sent
    assert len(posted) == 1
    assert _events(practice, prescription_id) == ["queued", "sent", "accepted"]
    shown = client("md").get(f"{API}/prescriptions/{prescription_id}").json()
    assert shown["transmission"]["status"] == "accepted"
    assert loop.inbound(practice.clinic) == [("processed", None)]
    assert loop.partner_audit(practice.clinic) == [("success", practice.patients["kaia"], None)]

    (reply,) = posted
    assert await loop.post(hooks, "erx", practice.clinic, reply.body,
                           headers=reply.headers) == 200  # replayed: ignored
    assert await loop.post(hooks, "erx", practice.clinic, reply.body,
                           "SIM-RX-RESENT") == 200  # resent: filed, changes nothing
    stray = json.dumps(json.loads(reply.body) | {"correlationId": str(uuid4()),
                                                 "responseId": "SIM-RX-STRAY"}).encode()
    assert await loop.post(hooks, "erx", practice.clinic, stray, "SIM-RX-STRAY") == 200
    assert loop.inbound(practice.clinic) == [("processed", None), ("processed", None),
                                             ("failed", "unknown-correlation")]
    assert _events(practice, prescription_id) == ["queued", "sent", "accepted"]
    assert client("md").get(f"{API}/prescriptions/{prescription_id}").json() == shown
