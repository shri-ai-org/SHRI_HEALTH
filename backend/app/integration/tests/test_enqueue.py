"""enqueue()'s rules that need no database (the database side is in test_enqueue_postgres.py)."""

from typing import Any
from uuid import uuid4

import pytest

from app.core.db import TENANT_ID_INFO_KEY
from app.integration.api import PARTNERS, check_payload, enqueue

RX = str(uuid4())


def test_the_partners_are_d25s() -> None:
    assert PARTNERS == {"lab", "erx", "clearinghouse", "fax", "notification"}


@pytest.mark.parametrize("payload", [
    {"prescriptionId": RX},
    {"eligibilityCheckId": RX, "serviceTypeCode": "30", "retry": False, "count": 2},
    {"orderIds": [RX, str(uuid4())]},
    {},
])
def test_ids_codes_counts_and_flags_pass(payload: dict[str, Any]) -> None:
    assert check_payload(payload) == payload


@pytest.mark.parametrize(("payload", "message"), [
    ({"patientName": "x" * 121}, "only IDs"),
    ({"sig": {"text": "Take one tablet"}}, "only IDs"),
    ({"dose": 1.5}, "only IDs"),
    ({"count": -1}, "only IDs"),
    ({"ids": [RX, 3]}, "IDs only"),
    ({"ids": [RX] * 101}, "IDs only"),
    ({"Patient Name": RX}, "camelCase"),
    ({f"id{n}": "x" * 120 for n in range(80)}, "over 8192 bytes"),
])
def test_anything_else_is_refused(payload: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        check_payload(payload)


class NoDatabase:
    """Fails the test if enqueue() reaches the database before its checks."""

    info = {TENANT_ID_INFO_KEY: uuid4()}

    async def execute(self, *_: Any, **__: Any) -> None:
        raise AssertionError("checked arguments must be refused before any query")


@pytest.mark.parametrize(("args", "message"), [
    (("payment", "Charge", {}, "k1"), "D25"),  # the card processor isn't an outbox partner
    (("fhir-partner", "Bundle", {}, "k1"), "D25"),
    (("erx", "New Rx!", {}, "k1"), "message type"),
    (("erx", "NewRx", {}, "has spaces"), "idempotency_key"),
    (("erx", "NewRx", {}, ""), "idempotency_key"),
    (("erx", "NewRx", {}, "k1", "x" * 101), "ordering_key"),
    (("erx", "NewRx", {"note": {"free": "text"}}, "k1"), "only IDs"),
])
async def test_bad_arguments_are_refused_before_the_database(args: tuple[Any, ...],
                                                             message: str) -> None:
    with pytest.raises(ValueError, match=message):
        await enqueue(NoDatabase(), *args)  # type: ignore[arg-type]


async def test_enqueue_needs_a_clinic_session() -> None:
    class NoClinic(NoDatabase):
        info: dict[str, Any] = {}

    with pytest.raises(RuntimeError, match="clinic session"):
        await enqueue(NoClinic(), "erx", "NewRx", {"prescriptionId": RX},  # type: ignore[arg-type]
                      "newrx:1")
