"""Thin domain events (EVENTS.md): publish() in the writer's transaction, and the live stream.

    await publish(db, "appointment.checked-in", f"appointment/{appointment.id}",
                  {"encounterId": str(encounter.id), "status": "arrived"},
                  facility_id=appointment.facility_id, patient_id=appointment.patient_id)
    await db.commit()   # the change and its event commit together, or neither does

**publish()** inserts one row into admin.event_log in the caller's session; it never commits.
Call it before the endpoint's commit (core refuses a second commit with changes, audit.py).
`data` carries IDs, enum statuses, counts and flags only, never patient data: strings of at most
120 characters, non-negative integers and booleans, at most 20 members. A type whose family isn't
in the catalogue, a malformed subject or a value that breaks those rules is a programming error
(ValueError), so it never reaches a browser.

**GET /api/v1/events/stream** (streamEvents, EVENTS.md §3): Server-Sent Events, one
CloudEvents envelope per `data:` line. Each event goes to a user only if:
- it is delivered to browsers at all (internal-only types never are);
- it is in the user's clinic (row-level security);
- its facility, if it has one, is one of the user's;
- it targets nobody, or this user, or a role the user holds;
- the user holds the read permission of the subject's resource;
- and for a restricted patient's event, the user has a break-glass grant or is on the care team;
  otherwise only the type and subject go out, without `data`.
The same filter runs again on every replay. `Last-Event-ID` replays the last 5 minutes;
anything older gets `stream.reset`. A comment line every 25 seconds keeps proxies open. At most
5 streams per user (429). A stream ends after STREAM_MAX_SECONDS and the browser reconnects,
which re-checks the sign-in (until piece 6 adds the session check inside the stream).

Per-process for now: the stream count is this process's (as core/public_form.py's counters).
"""

import asyncio
import json
import logging
import re
import time
from collections import Counter
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, FastAPI, Header, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access
from app.core.config import Settings
from app.core.db import TENANT_ID_INFO_KEY, Database
from app.core.deps import CurrentUser, require
from app.core.errors import AppError, ServiceUnavailable
from app.core.request_id import current_request_id
from app.core.routing import API_PREFIX

log = logging.getLogger(__name__)

TYPE = re.compile(r"^[a-z][a-z-]*\.[a-z][a-z-]*$")
SUBJECT = re.compile(r"^([a-z][a-z-]*)/"
                     r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
ROLE = re.compile(r"^[A-Z]{2,10}$")
MAX_DATA_MEMBERS = 20
MAX_STRING = 120
MAX_INT = 9007199254740991

# The publishing module of each event family (EVENTS.md §2 `source`, §4 catalogue).
SOURCES: Mapping[str, str] = {
    "patient": "/patients", "pre-registration": "/patients",
    "appointment": "/scheduling", "eligibility": "/scheduling",
    "encounter": "/encounters", "note": "/notes",
    "prescription": "/medications", "refill-request": "/medications",
    "order": "/orders", "result": "/orders", "unmatched-result": "/orders",
    "file": "/documents", "fax": "/documents", "claim": "/billing",
    "inbox": "/inbox", "communication": "/communications",
    "operation": "/platform", "break-glass": "/platform", "stream": "/platform",
}
# EVENTS.md §4 "Internal": never sent to a browser.
INTERNAL_ONLY = frozenset({
    "patient.created", "patient.updated", "encounter.entered-in-error", "note.amended",
    "note.entered-in-error", "prescription.signed", "refill-request.received", "file.scanned",
    "break-glass.granted",
})
# What a user must hold to see an event about each kind of subject. A subject not listed here
# goes only to its target user or role (operation, inbox-item); with no target, to nobody.
READ_PERMISSION: Mapping[str, str] = {
    "patient": "patients:read", "pre-registration": "pre-registrations:read",
    "appointment": "appointments:read", "eligibility-check": "eligibility-checks:read",
    "encounter": "encounters:read", "note": "notes:read",
    "prescription": "prescriptions:read", "order": "orders:read", "result": "results:read",
    "unmatched-result": "unmatched-results:read", "fax": "fax-inbox:read",
    "claim": "claims:read", "communication": "communications:read", "file": "files:read",
}

REPLAY_SECONDS = 300
KEEP_ALIVE_SECONDS = 25.0
POLL_SECONDS = 1.0
STREAM_MAX_SECONDS = 300.0
MAX_STREAMS_PER_USER = 5
BATCH = 200


def _check_data(data: Mapping[str, Any]) -> dict[str, Any]:
    if len(data) > MAX_DATA_MEMBERS:
        raise ValueError(f"event data has more than {MAX_DATA_MEMBERS} members")
    checked: dict[str, Any] = {}
    for name, value in data.items():
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][A-Za-z0-9]*", name):
            raise ValueError(f"event data member {name!r} is not a camelCase name")
        if isinstance(value, bool):
            pass
        elif isinstance(value, int):
            if not 0 <= value <= MAX_INT:
                raise ValueError(f"event data {name}: integers are counts (0 to 2^53 - 1)")
        elif isinstance(value, str):
            if len(value) > MAX_STRING:
                raise ValueError(f"event data {name}: strings are IDs or statuses (<= 120)")
        else:
            raise ValueError(f"event data {name}: only IDs, statuses, counts and flags")
        checked[name] = value
    return checked


