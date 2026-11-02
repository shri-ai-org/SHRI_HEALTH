"""Partner callbacks (contract operations receiveClearinghouseMessage, receivePharmacyMessage;
API_STANDARDS §16.1, D25): POST /hooks/clearinghouse and POST /hooks/erx, outside /api/v1.

Each request, in order:
1. **Verify** the signature, timestamp and clinic (core/partner_hooks.py) before anything else.
2. **Check the envelope** (`PartnerMessage` in the contract); the owning module validates the rest.
3. **Record** it in the clinic's session, in its own transaction: an inbound
   `admin.integration_message` keyed by the partner's `webhook-id`, so a repeat is not filed twice
   (the table's unique endpoint + direction + control ID).
4. **Match** it to our request: today's messages are all answers, so `correlationId` must name an
   outbound message of the same clinic and partner (one of the IDs in its payload). The clinic
   header is signed with the partner's secret, but that secret is the same for every clinic, so
   this is what keeps a message from being filed in a clinic that never asked.
5. **File** it through the module that registered its type with `@handles`, in a savepoint of a
   transaction that holds the inbound row locked, and mark it `processed`; the audit row
   (`phi-write`, the partner as actor, T37) names the patient the handler returns. Otherwise the
   row becomes `failed` (or `dead-letter` with no handler) with a short code, never content, and
   the audit row records the failure.

The partner always gets the same empty 200 once the message is recorded: nothing about the
outcome leaves. If filing never finished (the database went away mid-request), the row stays
`received` and the partner's retry with the same `webhook-id` files it then; a filed or refused
message is never filed again. Modules register their handlers when they are imported:

    from app.integration.inbound import Rejected, handles

    @handles("clearinghouse", "271")
    async def file_271(db: AsyncSession, message: dict[str, Any],
                       request: dict[str, Any]) -> Filed:
        ...  # in the clinic's session; `request` is our outbound payload (its IDs only)

A handler may return anything; if the result has a `patient_id` (a UUID), the audit row names
that patient. Core's `NotFound` and `ValidationFailed` count as refusals (`unknown-correlation`,
`invalid-message`); raise `Rejected("code")` for any other.

**Not yet (follow-up):** the raw body is not stored encrypted before processing (§16.1 asks for
it; it needs the file store's encrypted objects), so processing is in the request, and a message
refused or failed here can't be replayed by an operator until the inbound replay route exists
(inventory #25).
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
from app.core.errors import AppError, NotFound, ServiceUnavailable, Unauthorized, ValidationFailed
from app.core.partner_hooks import MAX_BODY_BYTES, VerifiedHook, verify
from app.core.request_id import current_request_id
from app.core.safe_logging import log_failure

log = logging.getLogger(__name__)

Handler = Callable[[AsyncSession, dict[str, Any], dict[str, Any]], Awaitable[object]]
MESSAGE_TYPES: dict[str, frozenset[str]] = {
    "clearinghouse": frozenset({"271"}), "erx": frozenset({"RxStatus"}),
}
MAX_BENEFIT_LINES = 200  # the clearinghouse partner schema's limit
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
    benefits: list[dict[str, Any]] | None = Field(default=None, max_length=MAX_BENEFIT_LINES)
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
_EXISTING = text("SELECT id FROM admin.integration_message WHERE endpoint_id = :endpoint "
                 "AND direction = 'inbound' AND control_id = :control")
_LOCK = text("SELECT status FROM admin.integration_message WHERE id = :id FOR UPDATE")
# Our request this answers: an outbound message of this clinic (RLS) to this partner whose
# payload holds the correlation ID among its IDs.
_REQUEST = text(
    "SELECT m.payload FROM admin.integration_message m "
    "JOIN admin.integration_endpoint e ON e.id = m.endpoint_id "
    "WHERE m.direction = 'outbound' AND e.kind = :kind AND m.payload IS NOT NULL "
    "AND jsonb_path_exists(m.payload, '$.* ? (@ == $c)', "
    "                      jsonb_build_object('c', CAST(:c AS text))) "
    "ORDER BY m.created_at DESC LIMIT 1")
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


async def _record(db: Database, hook: VerifiedHook, message: dict[str, Any]) -> UUID:
    """The inbound row, committed (or the existing one for a repeat)."""
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
            message_id = (await s.execute(_EXISTING, {"endpoint": endpoint,
                                                      "control": hook.message_id})).scalar_one()
        await s.commit()
        found: UUID = message_id
        return found


def _audit(s: AsyncSession, request: Request, hook: VerifiedHook, message_id: UUID,
           patient_id: UUID | None, error: str | None) -> Awaitable[None]:
    row = {
        "tenant_id": hook.clinic_id, "actor_type": "partner", "actor_user_id": None,
        "actor_display": hook.partner, "action": "create",
        "outcome": "failure" if error else "success", "category": "phi-write",
        "entity_type": "integration-message", "entity_id": str(message_id),
        "patient_id": patient_id, "purpose_of_use": None, "reason": error,
        "source_ip": audit._client_ip(request),
        "user_agent": (request.headers.get("user-agent") or "")[:300] or None,
        "correlation_id": current_request_id()}

    def write(sync: Any) -> None:
        audit.insert_rows(sync.connection(), [row])

    return s.run_sync(write)


def _patient(result: object) -> UUID | None:
    patient = getattr(result, "patient_id", None)
    return patient if isinstance(patient, UUID) else None


async def _file(request: Request, db: Database, hook: VerifiedHook, message_id: UUID,
                message: dict[str, Any]) -> None:
    """Files a received message once (see the module docstring)."""
    async with db.system_session(hook.clinic_id, current_request_id()) as s:
        if (await s.execute(_LOCK, {"id": message_id})).scalar_one() != "received":
            await s.rollback()
            return  # already filed or refused: a repeat changes nothing
        status, error, patient = "processed", None, None
        ours = (await s.execute(_REQUEST, {"kind": hook.partner,
                                           "c": message["correlationId"]})).scalar_one_or_none()
        handler = _HANDLERS.get((hook.partner, message["messageType"]))
        if ours is None:
            status, error = "failed", "unknown-correlation"
        elif handler is None:
            status, error = "dead-letter", "no-handler"
        else:
            try:
                async with s.begin_nested():  # a refusal undoes the handler's writes only
                    patient = _patient(await handler(s, message, dict(ours)))
            except Rejected as refused:
                status, error = "failed", refused.code
            except NotFound:
                status, error = "failed", "unknown-correlation"
            except ValidationFailed:
                status, error = "failed", "invalid-message"
            except Exception:  # a module bug: its text may hold patient data, so it isn't kept
                log_failure(log, "Partner message %s (%s %s) could not be filed", message_id,
                            hook.partner, message["messageType"])
                status, error = "failed", "internal-error"
        if error is None:
            await s.execute(_PROCESSED, {"id": message_id})
        else:
            await s.execute(_UNFILED, {"id": message_id, "status": status, "error": error})
        await _audit(s, request, hook, message_id, patient, error)
        await s.commit()
    if error is not None:
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
    message_id = await _record(db, hook, message)
    await _file(request, db, hook, message_id, message)
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
