"""Partner callbacks (contract operations receiveClearinghouseMessage, receivePharmacyMessage;
API_STANDARDS §16.1, D25): POST /hooks/clearinghouse and POST /hooks/erx, outside /api/v1.

Each request, in order:
1. **Verify** the signature, timestamp and clinic (core/partner_hooks.py) before anything else.
2. **Check the envelope** (`PartnerMessage` in the contract); the owning module validates the rest.
3. **Record** it in the clinic's session, in its own transaction: an inbound
   `admin.integration_message` keyed by the partner's `webhook-id` (a repeat is accepted and
   ignored, through the table's unique endpoint + direction + control ID), and its audit row
   (`phi-write`, the partner as actor, T37).
4. **Hand it** to the module that registered its message type with `@handles`, in a second
   transaction, and mark it `processed`. A module that refuses it (`Rejected`), a module error or
   no handler at all marks it `failed` or `dead-letter` with a short code, never its content.

The partner always gets the same empty 200 once the message is recorded: nothing about the
outcome leaves. Modules register their handlers when they are imported:

    from app.integration.inbound import Rejected, handles

    @handles("clearinghouse", "271")
    async def file_271(db: AsyncSession, message: dict[str, Any]) -> None:
        ...  # in the clinic's session; raise Rejected("unknown-correlation") to refuse it

**Not yet (follow-up):** the raw body is not stored encrypted before processing (§16.1 asks for
it; it needs the file store's encrypted objects), so processing is in the request.
"""

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, FastAPI, Request, Response
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.config import Settings
from app.core.db import Database
from app.core.errors import AppError, ServiceUnavailable, Unauthorized
from app.core.partner_hooks import MAX_BODY_BYTES, VerifiedHook, verify
from app.core.request_id import current_request_id
from app.core.safe_logging import log_failure

log = logging.getLogger(__name__)

Handler = Callable[[AsyncSession, dict[str, Any]], Awaitable[None]]
MESSAGE_TYPES: dict[str, frozenset[str]] = {
    "clearinghouse": frozenset({"271"}), "erx": frozenset({"RxStatus"}),
}
_HANDLERS: dict[tuple[str, str], Handler] = {}


class MalformedMessage(AppError):
    """Not a partner message we accept: always the same 400, with no detail."""

    default_code = "malformed-request"


class Rejected(Exception):
    """A module refuses a message it can't file: a short code with no patient data."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code[:100]


def handles(partner: str, message_type: str) -> Callable[[Handler], Handler]:
    if message_type not in MESSAGE_TYPES.get(partner, frozenset()):
        raise ValueError(f"{partner} sends no {message_type!r} callbacks")

    def register(handler: Handler) -> Handler:
        if (partner, message_type) in _HANDLERS:
            raise ValueError(f"{partner} {message_type} already has a handler")
        _HANDLERS[(partner, message_type)] = handler
        return handler

    return register


class PartnerMessage(BaseModel):
    """The contract's PartnerMessage: the envelope core checks."""

    model_config = ConfigDict(extra="forbid")

    message_type: Literal["271", "RxStatus"] = Field(alias="messageType")
    schema_version: str = Field(alias="schemaVersion", max_length=10, pattern=r"^[0-9]+\.[0-9]+$")
    correlation_id: UUID = Field(alias="correlationId")
    response_id: str = Field(alias="responseId", min_length=1, max_length=60)
    responded_at: AwareDatetime = Field(alias="respondedAt")
    result: Literal["active", "inactive", "member-not-found", "error"] | None = None
    plan: dict[str, Any] | None = Field(default=None, max_length=20)
    benefits: list[dict[str, Any]] | None = Field(default=None, max_length=100)
    errors: list[dict[str, Any]] | None = Field(default=None, max_length=20)
    status: Literal["accepted", "rejected"] | None = None
    rejection: dict[str, Any] | None = Field(default=None, max_length=10)


_ENDPOINT = text("SELECT id FROM admin.integration_endpoint WHERE kind = :kind AND is_active "
                 "ORDER BY created_at LIMIT 1")
_RECORD = text(
    "INSERT INTO admin.integration_message (id, tenant_id, endpoint_id, direction, message_type, "
    "status, control_id, correlation_id, received_at, attempts, max_attempts) "
    "VALUES (:id, :tenant, :endpoint, 'inbound', :type, 'received', :control, :correlation, "
    "now(), 0, 1) ON CONFLICT (endpoint_id, direction, control_id) DO NOTHING RETURNING id")
