"""The ``file.scan`` operation that ``completeUpload`` answers with (``202``; API_STANDARDS §13).

``Operations`` is the module's interface for creating and finishing an operation.
``TransientOperations``, the TEMPORARY SEAM, builds the operation in memory only: core's
``create_operation()`` and ``GET /operations/{operationId}`` (PR #115, #80) are not on main
yet, and ``admin.operation`` is core's table, which no module writes by hand. So for now:

- the scan runs inside the request (``service.complete_upload``, the synchronous runner), and the
  ``202`` body is the finished operation (``succeeded`` with ``result {type: file, id}``, or
  ``failed`` with a Problem for a rejected file);
- ``Location`` names ``/api/v1/operations/{id}``, which can't be polled until #80 lands; the
  client has the outcome in the body already.

**What changes when #115 lands:**

1. ``operations()`` returns an implementation over core's ``create_operation(db, kind=...)``
   (created ``queued`` in the request's transaction, visible to its creator only) and core's
   completion call (``succeeded`` with the result, or ``failed`` with the Problem). The
   ``Operations`` interface stays.
2. ``completeUpload`` stops scanning in the request: it marks the file ``quarantined``, creates
   the operation and hands the file to a worker, then commits and answers ``202`` with the
   ``queued`` operation and ``Retry-After``. The worker runs ``service.scan_upload()`` in the
   file's clinic, in its own transaction, and finishes the operation. ``file.scanned``
   (EVENTS.md) is published then, once core's ``events.publish()`` exists.
3. The synchronous path stays for tests and local development.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser

FILE_SCAN = "file.scan"
FINAL = frozenset({"succeeded", "failed", "cancelled"})


@dataclass(frozen=True)
class OperationRecord:
    id: UUID
    kind: str
    status: str  # queued, running, succeeded, failed, cancelled
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    result_type: str | None = None
    result_id: UUID | None = None
    error: dict[str, Any] | None = None  # a Problem, never patient data

    @property
    def finished(self) -> bool:
        return self.status in FINAL


class Operations(Protocol):
    async def create(self, db: AsyncSession, user: CurrentUser, kind: str) -> OperationRecord:
        ...

    async def succeed(self, db: AsyncSession, operation: OperationRecord, *, result_type: str,
                      result_id: UUID) -> OperationRecord:
        ...

    async def fail(self, db: AsyncSession, operation: OperationRecord,
                   error: dict[str, Any]) -> OperationRecord:
        ...


def _now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


class TransientOperations:
    """In memory only, never stored (module docstring)."""

    async def create(self, db: AsyncSession, user: CurrentUser, kind: str) -> OperationRecord:
        now = _now()
        return OperationRecord(id=uuid4(), kind=kind, status="queued", created_at=now,
                               updated_at=now)

    async def succeed(self, db: AsyncSession, operation: OperationRecord, *, result_type: str,
                      result_id: UUID) -> OperationRecord:
        now = _now()
        return replace(operation, status="succeeded", updated_at=now, completed_at=now,
                       result_type=result_type, result_id=result_id)

    async def fail(self, db: AsyncSession, operation: OperationRecord,
                   error: dict[str, Any]) -> OperationRecord:
        now = _now()
        return replace(operation, status="failed", updated_at=now, completed_at=now,
                       error=error)


def operations() -> Operations:
    """FastAPI dependency: how the module creates and finishes operations (seam)."""
    return TransientOperations()
