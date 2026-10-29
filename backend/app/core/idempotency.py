"""Safe retries with the Idempotency-Key header (ADR-0007, API_STANDARDS §10, T21).

Endpoints write no idempotency code. For an operation with x-idempotency, tenant_db claims the
key before the endpoint runs, and IdempotencyMiddleware stores the response:

- **No key:** `required` → 400 idempotency-key-missing; `supported` → the request runs as usual.
- **Not a UUID** (bare or quoted) → 422 validation-failed naming the header.
- **First use:** the key is claimed (`in-progress`) in its own committed transaction, the
  endpoint runs, and its status, a few headers and its body are stored for 24 hours. The body is
  stored only as Transit ciphertext (encrypt_field), never in plaintext.
- **Same key, same body, finished:** the stored response again, with `Idempotent-Replayed: true`.
  The endpoint does not run.
- **Same key, different body** → 422 idempotency-key-reused.
- **Same key while the first is still running** → 409 idempotency-request-in-progress.
- **5xx and 429 are not stored:** the claim is released, so a retry runs again.

Scope: clinic + user + method + path (with its IDs) + key, the table's unique key; row-level
security keeps clinics apart. Fingerprint: SHA-256 of the body, JSON in canonical form (sorted
keys, no spaces), so the same request re-serialised still matches.

A claim lasts IN_PROGRESS_LEASE, so a request that dies mid-way frees its key; a stored response
lasts RETENTION. The API never deletes rows (admin.purge_expired_runtime_rows does): a released or
expired row is claimed again in place.

If the response can't be stored after the endpoint ran (OpenBao or the database down), the
response still goes out, since the work is done. A 2xx/3xx keeps its key claimed for RETENTION,
so a retry gets 409 rather than doing the work twice; a 4xx is released. Nothing is ever stored
unencrypted, and no body or key value is logged.
"""

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql.expression import bindparam
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import Settings
from app.core.crypto import decrypt_field, encrypt_field
from app.core.errors import AppError, Conflict, ValidationFailed, field_error
from app.core.operations import Operation
from app.core.request_id import current_request_id

if TYPE_CHECKING:
    from app.core.db import Database

log = logging.getLogger(__name__)

HEADER = "Idempotency-Key"
REPLAYED_HEADER = "Idempotent-Replayed"
STATE = "shri_idempotency_claim"  # request.state key: the claim, for the middleware
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH"})  # as the table's unsafe_method check
RETENTION = timedelta(hours=24)
IN_PROGRESS_LEASE = timedelta(minutes=10)  # longer than any request may run
# What a replay repeats besides the status and body. Never Set-Cookie or anything per-request.
STORED_HEADERS = ("content-type", "location", "etag")

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class IdempotencyKeyMissing(AppError):
    """400: the operation is `x-idempotency: required` and the request has no key."""

    default_code = "idempotency-key-missing"


class Replay(Exception):
    """Raised by tenant_db for a finished key: the handler sends the stored response."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        super().__init__("idempotent replay")
        self.status, self.headers, self.body = status, headers, body


@dataclass(frozen=True)
class Claim:
    """This request holds the key until `lease_until`; only it may finish or release the row."""

    record_id: UUID
    tenant_id: UUID
    user_id: UUID
    lease_until: datetime


def applies(operation: Operation | None, method: str) -> bool:
    return operation is not None and operation.idempotency is not None and method in UNSAFE_METHODS


def parse_key(raw: str) -> str:
    """The key as stored: a UUID in lower case. Accepted bare or quoted (a Structured Field
    string, draft-07 §2.1); anything else is 422 naming the header (API_STANDARDS §10)."""
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        value = value[1:-1]
    value = value.lower()
    if not _UUID.fullmatch(value):
        raise ValidationFailed("1 field is invalid.",
                               errors=[field_error("header", HEADER, "invalid-format")])
    return value


def fingerprint(body: bytes) -> str:
    """SHA-256 of the body; a JSON body in canonical form first."""
    try:
        canonical = json.dumps(json.loads(body), sort_keys=True, separators=(",", ":"),
                               ensure_ascii=False).encode()
    except ValueError:  # not JSON (or empty): the bytes as sent
        canonical = body
    return hashlib.sha256(canonical).hexdigest()


_CLAIM = text("""
    INSERT INTO admin.idempotency_record AS r
        (id, tenant_id, user_id, method, path, key, request_hash, state, expires_at,
         created_by_user_id, updated_by_user_id)
    VALUES (:id, :tenant_id, :user_id, :method, :path, :key, :request_hash, 'in-progress',
            now() + make_interval(secs => :lease), :user_id, :user_id)
    ON CONFLICT (tenant_id, user_id, method, path, key) DO UPDATE
        SET request_hash = EXCLUDED.request_hash, state = 'in-progress', response_status = NULL,
            response_headers = NULL, response_body_enc = NULL, expires_at = EXCLUDED.expires_at,
            updated_at = now(), updated_by_user_id = EXCLUDED.updated_by_user_id
        WHERE r.expires_at <= now()
    RETURNING r.id, r.expires_at
""")
_FIND = text("""
    SELECT request_hash, state, response_status, response_headers, response_body_enc
    FROM admin.idempotency_record
    WHERE tenant_id = :tenant_id AND user_id = :user_id AND method = :method AND path = :path
      AND key = :key
""")
_FINISH = text("""
    UPDATE admin.idempotency_record
    SET state = 'done', response_status = :status, response_headers = :headers,
        response_body_enc = :body, expires_at = now() + make_interval(secs => :retention),
        updated_at = now()
    WHERE id = :id AND state = 'in-progress' AND expires_at = :lease_until
