"""The bridge to core's partner registries (partner_bridge.py, #186), without a database: the 270
builder's failures become permanent DeliveryErrors with their short code, the 271 handler takes
the operation from our own outbox payload and names the patient, a reply that names another ID
of our request is unknown, and a dead-lettered 270 times the check out. The service is replaced;
its own tests cover what it writes. Synthetic IDs only."""

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

CHECK = UUID("00000000-0000-4000-8000-0000000c4ec4")
OPERATION = UUID("00000000-0000-4000-8000-00000000090e")
PATIENT = UUID("00000000-0000-4000-8000-0000000a71e0")
DB = cast(AsyncSession, object())  # never used: the service is replaced


class _Request:
    def as_json(self) -> dict[str, Any]:
        return {"messageType": "270", "correlationId": str(CHECK)}


@pytest.fixture
def built(monkeypatch: pytest.MonkeyPatch) -> list[UUID]:
    seen: list[UUID] = []

    async def build_request(db: AsyncSession, check_id: UUID, **_: Any) -> _Request:
        seen.append(check_id)
        return _Request()

    monkeypatch.setattr(service, "build_request", build_request)
    return seen


@pytest.fixture
def recorded(monkeypatch: pytest.MonkeyPatch) -> list[tuple[dict[str, Any], UUID | None]]:
    seen: list[tuple[dict[str, Any], UUID | None]] = []

    async def record_response(db: AsyncSession, payload: dict[str, Any], *,
                              operation_id: UUID | None = None) -> service.Filed:
        seen.append((payload, operation_id))
        if payload.get("result") == "lost":
            raise ValidationFailed()
        return service.Filed(UUID(payload["correlationId"]), "active", duplicate=False)

    async def patient_of(db: AsyncSession, check_id: UUID) -> UUID | None:
        return PATIENT if check_id == CHECK else None

    monkeypatch.setattr(service, "record_response", record_response)
    monkeypatch.setattr(repository, "patient_of", patient_of)
    return seen


def _reply(correlation: UUID | str = CHECK, **extra: Any) -> dict[str, Any]:
    return {"messageType": "271", "correlationId": str(correlation), "result": "active", **extra}


# ------------------------------------------------------------------------------ the 270
@pytest.mark.parametrize("operation", [OPERATION, None])  # a manual check, an automatic one
async def test_the_270_is_built_from_the_check_the_outbox_names(
        built: list[UUID], operation: UUID | None) -> None:
    assert await bridge.build_270(DB, outbox_payload(CHECK, operation)) == _Request().as_json()
    assert built == [CHECK]


@pytest.mark.parametrize("code", ["check-not-found", "check-not-pending", "member-id-missing",
                                  "birth-date-missing"])
async def test_a_270_that_cant_be_built_is_dead_lettered_with_its_code(
        monkeypatch: pytest.MonkeyPatch, code: str) -> None:
    async def build_request(db: AsyncSession, check_id: UUID, **_: Any) -> Any:
        raise service.RequestNotBuildable(code)

    monkeypatch.setattr(service, "build_request", build_request)
    with pytest.raises(DeliveryError) as refused:
        await bridge.build_270(DB, outbox_payload(CHECK, None))
    assert (refused.value.code, refused.value.permanent) == (code, True)


@pytest.mark.parametrize("payload", [{}, {"eligibilityCheckId": "not-a-uuid"},
                                     {"eligibilityCheckId": None}, {"prescriptionId": str(CHECK)},
                                     {"eligibilityCheckId": str(CHECK), "operationId": "x"}])
async def test_a_payload_without_a_check_is_dead_lettered_unread(
        built: list[UUID], payload: dict[str, Any]) -> None:
    with pytest.raises(DeliveryError) as refused:
        await bridge.build_270(DB, payload)
    assert (refused.value.code, refused.value.permanent) == ("invalid-payload", True)
    assert built == []


