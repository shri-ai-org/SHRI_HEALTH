"""The patient portal's secure messages (#398: listPortalMessageThreads, createPortalMessage,
getPortalMessageThread, replyToPortalMessageThread; x-owner anand; D77, D81, D84).

A thread is a ``patient-message`` inbox item; migration 0031's functions keep every rule in
the database, in the portal session: the patient's own threads only (another patient's is the
same ``404`` as a missing one), the staff replies sent to her and never a staff-only one, no
reply in a closed thread (``409``), and at most 5 messages in 10 minutes and 20 in 24 hours
(``429``). Creating a thread routes it to the clinic's medical assistants and raises
``inbox.item-assigned`` with no text (D81). Core writes the audit row (patient from the session)
and keeps the Idempotency-Key. Nothing here logs a subject or a message.
"""
from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient
from app.core.errors import AppError, Conflict, Forbidden, InternalError, NotFound

from ..history.service import decode_cursor, encode_cursor
from . import messages_schemas as s
from .messages_repository import MessageRow, MessageStore, Refused

PAGE_MAX = 100
#: The ten-minute window of the patient's limit (0031); a daily cap waits longer, but the
#: client only needs to know it must wait.
RETRY_AFTER_SECONDS = 600


class TooManyMessages(AppError):
    default_code = "rate-limited"


def _refusal(refused: Refused) -> AppError:
    match refused.reason:
        case "not-found":
            return NotFound()
        case "portal_message_thread_closed" | "portal_message_thread_full":
            return Conflict(code="invalid-state-transition")
        case "portal_message_rate_limited" | "portal_message_daily_cap":
            return TooManyMessages(headers={"Retry-After": str(RETRY_AFTER_SECONDS)})
        case "portal_message_chart_inactive":
            return Forbidden()
        case _:  # portal_message_no_queue: the clinic has no facility; never shown as such
            return InternalError()


def _thread(rows: list[MessageRow]) -> s.PortalMessageThread:
    first, last = rows[0], rows[-1]
    return s.PortalMessageThread(
        id=first.thread_id, subject=first.subject, status=first.status,
        created_at=first.created_at, last_message_at=last.sent_at,
        last_message_from=last.author,
        messages=[s.PortalMessage(id=r.message_id, author=r.author,
                                  author_name=(r.author_name or "Your care team")[:200]
                                  if r.author == "clinic" else None,
                                  body=r.body, sent_at=r.sent_at) for r in rows])


async def list_threads(db: AsyncSession, store: MessageStore, patient: PortalPatient, *,
                       limit: int, cursor: str | None) -> s.PortalMessageThreadList:
    offset = decode_cursor(cursor)
    size = min(limit, PAGE_MAX)
    rows = await store.threads(db, limit=size + 1, offset=offset)
    return s.PortalMessageThreadList(
        items=[s.PortalMessageThreadSummary(
            id=r.id, subject=r.subject, status=r.status,
            created_at=r.created_at, last_message_at=r.last_message_at,
            last_message_from=r.last_message_from)
            for r in rows[:size]],
        next_cursor=encode_cursor(offset + size) if len(rows) > size else None)


async def get_thread(db: AsyncSession, store: MessageStore, patient: PortalPatient,
                     thread_id: UUID) -> s.PortalMessageThread:
    rows = await store.thread(db, thread_id)
    if not rows:
        raise NotFound()
    return _thread(rows)


async def create_thread(db: AsyncSession, store: MessageStore, patient: PortalPatient,
                        body: s.PortalMessageCreate) -> s.PortalMessageThread:
    """Starts a thread, in the caller's transaction (no commit)."""
    try:
        thread_id = await store.create(db, body.subject, body.body)
    except Refused as refused:
        raise _refusal(refused) from None
    return await get_thread(db, store, patient, thread_id)


async def reply(db: AsyncSession, store: MessageStore, patient: PortalPatient, thread_id: UUID,
                body: s.PortalMessageReply) -> s.PortalMessageThread:
    """Adds the patient's reply, in the caller's transaction (no commit)."""
    try:
        await store.reply(db, thread_id, body.body)
    except Refused as refused:
        raise _refusal(refused) from None
    return await get_thread(db, store, patient, thread_id)
