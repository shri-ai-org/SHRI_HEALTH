"""The ``file.scan`` operation and the ``file.scanned`` event, through core (#115).

``completeUpload`` answers ``202`` with an operation of kind ``file.scan`` (API_STANDARDS §13).
``CoreOperations`` records it with core's ``long_running`` API, in the request's transaction:

- ``create_operation(db, "file.scan")``: queued, for the request's user, who alone may read it
  (``GET /operations/{operationId}``);
- ``finish_operation(...)``: ``succeeded`` with result ``{type: file, id}``, or ``failed`` with a
  Problem (``422 file-not-ready``) for a rejected file. Core publishes ``operation.completed`` to
  the creator in the same transaction;
- ``publish(db, "file.scanned", "file/<id>", {"status": "clean" | "rejected"})`` (EVENTS.md §4,
  internal only), also in the same transaction.

**The scan still runs inside the request.** Core has no worker for a module's own jobs: the
outbox is for partners only (D25) and ``assigned_to_integration`` hands an operation to the
partner worker. So the operation is created, the file scanned and the operation finished before
the one commit, and the ``202`` carries the finished operation (core's ``accepted()``, with
``Location`` and ``Retry-After``). When core offers a job runner for modules, ``completeUpload``
commits the ``queued`` operation, the runner calls ``service.scan_upload()`` in the file's clinic
and finishes the operation with this same interface; nothing else changes.

``Operations`` is the interface, so the API tests (no database) use the fake in
``tests/fakes.py``.
"""

from __future__ import annotations

from typing import Any, Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import publish
from app.core.long_running import Final, Operation, create_operation, finish_operation

FILE_SCAN = "file.scan"
FILE_SCANNED = "file.scanned"


class Operations(Protocol):
    async def start(self, db: AsyncSession, kind: str) -> Operation:
        """A queued operation for the session's user (no commit)."""
        ...

    async def finish(self, db: AsyncSession, operation: Operation, status: Final, *,
                     result: tuple[str, UUID] | None = None,
                     error: dict[str, Any] | None = None) -> Operation:
        """End it and tell its creator (no commit)."""
        ...

    async def file_scanned(self, db: AsyncSession, file_id: UUID, status: str) -> None:
        """Publish ``file.scanned`` with ``status`` ``clean`` or ``rejected`` (no commit)."""
        ...


class CoreOperations:
    async def start(self, db: AsyncSession, kind: str) -> Operation:
        return await create_operation(db, kind)

    async def finish(self, db: AsyncSession, operation: Operation, status: Final, *,
                     result: tuple[str, UUID] | None = None,
                     error: dict[str, Any] | None = None) -> Operation:
        return await finish_operation(db, operation.id, status, result=result, error=error)

    async def file_scanned(self, db: AsyncSession, file_id: UUID, status: str) -> None:
        await publish(db, FILE_SCANNED, f"file/{file_id}", {"status": status})


def operations() -> Operations:
    """FastAPI dependency: core's operations and events."""
    return CoreOperations()
