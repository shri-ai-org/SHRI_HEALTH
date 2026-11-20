"""The portal's message threads, through migration 0031's functions only: shri_portal has no
privilege on the inbox tables, and each function takes the clinic and the patient from the
portal session (``portal_db``), never from here. A refusal comes back as ``Refused`` with the
function's constraint name (or ``not-found``); nothing here logs a subject or a message."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID

from sqlalchemy import TextClause, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.errors import db_error_detail


class Refused(Exception):
    """A function's refusal: ``reason`` is its constraint name, or ``not-found`` (P0002)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class ThreadRow:
    id: UUID
    subject: str
    status: str
    created_at: datetime
    last_message_at: datetime
    last_message_from: str


@dataclass(frozen=True)
class MessageRow:
    thread_id: UUID
    subject: str
    status: str
    created_at: datetime
    message_id: UUID
    author: str
    author_name: str | None
    body: str
    sent_at: datetime


class MessageStore(Protocol):
    async def threads(self, db: AsyncSession, *, limit: int, offset: int) -> list[ThreadRow]: ...

    async def thread(self, db: AsyncSession, thread_id: UUID) -> list[MessageRow]:
        """The thread's messages the patient may read, oldest first; none: not hers."""
        ...

    async def create(self, db: AsyncSession, subject: str, body: str) -> UUID: ...

    async def reply(self, db: AsyncSession, thread_id: UUID, body: str) -> UUID: ...


_THREADS = text("SELECT * FROM admin.portal_message_threads(:limit, :offset)")
_THREAD = text("SELECT * FROM admin.portal_message_thread(:thread)")
_CREATE = text("SELECT admin.portal_create_message(:subject, :body)")
_REPLY = text("SELECT admin.portal_reply_to_thread(:thread, :body)")


async def _write(db: AsyncSession, statement: TextClause, params: dict[str, object]) -> UUID:
    try:
        async with db.begin_nested():
            result: UUID = (await db.execute(statement, params)).scalar_one()
    except DBAPIError as error:
        detail = db_error_detail(error)
        # asyncpg keeps the constraint name on the driver's own exception.
        constraint = detail.constraint or getattr(
            getattr(error.orig, "__cause__", None), "constraint_name", None)
        if detail.sqlstate == "P0002":
            raise Refused("not-found") from None
        if detail.sqlstate == "P0001" and constraint:
            raise Refused(constraint) from None
        raise
    return result


class SqlMessageStore:
    async def threads(self, db: AsyncSession, *, limit: int, offset: int) -> list[ThreadRow]:
        rows = await db.execute(_THREADS, {"limit": limit, "offset": offset})
        return [ThreadRow(**r._mapping) for r in rows]

    async def thread(self, db: AsyncSession, thread_id: UUID) -> list[MessageRow]:
        rows = await db.execute(_THREAD, {"thread": thread_id})
        return [MessageRow(**r._mapping) for r in rows]

    async def create(self, db: AsyncSession, subject: str, body: str) -> UUID:
        return await _write(db, _CREATE, {"subject": subject, "body": body})

    async def reply(self, db: AsyncSession, thread_id: UUID, body: str) -> UUID:
        return await _write(db, _REPLY, {"thread": thread_id, "body": body})
