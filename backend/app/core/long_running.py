"""Long-running work: 202 + operation (API_STANDARDS §13, T26).

    operation = await create_operation(db, "eligibility.check", assigned_to_integration=True)
    ...                                   # the work, or its outbox message (same transaction)
    await db.commit()
    return accepted(operation)            # 202, Location: /api/v1/operations/{id}

    await finish_operation(db, operation_id, "succeeded", result=("eligibility-check", check_id))

- **IDs and status only, never patient data.** `error` is a Problem built from the catalogue
  (errors.py), with no request values.
- **Only its creator sees it** (T26). Anyone else, in this clinic or another, gets 404.
- Finishing publishes `operation.completed` to the creator alone (events.py), in the same
  transaction.
- **Time limits:** an operation still queued or running past its kind's limit is marked failed
  (`upstream-timeout`) when it is next read, so nobody waits for work that died (#52).
- **Cancel:** only the AI kinds; repeating it changes nothing; a finished operation, or a kind
  that can't be cancelled, is 409 with `currentState`.
- Kept 7 days after it finishes (admin.purge_expired_runtime_rows, shri_maintenance). Nothing
  here deletes.
"""

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, FastAPI, Path, Response
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.db import TENANT_ID_INFO_KEY, session_user_id
from app.core.deps import CurrentUser, require, tenant_db
from app.core.errors import CATALOGUE, DEFAULT_TYPE_BASE, Conflict, NotFound
from app.core.events import publish
from app.core.routing import API_PREFIX

KIND = re.compile(r"^[a-z][a-z-]*(\.[a-z][a-z-]*)?$")
FINAL = frozenset({"succeeded", "failed", "cancelled"})
CANCELLABLE_PREFIXES = ("ai.",)  # API_STANDARDS §13: the AI kinds
RETRY_AFTER_SECONDS = "2"
# How long an unfinished operation may take before it is marked failed, per kind.
TIME_LIMITS: dict[str, timedelta] = {
    "eligibility.check": timedelta(minutes=5),
    "file.scan": timedelta(minutes=10),
    "encounter.after-visit-summary": timedelta(minutes=10),
}
DEFAULT_TIME_LIMIT = timedelta(minutes=30)

Final = Literal["succeeded", "failed", "cancelled"]


@dataclass(frozen=True)
class Operation:
    id: UUID
    kind: str
    status: str
    created_by_user_id: UUID
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    result_type: str | None = None
    result_id: UUID | None = None
    error: dict[str, Any] | None = None

    def as_json(self) -> dict[str, Any]:
        """The contract's Operation (camelCase; absent members left out)."""
        body: dict[str, Any] = {"id": str(self.id), "kind": self.kind, "status": self.status,
                                "createdAt": _time(self.created_at),
                                "updatedAt": _time(self.updated_at)}
        if self.completed_at is not None:
            body["completedAt"] = _time(self.completed_at)
        if self.result_type is not None and self.result_id is not None:
            body["result"] = {"type": self.result_type, "id": str(self.result_id)}
        if self.error is not None:
            body["error"] = self.error
        return body

    @property
    def etag(self) -> str:
        version = f"{self.status}:{self.updated_at.isoformat()}".encode()
        return f'"{hashlib.sha256(version).hexdigest()[:16]}"'