_PROCESSED = text("UPDATE admin.integration_message SET status = 'processed', "
                  "processed_at = now(), updated_at = now() WHERE id = :id")
_UNFILED = text("UPDATE admin.integration_message SET status = :status, last_error = :error, "
                "updated_at = now() WHERE id = :id")


def _message(body: bytes, partner: str) -> dict[str, Any]:
    try:
        data = json.loads(body)
        PartnerMessage.model_validate(data)
    except (ValueError, ValidationError):  # JSONDecodeError is a ValueError
        raise MalformedMessage() from None
    if data["messageType"] not in MESSAGE_TYPES[partner]:
        raise MalformedMessage()
    checked: dict[str, Any] = data
    return checked


async def _record(request: Request, db: Database, hook: VerifiedHook,
                  message: dict[str, Any]) -> UUID | None:
    """The inbound row and its audit row, committed; None for a message already received."""
    async with db.system_session(hook.clinic_id, current_request_id()) as s:
        endpoint = (await s.execute(_ENDPOINT, {"kind": hook.partner})).scalar_one_or_none()
        if endpoint is None:  # an unknown clinic, or none connected to this partner
            raise Unauthorized()
        message_id = (await s.execute(_RECORD, {
            "id": uuid4(), "tenant": hook.clinic_id, "endpoint": endpoint,
            "type": message["messageType"], "control": hook.message_id,
            "correlation": (current_request_id() or "")[:64] or None,
        })).scalar_one_or_none()
        if message_id is None:
            return None
        row = {
            "tenant_id": hook.clinic_id, "actor_type": "partner", "actor_user_id": None,
            "actor_display": hook.partner, "action": "create", "outcome": "success",
            "category": "phi-write", "entity_type": "integration-message",
            "entity_id": str(message_id), "patient_id": None, "purpose_of_use": None,
            "reason": None, "source_ip": audit._client_ip(request),
            "user_agent": (request.headers.get("user-agent") or "")[:300] or None,
            "correlation_id": current_request_id()}

        def write(sync: Any) -> None:
            audit.insert_rows(sync.connection(), [row])

        await s.run_sync(write)
        await s.commit()
        found: UUID = message_id
        return found


async def _file(db: Database, hook: VerifiedHook, message_id: UUID,
                message: dict[str, Any]) -> None:
    """The module's handler in its own transaction; the outcome is kept on the inbound row."""
    handler = _HANDLERS.get((hook.partner, message["messageType"]))
    status, error = "dead-letter", "no-handler"
    if handler is not None:
        try:
            async with db.system_session(hook.clinic_id, current_request_id()) as s:
                await handler(s, message)
                await s.execute(_PROCESSED, {"id": message_id})
                await s.commit()
            return
        except Rejected as refused:
            status, error = "failed", refused.code
        except Exception:  # a module bug: its text may hold patient data, so it isn't kept
            log_failure(log, "Partner message %s (%s %s) could not be filed", message_id,
                        hook.partner, message["messageType"])
            status, error = "failed", "internal-error"
    async with db.system_session(hook.clinic_id, current_request_id()) as s:
        await s.execute(_UNFILED, {"id": message_id, "status": status, "error": error})
        await s.commit()
    log.warning("Partner message %s (%s %s) not filed: %s", message_id, hook.partner,
                message["messageType"], error)


async def receive(request: Request, partner: str) -> Response:
    db: Database | None = request.app.state.db
    if db is None:
        raise ServiceUnavailable("Database is not configured")
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise MalformedMessage()
    hook = verify(request.app.state.settings, partner, request.headers, body)
    message = _message(body, partner)
    message_id = await _record(request, db, hook, message)
    if message_id is not None:
        await _file(db, hook, message_id, message)
    return Response(status_code=200, headers={"Cache-Control": "no-store"})


router = APIRouter(tags=["partner-callbacks"])


@router.post("/hooks/clearinghouse", operation_id="receiveClearinghouseMessage",
             include_in_schema=False)
async def receive_clearinghouse_message(request: Request) -> Response:
    return await receive(request, "clearinghouse")


@router.post("/hooks/erx", operation_id="receivePharmacyMessage", include_in_schema=False)
async def receive_pharmacy_message(request: Request) -> Response:
    return await receive(request, "erx")


def register(app: FastAPI, settings: Settings) -> None:
    """At the root, outside /api/v1, like the other /hooks."""
    app.include_router(router)
