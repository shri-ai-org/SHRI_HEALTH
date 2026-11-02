"""The simulated payer and pharmacy (integration/simulated.py): their fixed answers, and that a
send builds through the module's builder and posts a reply our receivers accept. No database;
synthetic data only (the names follow the seed's digits rule)."""

import json
import secrets
from typing import Any
from uuid import uuid4

import httpx
import pytest
from pydantic import SecretStr
from starlette.datastructures import Headers

from app.core.config import Settings
from app.core.partner_hooks import verify
from app.integration import outbound
from app.integration.inbound import PartnerMessage
from app.integration.simulated import (
    SimulatedPartner,
    payer_answer,
    pharmacy_answer,
    simulated_adapters,
)
from app.integration.worker import DeliveryError, OutboundMessage

CORRELATION = str(uuid4())


def _270(member: str) -> dict[str, Any]:
    return {"messageType": "270", "schemaVersion": "1.0", "correlationId": CORRELATION,
            "serviceDate": "2026-11-20",
            "subscriber": {"memberId": member, "groupNumber": "TEST-G778",
                           "name": {"family": "Lindgren118", "given": ["Kaia401"]}}}


def _new_rx(description: str) -> dict[str, Any]:
    return {"messageType": "NewRx", "schemaVersion": "1.0", "correlationId": CORRELATION,
            "medication": {"description": description}}


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test", "simulated_partners": True,
        "simulated_partner_callback_url": "http://api.test",
        "hook_secret_clearinghouse": SecretStr(secrets.token_hex(32)),
        "hook_secret_erx": SecretStr(secrets.token_hex(32))}
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def _amounts(reply: dict[str, Any]) -> dict[tuple[str, str], str]:
    return {(b["benefitType"], b.get("timePeriod", "")): b["amount"]["value"]
            for b in reply.get("benefits", []) if "amount" in b}


def test_the_payer_answers_active_with_the_demo_copay() -> None:
    reply = payer_answer(_270("TEST-M0012345"))
    PartnerMessage.model_validate(reply)
    assert (reply["messageType"], reply["correlationId"], reply["result"]) == (
        "271", CORRELATION, "active")
    assert _amounts(reply) == {("copay", "visit"): "25.00",
                               ("deductible", "calendar-year"): "1500.00",
                               ("deductible", "remaining"): "640.00",
                               ("out-of-pocket", "calendar-year"): "5000.00"}
    assert reply["plan"]["groupNumber"] == "TEST-G778"


@pytest.mark.parametrize(("member", "result", "code"), [
    ("TEST-INACTIVE-01", "inactive", None),
    ("TEST-NOTFOUND-01", "member-not-found", "75"),
    ("TEST-ERROR-01", "error", "42"),
])
def test_the_payer_answers_the_other_cases_by_member_id(member: str, result: str,
                                                       code: str | None) -> None:
    reply = payer_answer(_270(member))
    PartnerMessage.model_validate(reply)
    assert reply["result"] == result
    assert "benefits" not in reply
    assert [e["code"] for e in reply.get("errors", [])] == ([code] if code else [])


def test_the_pharmacy_accepts_or_rejects() -> None:
    accepted = pharmacy_answer(_new_rx("amoxicillin 500 MG Oral Capsule"))
    rejected = pharmacy_answer(_new_rx("REJECT test drug 10 MG Oral Tablet"))
    for reply in (accepted, rejected):
        PartnerMessage.model_validate(reply)
    assert (accepted["status"], rejected["status"]) == ("accepted", "rejected")
    assert rejected["rejection"]["code"] == "900"
    assert "rejection" not in accepted


def test_adapters_exist_only_when_enabled() -> None:
    assert simulated_adapters(Settings(environment="test")) == {}
    assert set(simulated_adapters(_settings())) == {"simulated-clearinghouse", "simulated-erx"}


def _message(message_type: str) -> OutboundMessage:
    return OutboundMessage(id=uuid4(), tenant_id=uuid4(), endpoint_id=uuid4(),
                           adapter="simulated-clearinghouse", message_type=message_type,
                           payload={"eligibilityCheckId": CORRELATION}, idempotency_key=None,
                           ordering_key=None, attempts=1, max_attempts=8, correlation_id=None)


async def test_a_send_builds_through_the_module_and_posts_a_signed_reply(
        monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings()
    posted: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        posted.append(request)
        return httpx.Response(200)

    async def build_270(db: Any, payload: dict[str, Any]) -> dict[str, Any]:
        assert payload == {"eligibilityCheckId": CORRELATION}
        return _270("TEST-M0012345")

    monkeypatch.setitem(outbound._BUILDERS, ("clearinghouse", "270"), build_270)
    partner = SimulatedPartner(settings, "clearinghouse", delay=0,
                               client=httpx.AsyncClient(transport=httpx.MockTransport(answer)))
    message = _message("270")

    delivered = await partner.send(message, session=None)  # type: ignore[arg-type]
    await partner.aclose()

    (request,) = posted
    assert str(request.url) == "http://api.test/hooks/clearinghouse"
    body = request.read()
    reply = json.loads(body)
    assert delivered.control_id == reply["responseId"]
    hook = verify(settings, "clearinghouse", Headers(dict(request.headers)), body)
    assert (hook.clinic_id, hook.message_id) == (message.tenant_id, reply["responseId"])


async def test_a_message_no_module_builds_is_a_permanent_failure() -> None:
    partner = SimulatedPartner(_settings(), "erx", delay=0)
    with pytest.raises(DeliveryError) as refused:
        await partner.send(_message("NoSuchType"), session=None)  # type: ignore[arg-type]
    assert (refused.value.code, refused.value.permanent) == ("no-builder", True)
    await partner.aclose()
