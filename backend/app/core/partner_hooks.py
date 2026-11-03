"""Partner callback signatures (API_STANDARDS §16.1; contract operations receiveClearinghouseMessage
and receivePharmacyMessage): Standard Webhooks v1, with the clinic covered by the signature.

    signed content  = webhook-id "." webhook-timestamp "." Shri-Clinic-Id "." raw body
    webhook-signature = "v1," base64(HMAC-SHA256(partner secret, signed content)), space-separated

`verify()` runs before the body is parsed or anything is read from the database: the timestamp
within 5 minutes of our clock, then a constant-time comparison with each signature offered. Every
failure is the same 401 with no detail, so a caller learns nothing about which check failed.
The receiving routes (app/integration/inbound.py) take the clinic only from the verified header.
"""

import base64
import hashlib
import hmac
import re
import time
from dataclasses import dataclass
from uuid import UUID

from starlette.datastructures import Headers

from app.core.config import Settings
from app.core.errors import ServiceUnavailable, Unauthorized

TOLERANCE_SECONDS = 300
MAX_BODY_BYTES = 64 * 1024
CLINIC_HEADER = "Shri-Clinic-Id"
SECRETS = {"clearinghouse": "hook_secret_clearinghouse", "erx": "hook_secret_erx"}

_MESSAGE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,60}$")
_TIMESTAMP = re.compile(r"^[0-9]{1,12}$")


@dataclass(frozen=True)
class VerifiedHook:
    partner: str
    message_id: str
    clinic_id: UUID


def _secret(settings: Settings, partner: str) -> bytes:
    value = getattr(settings, SECRETS[partner])
    if value is None:
        raise ServiceUnavailable("This partner's callbacks are not configured")
    return str(value.get_secret_value()).encode()


def signature(secret: bytes, message_id: str, timestamp: str, clinic_id: str, body: bytes) -> str:
    """One `v1,` signature, as the partner (or the simulated partner) sends it."""
    content = f"{message_id}.{timestamp}.{clinic_id}.".encode() + body
    return "v1," + base64.b64encode(hmac.new(secret, content, hashlib.sha256).digest()).decode()


def sign(settings: Settings, partner: str, message_id: str, clinic_id: UUID,
         body: bytes, now: float | None = None) -> dict[str, str]:
    """The headers for a signed callback (the simulated partners use this)."""
    timestamp = str(int(time.time() if now is None else now))
    return {"webhook-id": message_id, "webhook-timestamp": timestamp,
            "webhook-signature": signature(_secret(settings, partner), message_id, timestamp,
                                           str(clinic_id), body),
            CLINIC_HEADER: str(clinic_id), "content-type": "application/json"}


def verify(settings: Settings, partner: str, headers: Headers, body: bytes,
           now: float | None = None) -> VerifiedHook:
    secret = _secret(settings, partner)
    message_id = headers.get("webhook-id", "")
    timestamp = headers.get("webhook-timestamp", "")
    offered = headers.get("webhook-signature", "")
    clinic = headers.get(CLINIC_HEADER, "")
    refused = Unauthorized()
    if not _MESSAGE_ID.fullmatch(message_id) or not _TIMESTAMP.fullmatch(timestamp):
        raise refused
    if abs((time.time() if now is None else now) - int(timestamp)) > TOLERANCE_SECONDS:
        raise refused
    try:
        clinic_id = UUID(clinic)
    except ValueError:
        raise refused from None
    expected = signature(secret, message_id, timestamp, str(clinic_id), body)
    candidates = offered.split(" ")[:10]
    if not any(hmac.compare_digest(expected.encode(), c.encode()) for c in candidates if c):
        raise refused
    return VerifiedHook(partner, message_id, clinic_id)