def _time(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def problem_body(code: str, detail: str | None = None) -> dict[str, Any]:
    """A Problem for `error`, from the catalogue only (no request values, no patient data)."""
    kind = CATALOGUE[code]
    body: dict[str, Any] = {"type": f"{DEFAULT_TYPE_BASE}{code}",
                            "title": kind.title, "status": kind.status, "code": code}
    if detail:
        body["detail"] = detail
    return body


_COLUMNS = ("id, kind, status, created_by_user_id, created_at, updated_at, completed_at, "
            "result_type, result_id, error")
# The f-strings below add only the fixed column list; every value is a bound parameter.
_INSERT = text(f"INSERT INTO admin.operation (id, tenant_id, created_by_user_id, kind, status, "  # noqa: S608
               f"assigned_to_integration) VALUES (:id, :tenant, :user, :kind, 'queued', :partner) "
               f"RETURNING {_COLUMNS}")
_GET = text(f"SELECT {_COLUMNS} FROM admin.operation WHERE id = :id FOR UPDATE")  # noqa: S608
_SET = text(f"UPDATE admin.operation SET status = :status, result_type = :result_type, "  # noqa: S608
            f"result_id = :result_id, error = CAST(:error AS jsonb), "
            f"completed_at = CASE WHEN :final THEN now() END, updated_at = now(), "
            f"updated_by_user_id = :user WHERE id = :id RETURNING {_COLUMNS}")


def _row(row: Any) -> Operation:
    return Operation(**dict(row._mapping))


async def create_operation(db: AsyncSession, kind: str, *,
                           assigned_to_integration: bool = False) -> Operation:
    """A queued operation for the session's user, in the caller's transaction (no commit).
    `assigned_to_integration`: the partner worker completes it (eligibility, medication history)."""
    if not KIND.fullmatch(kind) or len(kind) > 64:
        raise ValueError(f"operation kind {kind!r} is not family.action")
    tenant_id, user_id = db.info.get(TENANT_ID_INFO_KEY), session_user_id(db)
    if tenant_id is None or user_id is None:
        raise RuntimeError("create_operation() needs a clinic session (tenant_db)")
    row = (await db.execute(_INSERT, {"id": uuid4(), "tenant": tenant_id, "user": user_id,
                                      "kind": kind, "partner": assigned_to_integration})).one()
    return _row(row)


def accepted(operation: Operation) -> JSONResponse:
    """The 202 for work that has started (API_STANDARDS §13)."""
    return JSONResponse(operation.as_json(), status_code=202,
                        headers={"Location": f"{API_PREFIX}/operations/{operation.id}",
                                 "Retry-After": RETRY_AFTER_SECONDS})


async def _set(db: AsyncSession, operation: Operation, status: str,
               result: tuple[str, UUID] | None = None,
               error: dict[str, Any] | None = None) -> Operation:
    row = (await db.execute(_SET, {
        "id": operation.id, "status": status, "final": status in FINAL,
        "result_type": result[0] if result else None, "result_id": result[1] if result else None,
        "error": json.dumps(error) if error else None, "user": session_user_id(db)})).one()
    updated = _row(row)
    if status in FINAL:
        data: dict[str, Any] = {"kind": updated.kind, "status": updated.status}
        if updated.result_type and updated.result_id:
            data |= {"resultType": updated.result_type, "resultId": str(updated.result_id)}
        await publish(db, "operation.completed", f"operation/{updated.id}", data,
                      target_user_id=updated.created_by_user_id)
    return updated


async def _locked(db: AsyncSession, operation_id: UUID) -> Operation | None:
    row = (await db.execute(_GET, {"id": operation_id})).one_or_none()
    return _row(row) if row else None


async def mark_running(db: AsyncSession, operation_id: UUID) -> Operation:
    operation = await _locked(db, operation_id)
    if operation is None:
        raise NotFound()
    if operation.status != "queued":
        raise Conflict(currentState=operation.status)
    return await _set(db, operation, "running")


async def finish_operation(db: AsyncSession, operation_id: UUID, status: Final, *,
                           result: tuple[str, UUID] | None = None,
                           error: dict[str, Any] | None = None) -> Operation:
    """Ends the operation and tells its creator, in the caller's transaction (no commit)."""
    if status == "succeeded" and error is not None:
        raise ValueError("a succeeded operation has no error")
    if status == "failed" and error is None:
        raise ValueError("a failed operation needs its Problem (problem_body)")
    operation = await _locked(db, operation_id)
    if operation is None:
        raise NotFound()
    if operation.status in FINAL:
        raise Conflict(currentState=operation.status)
    return await _set(db, operation, status, result, error)


def _time_limit(kind: str) -> timedelta:
    return TIME_LIMITS.get(kind, DEFAULT_TIME_LIMIT)


async def _own(db: AsyncSession, user: CurrentUser, operation_id: UUID) -> Operation:
    """The user's own operation, timed out if it ran too long; 404 for anyone else's."""
    operation = await _locked(db, operation_id)
    if operation is None or operation.created_by_user_id != user.id:
        raise NotFound()  # the same answer for another user's: it can't be probed (T26)
    if (operation.status not in FINAL
            and datetime.now(UTC) - operation.created_at > _time_limit(operation.kind)):
        operation = await _set(db, operation, "failed", error=problem_body(
            "upstream-timeout", "The work did not finish in time"))
        await db.commit()
    return operation


router = APIRouter(tags=["platform"])
OperationId = Annotated[UUID, Path(alias="operationId")]


def _respond(operation: Operation, response: Response) -> dict[str, Any]:
    response.headers["ETag"] = operation.etag
    if operation.status not in FINAL:
        response.headers["Retry-After"] = RETRY_AFTER_SECONDS
    return operation.as_json()


@router.get("/operations/{operationId}", operation_id="getOperation")
async def get_operation(
    operation_id: OperationId, response: Response,
    user: CurrentUser = Depends(require("authenticated")),
    db: AsyncSession = Depends(tenant_db),
) -> dict[str, Any]:
    return _respond(await _own(db, user, operation_id), response)


@router.post("/operations/{operationId}/cancel", operation_id="cancelOperation")
async def cancel_operation(
    operation_id: OperationId, response: Response,
    user: CurrentUser = Depends(require("authenticated")),
    db: AsyncSession = Depends(tenant_db),
) -> dict[str, Any]:
    operation = await _own(db, user, operation_id)
    if operation.status == "cancelled":
        return _respond(operation, response)  # repeating it changes nothing
    if operation.status in FINAL or not operation.kind.startswith(CANCELLABLE_PREFIXES):
        raise Conflict("This operation can't be cancelled", currentState=operation.status)
    cancelled = await _set(db, operation, "cancelled")
    await db.commit()
    return _respond(cancelled, response)


def register(app: FastAPI, settings: Settings) -> None:
    app.include_router(router, prefix=API_PREFIX)