async def publish(db: AsyncSession, type: str, subject: str,  # noqa: A002 (CloudEvents name)
                  data: Mapping[str, Any] | None = None, *,
                  facility_id: UUID | None = None, patient_id: UUID | None = None,
                  target_user_id: UUID | None = None,
                  target_role_code: str | None = None) -> UUID:
    """Adds one event to the caller's transaction; returns its ID. See the module docstring."""
    if not TYPE.fullmatch(type) or len(type) > 100:
        raise ValueError(f"event type {type!r} is not family.action")
    if type.split(".", 1)[0] not in SOURCES:
        raise ValueError(f"event family of {type!r} is not in the catalogue (EVENTS.md §4)")
    if not SUBJECT.fullmatch(subject):
        raise ValueError(f"event subject {subject!r} is not <resource>/<uuid>")
    if target_role_code is not None and not ROLE.fullmatch(target_role_code):
        raise ValueError(f"target role {target_role_code!r} is not a role code")
    tenant_id = db.info.get(TENANT_ID_INFO_KEY)
    if tenant_id is None:
        raise RuntimeError("publish() needs a clinic session (tenant_db)")
    event_id = uuid4()
    await db.execute(text(
        "INSERT INTO admin.event_log (id, tenant_id, facility_id, patient_id, target_user_id, "
        "target_role_code, type, subject, data) VALUES (:id, :tenant, :facility, :patient, "
        ":user, :role, :type, :subject, CAST(:data AS jsonb))"),
        {"id": event_id, "tenant": tenant_id, "facility": facility_id, "patient": patient_id,
         "user": target_user_id, "role": target_role_code, "type": type, "subject": subject,
         "data": json.dumps(_check_data(data or {}))})
    return event_id


# ------------------------------------------------------------------------------------- stream
@dataclass(frozen=True)
class StoredEvent:
    seq: int
    id: UUID
    type: str
    subject: str
    data: dict[str, Any]
    created_at: datetime
    facility_id: UUID | None = None
    patient_id: UUID | None = None
    target_user_id: UUID | None = None
    target_role_code: str | None = None


def deliverable(event: StoredEvent, user: CurrentUser) -> bool:
    """Every rule but the restricted chart, which needs the database (see visible_data)."""
    if event.type in INTERNAL_ONLY:
        return False
    if event.facility_id is not None and event.facility_id not in user.facility_ids:
        return False
    if event.target_user_id is not None and event.target_user_id != user.id:
        return False
    if event.target_role_code is not None and event.target_role_code not in user.roles:
        return False
    if event.target_user_id is not None or event.target_role_code is not None:
        return True  # personal or role events: the target is the whole rule
    match = SUBJECT.fullmatch(event.subject)
    permission = READ_PERMISSION.get(match.group(1)) if match else None
    return permission is not None and user.can(permission)


async def visible_data(db: AsyncSession, event: StoredEvent,
                       user: CurrentUser) -> dict[str, Any] | None:
    """The event's data as this user may see it; None to send only type and subject."""
    if event.patient_id is None:
        return event.data
    chart = await access.chart_access(db, user, event.patient_id)
    return event.data if chart.allowed else None


def envelope(event: StoredEvent, data: dict[str, Any] | None) -> dict[str, Any]:
    return {"specversion": "1.0", "id": str(event.id), "type": event.type,
            "source": SOURCES[event.type.split(".", 1)[0]], "subject": event.subject,
            "time": event.created_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "datacontenttype": "application/json", "data": data or {}}


