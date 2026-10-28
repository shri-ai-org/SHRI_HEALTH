"""enqueue(): a partner message through the outbox, in the caller's transaction (T29, D25).

    message_id = await enqueue(db, "erx", "NewRx", {"prescriptionId": str(rx.id)},
                               idempotency_key=f"newrx:{rx.id}:{rx.version}",
                               ordering_key=f"prescription:{rx.id}")
    await db.commit()   # the signed prescription and its NewRx commit together, or neither does

- **The caller's transaction.** One `outbound` row in admin.integration_message, written in the
  caller's tenant_db session; it never commits. Nothing is sent from the request: the worker
  claims queued rows (admin.claim_outbound_messages) and sends them, with retries, backoff and
  the dead-letter queue (DATA_OWNERSHIP §3.3).
- **Partners only (D25):** lab, erx, clearinghouse, fax and notification (SMS and email).
  Never for writes to our own database.
- **The clinic's connection** of that kind (admin.integration_endpoint, active). None is 503
  (the request fails and nothing half-happens); several is an error, until callers that need
  to choose (labs) get a way to name one.
- **The payload is IDs only:** camelCase members whose values are IDs, codes, counts or flags,
  at most 8 KB. The worker reads the records and builds the HL7, X12 or JSON message at send
  time, so patient data never sits in the outbox row.
- **Idempotency:** the key is unique per clinic. The same key with the same message returns the
  existing message's ID, so a retry never sends twice. The same key with a different message is
  a programming error (ValueError).
- **Ordering:** messages with the same ordering key are sent in the order they were queued (the
  claim function holds back a later one while an earlier one is unsent), so a CancelRx never
  overtakes its NewRx.
"""

import json
import re
from collections.abc import Mapping
from typing import Any, Literal, get_args
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import TENANT_ID_INFO_KEY, session_user_id
from app.core.errors import InternalError, ServiceUnavailable
from app.core.request_id import current_request_id

Partner = Literal["lab", "erx", "clearinghouse", "fax", "notification"]
PARTNERS: frozenset[str] = frozenset(get_args(Partner))
MESSAGE_TYPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9^_.-]{0,29}$")  # ORM^O01, 270, NewRx
KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_./-]{0,99}$")
MEMBER = re.compile(r"^[a-z][A-Za-z0-9]{0,63}$")
MAX_PAYLOAD_BYTES = 8192  # as the table's check
MAX_STRING = 120
MAX_INT = 9007199254740991
MAX_ATTEMPTS = 8

_ENDPOINTS = text("SELECT id FROM admin.integration_endpoint "
                  "WHERE kind = :kind AND is_active ORDER BY created_at LIMIT 2")
_INSERT = text(
    "INSERT INTO admin.integration_message (id, tenant_id, endpoint_id, direction, message_type, "
    "status, idempotency_key, ordering_key, payload, correlation_id, attempts, max_attempts, "
    "created_by_user_id, updated_by_user_id) VALUES (:id, :tenant, :endpoint, 'outbound', :type, "
    "'queued', :key, :ordering, CAST(:payload AS jsonb), :correlation, 0, :max_attempts, :user, "
    ":user) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id")
_EXISTING = text("SELECT id, endpoint_id, message_type, ordering_key, payload "
                 "FROM admin.integration_message WHERE idempotency_key = :key")


def _value_ok(value: Any) -> bool:
    if isinstance(value, bool):
        return True
    if isinstance(value, int):
        return 0 <= value <= MAX_INT
    if isinstance(value, str):
        return len(value) <= MAX_STRING
    return False


def check_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    """IDs, codes, counts and flags only; a list of IDs is allowed. ValueError otherwise."""
    if not isinstance(payload, Mapping):
        raise ValueError("an outbox payload is an object")
    checked: dict[str, Any] = {}
    for name, value in payload.items():
        if not isinstance(name, str) or not MEMBER.fullmatch(name):
            raise ValueError(f"outbox payload member {name!r} is not a camelCase name")
        if isinstance(value, list):
            if len(value) > 100 or not all(isinstance(v, str) and _value_ok(v) for v in value):
                raise ValueError(f"outbox payload {name}: a list holds IDs only (<= 100)")
        elif not _value_ok(value):
            raise ValueError(f"outbox payload {name}: only IDs, codes, counts and flags "
                             "(the worker reads the records at send time)")
        checked[name] = value
    if len(json.dumps(checked).encode()) > MAX_PAYLOAD_BYTES:
        raise ValueError(f"outbox payload is over {MAX_PAYLOAD_BYTES} bytes")
    return checked


async def _endpoint(db: AsyncSession, partner: str) -> UUID:
    found = (await db.execute(_ENDPOINTS, {"kind": partner})).scalars().all()
    if not found:
        raise ServiceUnavailable(f"No {partner} connection is set up for this practice")
    if len(found) > 1:
        raise InternalError(f"More than one active {partner} connection; enqueue() can't choose")
    endpoint: UUID = found[0]
    return endpoint


async def enqueue(db: AsyncSession, partner: str, message_type: str, payload: dict[str, Any],
                  idempotency_key: str, ordering_key: str | None = None) -> UUID:
    """Queues one partner message in the caller's transaction; returns its ID. See the module
    docstring."""
    if partner not in PARTNERS:
        raise ValueError(f"partner {partner!r} is not one of {sorted(PARTNERS)} (D25)")
    if not MESSAGE_TYPE.fullmatch(message_type):
        raise ValueError(f"message type {message_type!r} is not a partner message type")
    if not KEY.fullmatch(idempotency_key):
        raise ValueError("idempotency_key: 1 to 100 of letters, digits and : _ . / -")
    if ordering_key is not None and not KEY.fullmatch(ordering_key):
        raise ValueError("ordering_key: 1 to 100 of letters, digits and : _ . / -")
    checked = check_payload(payload)
    tenant_id, user_id = db.info.get(TENANT_ID_INFO_KEY), session_user_id(db)
    if tenant_id is None:
        raise RuntimeError("enqueue() needs a clinic session (tenant_db)")
    endpoint_id = await _endpoint(db, partner)
    created = (await db.execute(_INSERT, {
        "id": uuid4(), "tenant": tenant_id, "endpoint": endpoint_id, "type": message_type,
        "key": idempotency_key, "ordering": ordering_key, "payload": json.dumps(checked),
        "correlation": (current_request_id() or "")[:64] or None,
        "max_attempts": MAX_ATTEMPTS, "user": user_id})).scalar_one_or_none()
    if created is not None:
        message_id: UUID = created
        return message_id
    existing = (await db.execute(_EXISTING, {"key": idempotency_key})).one()
    if (existing.endpoint_id, existing.message_type, existing.ordering_key,
            existing.payload) != (endpoint_id, message_type, ordering_key, checked):
        raise ValueError("idempotency_key was used for a different partner message")
    existing_id: UUID = existing.id
    return existing_id
