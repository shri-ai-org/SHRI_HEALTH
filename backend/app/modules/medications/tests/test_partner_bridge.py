"""The bridge to core's partner registries (partner_bridge.py, #186), without a database: the
NewRx builder's failures become permanent DeliveryErrors with their short code, a delivered NewRx
is recorded ``sent`` and a dead-lettered one ``error``, and the RxStatus handler files only a
reply that names our prescription, naming its patient. The service is replaced; its own tests
cover what it writes. Synthetic IDs only."""

from __future__ import annotations

import importlib
import importlib.util
from typing import Any, cast
from uuid import UUID

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound, ValidationFailed
from app.integration.worker import DeliveryError

from .. import partner_bridge as bridge
from .. import repository, service
from ..partner import outbox_payload

RX = UUID("00000000-0000-4000-8000-00000000e4e0")
PATIENT = UUID("00000000-0000-4000-8000-0000000a71e0")
FACILITY = UUID("00000000-0000-4000-8000-0000000fac11")
DB = cast(AsyncSession, object())  # never used: the service is replaced


class _NewRx:
    def as_json(self) -> dict[str, Any]:
        return {"messageType": "NewRx", "correlationId": str(RX)}


@pytest.fixture
def moved(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, UUID]]:
    """The service's transmission moves, and the RxStatus filing, recorded."""
    seen: list[tuple[str, UUID]] = []

    async def record_sent(db: AsyncSession, prescription_id: UUID) -> service.Filed:
        seen.append(("sent", prescription_id))
        return service.Filed(prescription_id, "sent", duplicate=False)

    async def record_failed(db: AsyncSession, prescription_id: UUID) -> service.Filed:
        seen.append(("error", prescription_id))
        return service.Filed(prescription_id, "error", duplicate=False)

    async def record_status(db: AsyncSession, payload: dict[str, Any]) -> service.Filed:
        if payload.get("status") == "lost":
            raise ValidationFailed()
        seen.append((payload["status"], UUID(payload["correlationId"])))
        return service.Filed(UUID(payload["correlationId"]), payload["status"], duplicate=False)

    async def event_scope(db: AsyncSession, prescription_id: UUID
                          ) -> tuple[UUID | None, UUID | None]:
        return (PATIENT, FACILITY) if prescription_id == RX else (None, None)

    monkeypatch.setattr(service, "record_sent", record_sent)
    monkeypatch.setattr(service, "record_failed", record_failed)
    monkeypatch.setattr(service, "record_status", record_status)
    monkeypatch.setattr(repository, "event_scope", event_scope)
    return seen


def _status(correlation: UUID | str = RX, status: str = "accepted") -> dict[str, Any]:
    return {"messageType": "RxStatus", "correlationId": str(correlation), "status": status}


# ---------------------------------------------------------------------------- the NewRx
async def test_the_new_rx_is_built_from_the_prescription_the_outbox_names(
        monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[UUID] = []

    async def build_new_rx(db: AsyncSession, prescription_id: UUID, **_: Any) -> _NewRx:
        seen.append(prescription_id)
        return _NewRx()

    monkeypatch.setattr(service, "build_new_rx", build_new_rx)
    assert await bridge.build_new_rx(DB, outbox_payload(RX)) == _NewRx().as_json()
    assert seen == [RX]


@pytest.mark.parametrize("code", ["prescription-not-found", "prescription-not-signed",
                                  "pharmacy-missing", "invalid-field"])
async def test_a_new_rx_that_cant_be_built_is_dead_lettered_with_its_code(
        monkeypatch: pytest.MonkeyPatch, code: str) -> None:
    async def build_new_rx(db: AsyncSession, prescription_id: UUID, **_: Any) -> Any:
        raise service.MessageNotBuildable(code)

    monkeypatch.setattr(service, "build_new_rx", build_new_rx)
    with pytest.raises(DeliveryError) as refused:
        await bridge.build_new_rx(DB, outbox_payload(RX))
    assert (refused.value.code, refused.value.permanent) == (code, True)


@pytest.mark.parametrize("payload", [{}, {"prescriptionId": "nope"}, {"prescriptionId": 7},
                                     {"eligibilityCheckId": str(RX)}])
async def test_a_payload_without_a_prescription_is_dead_lettered_unread(
        payload: dict[str, Any]) -> None:
    with pytest.raises(DeliveryError) as refused:
        await bridge.build_new_rx(DB, payload)
    assert (refused.value.code, refused.value.permanent) == ("invalid-payload", True)


# ------------------------------------------------------------------ how the send ended
async def test_a_delivered_new_rx_is_sent_and_a_dead_lettered_one_is_an_error(
        moved: list[tuple[str, UUID]]) -> None:
    await bridge.sent_new_rx(DB, outbox_payload(RX), "SIM-RX-0001")
    await bridge.dead_letter_new_rx(DB, outbox_payload(RX), "http-503")
    assert moved == [("sent", RX), ("error", RX)]


async def test_a_hook_for_a_payload_without_a_prescription_fails_for_the_worker_to_log(
        moved: list[tuple[str, UUID]]) -> None:
    with pytest.raises(ValueError, match="invalid-payload"):  # logged by type, never by text
        await bridge.sent_new_rx(DB, {}, "SIM-RX-0001")
    assert moved == []


# --------------------------------------------------------------------------- RxStatus
@pytest.mark.parametrize("status", ["accepted", "rejected"])
async def test_the_rx_status_is_filed_on_our_prescription_and_names_the_patient(
        moved: list[tuple[str, UUID]], status: str) -> None:
    answered = await bridge.file_rx_status(DB, _status(status=status), outbox_payload(RX))
    assert answered == bridge.Answered(RX, status, False, PATIENT)
    assert moved == [(status, RX)]


@pytest.mark.parametrize(("correlation", "request_payload"), [
    (UUID("00000000-0000-4000-8000-000000000001"), outbox_payload(RX)),  # not our prescription
    (RX, {"eligibilityCheckId": str(RX)}),  # our request names no prescription
])
async def test_an_rx_status_that_names_no_prescription_of_our_request_is_unknown(
        moved: list[tuple[str, UUID]], correlation: UUID,
        request_payload: dict[str, Any]) -> None:
    with pytest.raises(NotFound):  # core files it as failed / unknown-correlation
        await bridge.file_rx_status(DB, _status(correlation), request_payload)
    assert moved == []


async def test_the_services_refusals_reach_core_unchanged(
        moved: list[tuple[str, UUID]]) -> None:
    with pytest.raises(ValidationFailed):  # core files it as failed / invalid-message
        await bridge.file_rx_status(DB, _status(status="lost"), outbox_payload(RX))


# ------------------------------------------------------------------------- registration
def test_registration_follows_cores_registries() -> None:
    """Registered exactly where core has the registries (#186); never on its own."""
    has_core = importlib.util.find_spec("app.integration.inbound") is not None
    assert bridge.REGISTERED is has_core
    if has_core:
        outbound = importlib.import_module("app.integration.outbound")
        inbound = importlib.import_module("app.integration.inbound")
        assert outbound._BUILDERS[("erx", "NewRx")] is bridge.build_new_rx
        assert outbound.hook("sent", "erx", "NewRx") is bridge.sent_new_rx
        assert outbound.hook("dead-letter", "erx", "NewRx") is bridge.dead_letter_new_rx
        assert inbound._HANDLERS[("erx", "RxStatus")] is bridge.file_rx_status