async def test_any_other_failure_is_left_to_the_worker_to_retry(
        monkeypatch: pytest.MonkeyPatch) -> None:
    async def build_request(db: AsyncSession, check_id: UUID, **_: Any) -> Any:
        raise ConnectionError("the database went away")

    monkeypatch.setattr(service, "build_request", build_request)
    with pytest.raises(ConnectionError):  # the worker records internal-error and retries
        await bridge.build_270(DB, outbox_payload(CHECK, None))


# ------------------------------------------------------------------------------ the 271
@pytest.mark.parametrize("operation", [OPERATION, None])
async def test_the_271_is_filed_with_the_operation_of_our_request_and_names_the_patient(
        recorded: list[tuple[dict[str, Any], UUID | None]], operation: UUID | None) -> None:
    message = _reply()
    answered = await bridge.file_271(DB, message, outbox_payload(CHECK, operation))
    assert answered == bridge.Answered(CHECK, "active", False, PATIENT)
    assert recorded == [(message, operation)]


async def test_an_upper_case_correlation_id_is_the_same_check(
        recorded: list[tuple[dict[str, Any], UUID | None]]) -> None:
    answered = await bridge.file_271(DB, _reply(str(CHECK).upper()),
                                     outbox_payload(CHECK, None))
    assert answered.check_id == CHECK


@pytest.mark.parametrize(("correlation", "request_payload"), [
    (OPERATION, outbox_payload(CHECK, OPERATION)),  # core matched our operation's ID, not a check
    (CHECK, {"operationId": str(OPERATION)}),  # our request names no check
    (CHECK, {"eligibilityCheckId": "not-a-uuid"}),
])
async def test_a_271_that_names_no_check_of_our_request_is_unknown(
        recorded: list[tuple[dict[str, Any], UUID | None]], correlation: UUID,
        request_payload: dict[str, Any]) -> None:
    with pytest.raises(NotFound):  # core files it as failed / unknown-correlation
        await bridge.file_271(DB, _reply(correlation), request_payload)
    assert recorded == []


async def test_the_services_refusals_reach_core_unchanged(
        recorded: list[tuple[dict[str, Any], UUID | None]]) -> None:
    with pytest.raises(ValidationFailed):  # core files it as failed / invalid-message
        await bridge.file_271(DB, _reply(result="lost"), outbox_payload(CHECK, None))


# ------------------------------------------------------------------------- dead-letter
async def test_a_dead_lettered_270_times_out_the_check_and_fails_its_operation(
        monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[UUID, UUID | None]] = []

    async def mark_timed_out(db: AsyncSession, check_id: UUID, *,
                             operation_id: UUID | None = None) -> bool:
        seen.append((check_id, operation_id))
        return True

    monkeypatch.setattr(service, "mark_timed_out", mark_timed_out)
    assert await bridge.dead_letter_270(DB, outbox_payload(CHECK, OPERATION), "http-503") is True
    assert await bridge.dead_letter_270(DB, outbox_payload(CHECK, None), "member-id-missing")
    assert await bridge.dead_letter_270(DB, {}, "invalid-payload") is False
    assert seen == [(CHECK, OPERATION), (CHECK, None)]


# ------------------------------------------------------------------------- registration
def test_registration_follows_cores_registries() -> None:
    """Registered exactly where core has the registries (#186); never on its own."""
    has_core = importlib.util.find_spec("app.integration.inbound") is not None
    assert bridge.REGISTERED is has_core
    if has_core:
        outbound = importlib.import_module("app.integration.outbound")
        inbound = importlib.import_module("app.integration.inbound")
        assert outbound._BUILDERS[("clearinghouse", "270")] is bridge.build_270
        assert outbound.hook("dead-letter", "clearinghouse", "270") is bridge.dead_letter_270
        assert outbound.hook("sent", "clearinghouse", "270") is None  # the check waits on the 271
        assert inbound._HANDLERS[("clearinghouse", "271")] is bridge.file_271