def sse(event_id: str, event_type: str, payload: dict[str, Any]) -> str:
    return f"id: {event_id}\nevent: {event_type}\ndata: {json.dumps(payload)}\n\n"


def reset_message() -> str:
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    event_id = str(uuid4())
    return sse(event_id, "stream.reset", {
        "specversion": "1.0", "id": event_id, "type": "stream.reset", "source": "/platform",
        "subject": "stream", "time": now, "datacontenttype": "application/json", "data": {}})


_FIELDS = ("seq, id, type, subject, data, created_at, facility_id, patient_id, target_user_id, "
           "target_role_code")
_AFTER = text(f"SELECT {_FIELDS} FROM admin.event_log WHERE seq > :seq "  # noqa: S608
              "AND created_at > now() - make_interval(secs => :window) ORDER BY seq LIMIT :n")
_LAST_SEQ = text("SELECT coalesce(max(seq), 0) FROM admin.event_log")
_SEQ_OF = text("SELECT seq FROM admin.event_log WHERE id = :id "
               "AND created_at > now() - make_interval(secs => :window)")


class TooManyStreams(AppError):
    default_code = "rate-limited"


_open_streams: Counter[UUID] = Counter()


async def _start(db: Database, user: CurrentUser, last_event_id: str | None) -> tuple[int, bool]:
    """Where to start: (sequence number, whether to send stream.reset first)."""
    async with db.tenant_session(user.organization_id, user.id, current_request_id()) as s:
        if last_event_id:
            try:
                seq = (await s.execute(_SEQ_OF, {"id": UUID(last_event_id),
                                                 "window": REPLAY_SECONDS})).scalar_one_or_none()
            except ValueError:
                seq = None
            if seq is not None:
                return int(seq), False
        current = int((await s.execute(_LAST_SEQ)).scalar_one())
        return current, bool(last_event_id)  # a gap we can't replay: the screen re-fetches


async def event_stream(db: Database, user: CurrentUser, last_event_id: str | None,
                       disconnected: Callable[[], Any],
                       clock: Callable[[], float] = time.monotonic) -> AsyncIterator[str]:
    seq, reset = await _start(db, user, last_event_id)
    yield "retry: 5000\n\n"
    if reset:
        yield reset_message()
    started = last_sent = clock()
    while clock() - started < STREAM_MAX_SECONDS:
        if await disconnected():
            return
        async with db.tenant_session(user.organization_id, user.id, current_request_id()) as s:
            rows = (await s.execute(_AFTER, {"seq": seq, "window": REPLAY_SECONDS,
                                             "n": BATCH})).mappings().all()
            for row in rows:
                event = StoredEvent(**dict(row))
                seq = event.seq
                if not deliverable(event, user):
                    continue
                data = await visible_data(s, event, user)
                yield sse(str(event.id), event.type, envelope(event, data))
                last_sent = clock()
        if clock() - last_sent >= KEEP_ALIVE_SECONDS:
            yield ": keep-alive\n\n"
            last_sent = clock()
        if len(rows) < BATCH:
            await asyncio.sleep(POLL_SECONDS)


router = APIRouter(tags=["platform"])


@router.get("/events/stream", operation_id="streamEvents", response_class=StreamingResponse)
async def stream_events(
    request: Request, user: CurrentUser = Depends(require("authenticated")),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID", max_length=64),
) -> StreamingResponse:
    db: Database | None = request.app.state.db
    if db is None:
        raise ServiceUnavailable("Database is not configured")
    if _open_streams[user.id] >= MAX_STREAMS_PER_USER:
        raise TooManyStreams(f"At most {MAX_STREAMS_PER_USER} open streams per user")
    _open_streams[user.id] += 1

    async def body() -> AsyncIterator[str]:
        try:
            async for chunk in event_stream(db, user, last_event_id, request.is_disconnected):
                yield chunk
        finally:
            _open_streams[user.id] -= 1
            if _open_streams[user.id] <= 0:
                del _open_streams[user.id]

    # X-Accel-Buffering: nginx must pass each event on at once (it's also off for /api/).
    return StreamingResponse(body(), media_type="text/event-stream",
                             headers={"X-Accel-Buffering": "no"})


def register(app: FastAPI, settings: Settings) -> None:
    app.include_router(router, prefix=API_PREFIX)
