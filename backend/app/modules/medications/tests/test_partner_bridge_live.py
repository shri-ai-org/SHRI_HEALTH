"""The bridge's functions against a live database, as shri_app, in a clinic's system session (the
worker's and the callback receiver's, with no user): the NewRx built from what the outbox row
names, ``sent`` once delivered, the recorded synthetic RxStatus filed on the prescription that row
names, and a dead-lettered NewRx shown as ``error``. Core's registries and the whole loop are in
test_partner_loop_live.py (they need #186). Synthetic data only."""

# ruff: noqa: F811 (scheduling's live fixtures are parameters here)
from __future__ import annotations

import uuid
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.eligibility.tests.schema_check import errors
from app.modules.eligibility.tests.test_eligibility_live import _in_clinic
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (fixtures)
    Practice,
    client,
    practice,
    users,
)
from app.modules.scheduling.tests.test_check_in_live import _sql

from .. import partner_bridge as bridge
from .test_medications_live import API, Rx, _draft, _sign, rx  # noqa: F401 (rx: a fixture)
from .test_messages import NEW_RX, example

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]


def _signed(client: Any, practice: Practice, rx: Rx) -> tuple[str, dict[str, Any]]:
    """A signed prescription and its NewRx's outbox payload."""
    draft = _draft(client, practice, rx).json()
    client("md").post(f"{API}/prescriptions/{draft['id']}/safety-check")
    assert _sign(client, draft["id"], '"1"').status_code == 200
    rows = _sql(practice, "SELECT payload FROM admin.integration_message "
                "WHERE payload->>'prescriptionId' = :r", r=draft["id"])
    assert len(rows) == 1
    return draft["id"], rows[0][0]


def _events(practice: Practice, prescription_id: str) -> list[Any]:
    return [e[0]["transmissionStatus"] for e in _sql(
        practice, "SELECT data FROM admin.event_log WHERE subject = :s "
        "AND type = 'prescription.transmission-updated' ORDER BY seq",
        s=f"prescription/{prescription_id}")]


def test_built_sent_then_accepted_through_the_bridge(client: Any, practice: Practice,
                                                     rx: Rx) -> None:
    prescription_id, payload = _signed(client, practice, rx)

    async def build(db: AsyncSession) -> dict[str, Any]:
        return await bridge.build_new_rx(db, payload)

    message = _in_clinic(practice, build)
    assert errors(NEW_RX, message) == [] and message["correlationId"] == prescription_id

    async def sent(db: AsyncSession) -> object:
        return await bridge.sent_new_rx(db, payload, "SIM-RX-0001")

    _in_clinic(practice, sent)
    reply = example("rx-status-accepted.json") | {"correlationId": prescription_id,
                                                  "responseId": f"SIM-{uuid.uuid4().hex[:8]}"}

    async def file(db: AsyncSession) -> bridge.Answered:
        return await bridge.file_rx_status(db, reply, payload)

    answered = _in_clinic(practice, file)
    assert answered == bridge.Answered(UUID(prescription_id), "accepted", False,
                                       practice.patients["kaia"])
    assert _in_clinic(practice, file).duplicate is True  # a repeat changes nothing
    _in_clinic(practice, sent)  # a late "sent" after the answer changes nothing either
    assert _events(practice, prescription_id) == ["queued", "sent", "accepted"]
    shown = client("md").get(f"{API}/prescriptions/{prescription_id}").json()
    assert shown["transmission"]["status"] == "accepted"


def test_a_dead_lettered_new_rx_is_an_error_with_the_fixed_message(
        client: Any, practice: Practice, rx: Rx) -> None:
    prescription_id, payload = _signed(client, practice, rx)

    async def dead(db: AsyncSession) -> object:
        return await bridge.dead_letter_new_rx(db, payload, "http-503")

    _in_clinic(practice, dead)
    shown = client("md").get(f"{API}/prescriptions/{prescription_id}").json()["transmission"]
    assert shown["status"] == "error" and "http-503" not in shown.get("message", "")
    assert _events(practice, prescription_id) == ["queued", "error"]
