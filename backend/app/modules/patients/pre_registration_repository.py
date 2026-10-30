"""Data for online pre-registration (D96), in Anand's ``admin.pre_registration`` (migration 0009,
#101).

The public form writes only through ``admin.submit_pre_registration(...)``, called as
``shri_public``: the function finds the clinic from the practice's code, stores the request and
its ``anonymous`` audit row in one call, and returns nothing, so no ID or row reaches the caller.
The staff queue reads and decides under the request's own session as ``shri_app`` (forced RLS:
another clinic's request is simply not found). ``details`` holds the submission with each
top-level value encrypted (``public_form.FieldCipher``); the keys stay readable for the table's
shape check.
"""

from __future__ import annotations

import ipaddress
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound


class UnknownPracticeLink(Exception):
    """No practice takes pre-registrations with this code (unknown, turned off, inactive)."""


class IdempotencyKeyReused(Exception):
    """The Idempotency-Key was used with a different body."""


@dataclass(frozen=True)
class PreRegistrationRow:
    id: UUID
    status: str
    details: dict[str, Any]  # each value encrypted
    submitted_at: datetime
    decided_at: datetime | None = None
    decided_by: UUID | None = None
    patient_id: UUID | None = None
    id_document_type: str | None = None
    rejection_reason_code: str | None = None
    rejection_reason_text: str | None = None


@dataclass(frozen=True)
class Submission:
    practice_code: str
    idempotency_key: UUID
    request_hash: str
    details: dict[str, Any]  # each value encrypted
    source_ip: str | None
    user_agent: str | None
    correlation_id: str | None


class PreRegistrationRepository(Protocol):
    async def submit(self, db: AsyncSession, submission: Submission) -> None:
        """Raises UnknownPracticeLink or IdempotencyKeyReused; a replay changes nothing."""
        ...

    async def list(self, db: AsyncSession, status: str, *, limit: int, offset: int
                   ) -> list[PreRegistrationRow]:
        """Oldest first."""
        ...

    async def get(self, db: AsyncSession, pre_registration_id: UUID, *, lock: bool = False
                  ) -> PreRegistrationRow:
        """NotFound (404) if the clinic has no such request. ``lock`` holds the row until commit."""
        ...

    async def accept(self, db: AsyncSession, pre_registration_id: UUID, *, user_id: UUID,
                     patient_id: UUID, id_document_type: str) -> None: ...

    async def reject(self, db: AsyncSession, pre_registration_id: UUID, *, user_id: UUID,
                     reason_code: str, reason_text: str | None) -> None: ...


def _inet(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None  # e.g. a test client's host name: no address to record


def _sqlstate(error: DBAPIError) -> tuple[str | None, str | None]:
    cause = getattr(error.orig, "__cause__", None)
    state = getattr(error.orig, "pgcode", None) or getattr(cause, "sqlstate", None)
    return state, getattr(cause, "constraint_name", None)


_COLUMNS = """id, status, details, created_at, decided_at, decided_by_user_id, patient_id,
              id_document_type, rejection_reason_code, rejection_reason_text"""


def _row(r: Any) -> PreRegistrationRow:
    details = r.details if isinstance(r.details, dict) else json.loads(r.details)
    return PreRegistrationRow(
        id=r.id, status=r.status, details=details, submitted_at=r.created_at,
        decided_at=r.decided_at, decided_by=r.decided_by_user_id, patient_id=r.patient_id,
        id_document_type=r.id_document_type, rejection_reason_code=r.rejection_reason_code,
        rejection_reason_text=r.rejection_reason_text)


class SqlPreRegistrationRepository:
    async def submit(self, db: AsyncSession, submission: Submission) -> None:
        try:
            await db.execute(text(
                "SELECT admin.submit_pre_registration(:code, :key, :hash, CAST(:details AS jsonb), "
                "true, CAST(:ip AS inet), :ua, :cid)"), {
                    "code": submission.practice_code, "key": submission.idempotency_key,
                    "hash": submission.request_hash, "details": json.dumps(submission.details),
                    "ip": _inet(submission.source_ip), "ua": submission.user_agent,
                    "cid": submission.correlation_id})
        except DBAPIError as error:
            await db.rollback()
            state, constraint = _sqlstate(error)
            if state == "P0002":
                raise UnknownPracticeLink() from error
            if state == "P0001" and constraint == "idempotency_key_reused":
                raise IdempotencyKeyReused() from error
            raise
        await db.commit()

    async def list(self, db: AsyncSession, status: str, *, limit: int, offset: int
                   ) -> list[PreRegistrationRow]:
        found = await db.execute(text(
            f"SELECT {_COLUMNS} FROM admin.pre_registration WHERE status = :status "  # noqa: S608
            "ORDER BY created_at, id LIMIT :limit OFFSET :offset"),
            {"status": status, "limit": limit, "offset": offset})
        return [_row(r) for r in found]

    async def get(self, db: AsyncSession, pre_registration_id: UUID, *, lock: bool = False
                  ) -> PreRegistrationRow:
        found = (await db.execute(text(
            f"SELECT {_COLUMNS} FROM admin.pre_registration WHERE id = :id"  # noqa: S608
            + (" FOR UPDATE" if lock else "")), {"id": pre_registration_id})).one_or_none()
        if found is None:
            raise NotFound()
        return _row(found)

    async def accept(self, db: AsyncSession, pre_registration_id: UUID, *, user_id: UUID,
                     patient_id: UUID, id_document_type: str) -> None:
        await db.execute(text(
            "UPDATE admin.pre_registration SET status = 'accepted', decided_at = now(), "
            "decided_by_user_id = :user, patient_id = :patient, id_document_type = :doc, "
            "updated_at = now(), updated_by_user_id = :user WHERE id = :id"),
            {"id": pre_registration_id, "user": user_id, "patient": patient_id,
             "doc": id_document_type})

    async def reject(self, db: AsyncSession, pre_registration_id: UUID, *, user_id: UUID,
                     reason_code: str, reason_text: str | None) -> None:
        await db.execute(text(
            "UPDATE admin.pre_registration SET status = 'rejected', decided_at = now(), "
            "decided_by_user_id = :user, rejection_reason_code = :code, "
            "rejection_reason_text = :reason, updated_at = now(), updated_by_user_id = :user "
            "WHERE id = :id"),
            {"id": pre_registration_id, "user": user_id, "code": reason_code,
             "reason": reason_text})