""").bindparams(bindparam("headers", type_=JSONB))
# Release: expire the claim now, so a retry claims the row again. Hold: keep it claimed.
_EXPIRE = text("""
    UPDATE admin.idempotency_record
    SET expires_at = now() + make_interval(secs => :seconds), updated_at = now()
    WHERE id = :id AND state = 'in-progress' AND expires_at = :lease_until
""")


async def claim(request: Request, db: "Database", tenant_id: UUID, user_id: UUID,
                operation: Operation) -> None:
    """Called by tenant_db, after the permission check and before the endpoint runs. Returns
    with the key claimed (or with nothing to do), or raises: 400, 422, 409 or Replay."""
    raw = request.headers.get(HEADER)
    if raw is None:
        if operation.idempotency == "required":
            raise IdempotencyKeyMissing("Send an Idempotency-Key header")
        return
    scope = {"tenant_id": tenant_id, "user_id": user_id, "method": request.method,
             "path": request.url.path, "key": parse_key(raw)}
    request_hash = fingerprint(await request.body())
    # Its own transaction, committed before the endpoint runs: a concurrent retry must see it.
    async with db.tenant_session(tenant_id, user_id, current_request_id()) as session:
        claimed = (await session.execute(_CLAIM, {
            **scope, "id": uuid4(), "request_hash": request_hash,
            "lease": IN_PROGRESS_LEASE.total_seconds()})).one_or_none()
        if claimed is not None:
            await session.commit()
        else:  # someone holds a live record for this key
            found = (await session.execute(_FIND, scope)).one()
    if claimed is not None:
        setattr(request.state, STATE, Claim(claimed.id, tenant_id, user_id, claimed.expires_at))
        return
    if found.request_hash != request_hash:
        raise ValidationFailed("This Idempotency-Key was used for a different request",
                               code="idempotency-key-reused")
    if found.state != "done":
        raise Conflict("A request with this Idempotency-Key is still running; retry later",
                       code="idempotency-request-in-progress")
    body = (await decrypt_field(request.app, found.response_body_enc)
            if found.response_body_enc else b"")
    raise Replay(found.response_status, dict(found.response_headers or {}), body)


async def replay_response(request: Request, exc: Exception) -> Response:
    replay: Replay = exc  # type: ignore[assignment]
    return Response(content=replay.body, status_code=replay.status,
                    headers={**replay.headers, REPLAYED_HEADER: "true"})


async def _expire(db: "Database", claim: Claim, seconds: float) -> None:
    async with db.tenant_session(claim.tenant_id, claim.user_id, current_request_id()) as session:
        await session.execute(_EXPIRE, {"id": claim.record_id, "lease_until": claim.lease_until,
                                        "seconds": seconds})
        await session.commit()


async def _release(db: "Database", claim: Claim) -> None:
    try:
        await _expire(db, claim, 0)
    except Exception:
        # The lease still runs out, so the key frees itself.
        log.exception("Could not release an Idempotency-Key claim (request %s)",
                      current_request_id())


async def _finish(app: Any, claim: Claim, status: int, headers: list[tuple[bytes, bytes]],
                  body: bytes) -> None:
    db: Database = app.state.db
    if status >= 500 or status == 429:
        await _release(db, claim)
        return
    stored = {name.decode("latin-1"): value.decode("latin-1") for name, value in headers
              if name.decode("latin-1").lower() in STORED_HEADERS}
    try:
        ciphertext = await encrypt_field(app, body) if body else None
        async with db.tenant_session(claim.tenant_id, claim.user_id,
                                     current_request_id()) as session:
            await session.execute(_FINISH, {
                "id": claim.record_id, "lease_until": claim.lease_until, "status": status,
                "headers": stored, "body": ciphertext,
                "retention": RETENTION.total_seconds()})
            await session.commit()
    except Exception:
        log.exception("Could not store an idempotent response (request %s, status %s)",
                      current_request_id(), status)
        if status >= 400:
            await _release(db, claim)  # nothing was done: a retry may run again
            return
        try:
            await _expire(db, claim, RETENTION.total_seconds())  # done: never run it twice
        except Exception:
            log.exception("Could not hold an Idempotency-Key claim (request %s)",
                          current_request_id())


class IdempotencyMiddleware:
    """Holds back the response of a request that claimed a key until it is stored (or the claim
    released), then sends it unchanged. Sits outside AuditMiddleware, so it sees the final
    status. Requests without a claim pass straight through."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in UNSAFE_METHODS:
            await self.app(scope, receive, send)
            return
        start: Message | None = None
        chunks: list[bytes] = []
        done = False

        def held() -> Claim | None:
            found: Claim | None = scope.get("state", {}).get(STATE)
            return found

        async def hold_back(message: Message) -> None:
            nonlocal start, done
            claim = held()
            if claim is None or done:
                await send(message)
                return
            if message["type"] == "http.response.start":
                start = message
                return
            if message["type"] == "http.response.body" and start is not None:
                chunks.append(message.get("body", b""))
                if message.get("more_body", False):
                    return
                body = b"".join(chunks)
                await _finish(scope["app"], claim, start["status"], start.get("headers", []),
                              body)
                done = True
                await send(start)
                await send({"type": "http.response.body", "body": body})
                return
            await send(message)

        try:
            await self.app(scope, receive, hold_back)
        except BaseException:
            claim = held()
            if claim is not None and not done:
                await _release(scope["app"].state.db, claim)  # the error becomes a 500
            raise


def register(app: FastAPI, settings: Settings) -> None:
    """Outside the audit middleware, so it stores the final status, audit 500s included."""
    app.add_middleware(IdempotencyMiddleware)


def register_replays(app: FastAPI, settings: Settings) -> None:
    """The stored answer for a finished key, after core's own error handlers."""
    app.add_exception_handler(Replay, replay_response)
