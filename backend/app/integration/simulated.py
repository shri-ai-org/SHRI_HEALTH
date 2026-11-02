"""The simulated payer and pharmacy for the demo (D95, D99): outbox adapters that answer the
message themselves and post the signed reply back to our own partner callbacks.

Enabled only with SIMULATED_PARTNERS=true, which settings refuse in production. An endpoint uses
them by its adapter key (admin.integration_endpoint.adapter): `simulated-clearinghouse` or
`simulated-erx`. Sending is the same as for a real partner: the module's builder makes the
request from the IDs in the outbox row (outbound.py), then the reply goes to
{SIMULATED_PARTNER_CALLBACK_URL}/hooks/<partner>, signed with that partner's hook secret, after a
short delay so the send commits first, as a real partner's answer arrives later.

The answers are fixed rules on synthetic data, never on anything real:
- **Payer (271):** a member ID containing `NOTFOUND` is not found, `INACTIVE` is inactive and
  `ERROR` can't be answered; any other is active with a $25.00 in-network office copay, a
  $1,500.00 deductible with $640.00 left, 20% coinsurance and a $5,000.00 out-of-pocket limit.
- **Pharmacy (RxStatus):** a medication whose description contains `REJECT` is rejected (not
  stocked); any other is accepted.
"""

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.partner_hooks import sign
from app.integration.outbound import NoBuilder, build
from app.integration.worker import Delivered, DeliveryError, OutboundMessage

log = logging.getLogger(__name__)

REPLY_DELAY_SECONDS = 1.0
ADAPTERS = {"simulated-clearinghouse": "clearinghouse", "simulated-erx": "erx"}


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _money(value: str) -> dict[str, str]:
    return {"value": value, "currency": "USD"}


def _envelope(message_type: str, request: dict[str, Any], prefix: str) -> dict[str, Any]:
    return {"messageType": message_type, "schemaVersion": "1.0",
            "correlationId": request["correlationId"],
            "responseId": f"{prefix}-{uuid4().hex[:16].upper()}", "respondedAt": _now()}


def payer_answer(request: dict[str, Any]) -> dict[str, Any]:
    """The simulated payer's 271 for a 270."""
    reply = _envelope("271", request, "SIM-271")
    subscriber = request.get("subscriber") or {}
    member = str(subscriber.get("memberId", "")).upper()
    if "NOTFOUND" in member:
        return reply | {"result": "member-not-found",
                        "errors": [{"code": "75", "followUpAction": "C"}]}
    if "ERROR" in member:
        return reply | {"result": "error", "errors": [{"code": "42", "followUpAction": "R"}]}
    service_date = str(request.get("serviceDate", ""))[:4] or str(datetime.now(UTC).year)
    plan = {"name": "Simulated PPO (synthetic)",
            "groupNumber": subscriber.get("groupNumber") or "SIM-G001",
            "coverageStartDate": f"{service_date}-01-01"}
    if "INACTIVE" in member:
        return reply | {"result": "inactive", "plan": plan}
    line = {"coverageLevel": "individual", "network": "in"}
    return reply | {"result": "active", "plan": plan, "benefits": [
        {"benefitType": "active-coverage", "serviceTypeCode": "30", "coverageLevel": "individual"},
        line | {"benefitType": "copay", "serviceTypeCode": "98", "timePeriod": "visit",
                "amount": _money("25.00")},
        line | {"benefitType": "deductible", "serviceTypeCode": "30",
                "timePeriod": "calendar-year", "amount": _money("1500.00")},
        line | {"benefitType": "deductible", "serviceTypeCode": "30", "timePeriod": "remaining",
                "amount": _money("640.00")},
        line | {"benefitType": "coinsurance", "serviceTypeCode": "30", "percent": "20"},
        line | {"benefitType": "out-of-pocket", "serviceTypeCode": "30",
                "timePeriod": "calendar-year", "amount": _money("5000.00")},
    ]}


def pharmacy_answer(request: dict[str, Any]) -> dict[str, Any]:
    """The simulated pharmacy's RxStatus for a NewRx."""
    reply = _envelope("RxStatus", request, "SIM-RX")
    medication = request.get("medication") or {}
    if "REJECT" in str(medication.get("description", "")).upper():
        return reply | {"status": "rejected", "rejection": {
            "code": "900", "descriptionCode": "1000",
            "message": "Drug not stocked at this pharmacy (synthetic)."}}
    return reply | {"status": "accepted"}


ANSWERS = {"clearinghouse": payer_answer, "erx": pharmacy_answer}


class SimulatedPartner:
    """An outbox adapter that is also the partner (see the module docstring)."""

    def __init__(self, settings: Settings, partner: str, *,
                 client: httpx.AsyncClient | None = None,
                 delay: float = REPLY_DELAY_SECONDS) -> None:
        if not settings.simulated_partners or not settings.simulated_partner_callback_url:
            raise RuntimeError("The simulated partners are not enabled")
        self._settings = settings
        self._partner = partner
        self._url = f"{settings.simulated_partner_callback_url.rstrip('/')}/hooks/{partner}"
        self._client = client or httpx.AsyncClient(timeout=10.0)
        self._delay = delay
        self._pending: set[asyncio.Task[None]] = set()

    async def send(self, message: OutboundMessage, session: AsyncSession) -> Delivered:
        try:
            request = await build(session, self._partner, message.message_type,
                                  dict(message.payload))
        except NoBuilder:
            raise DeliveryError("no-builder", permanent=True) from None
        reply = ANSWERS[self._partner](request)
        body = json.dumps(reply, separators=(",", ":")).encode()
        headers = sign(self._settings, self._partner, reply["responseId"], message.tenant_id, body)
        task = asyncio.create_task(self._post(body, headers, message))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)
        return Delivered(control_id=reply["responseId"])

    async def _post(self, body: bytes, headers: dict[str, str], message: OutboundMessage) -> None:
        await asyncio.sleep(self._delay)
        try:
            response = await self._client.post(self._url, content=body, headers=headers)
            if response.status_code != 200:
                log.warning("Simulated %s reply to message %s answered %s", self._partner,
                            message.id, response.status_code)
        except httpx.HTTPError as error:
            log.warning("Simulated %s reply to message %s failed: %s", self._partner,
                        message.id, type(error).__name__)

    async def drain(self) -> None:
        """Waits for the replies still to be posted (tests, shutdown)."""
        if self._pending:
            await asyncio.gather(*self._pending, return_exceptions=True)

    async def aclose(self) -> None:
        await self.drain()
        await self._client.aclose()


def simulated_adapters(settings: Settings) -> dict[str, SimulatedPartner]:
    if not settings.simulated_partners:
        return {}
    return {key: SimulatedPartner(settings, partner) for key, partner in ADAPTERS.items()}
