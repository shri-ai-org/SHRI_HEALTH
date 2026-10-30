"""The after-visit summary's hand-off to Anand's documents module (inventory #86, FRS FR-ENC-06,
D98): this module gathers the visit; his makes the PDF, stores it through the file service and
records it as a DocumentReference (``app.modules.documents.after_visit_summary``, draft PR #157).

#157 isn't merged, so nothing here imports it. ``SummaryStore`` is the shape of its two
functions, parameter for parameter:

    store(db, file_store, *, patient_id, encounter_id, note_id, author_practitioner_id, details)
        -> StoredSummary          # renders, stores and records it; never commits
    latest(db, encounter_id) -> StoredSummary | None

and ``SummaryDetails``/``Medication`` mirror its ``AfterVisitSummaryDetails``/``Medication``
field for field, so the wiring is a conversion and nothing else. ``SummaryLinks`` makes the
short-lived download link for the stored PDF (the file service's, D105). ``SummaryOperations``
is core's long-running work (``create_operation``/``finish_operation``), a seam so the API tests
need no database.

Until they are wired, ``UnwiredSummaryStore`` and ``UnwiredSummaryLinks`` answer
``503 service-unavailable`` at the moment they are used, so every check before the hand-off
(permission, clinic, facility, restricted chart, state, signed note) still runs for real.

**Wiring left for when #157 merges** (only ``api.summary_store`` and ``api.summary_links``
change):

- ``summary_store()`` returns an adapter whose ``store`` calls
  ``documents.after_visit_summary.store(...)`` with ``details`` converted to its
  ``AfterVisitSummaryDetails`` (``medications`` as its ``Medication``), and whose ``latest`` is
  its ``latest``. Its ``StoredSummary`` (document_id, file_id, generated_at) already fits
  ``StoredSummary`` below.
- ``summary_links()`` returns the file service's link for a stored file (a decrypting
  ``GET /files/{fileId}/content`` link with core's one-time download token, D105), checked as a
  chart read.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import ServiceUnavailable
from app.core.long_running import Operation, create_operation, finish_operation
from app.modules.files.storage import FileStore

#: The core operation kind of createAfterVisitSummary (contract; core's time limit is 10 minutes).
OPERATION_KIND = "encounter.after-visit-summary"
#: What the finished operation's result names (the contract: "the result is a document").
RESULT_TYPE = "document"


@dataclass(frozen=True)
class Medication:
    """#157's ``Medication``."""
    name: str
    instructions: str | None = None


@dataclass(frozen=True)
class SummaryDetails:
    """#157's ``AfterVisitSummaryDetails``, field for field."""
    practice_name: str
    patient_name: str
    visit_start: datetime  # aware
    time_zone: str  # the facility's IANA zone (D40)
    clinician_name: str
    facility_name: str | None = None
    reason_for_visit: str | None = None
    diagnoses: tuple[str, ...] = ()
    medications: tuple[Medication, ...] = ()
    orders: tuple[str, ...] = ()
    instructions: str | None = None  # the note's patient instructions section
    follow_up: str | None = None


class StoredSummary(Protocol):
    """#157's ``StoredSummary`` (a frozen dataclass with these attributes)."""

    @property
    def document_id(self) -> UUID: ...

    @property
    def file_id(self) -> UUID: ...

    @property
    def generated_at(self) -> datetime: ...


class SummaryStore(Protocol):
    """#157's ``store`` and ``latest``."""

    async def store(self, db: AsyncSession, file_store: FileStore, *, patient_id: UUID,
                    encounter_id: UUID, note_id: UUID, author_practitioner_id: UUID,
                    details: SummaryDetails) -> StoredSummary: ...

    async def latest(self, db: AsyncSession, encounter_id: UUID) -> StoredSummary | None: ...


@dataclass(frozen=True)
class SummaryLink:
    url: str
    expires_at: datetime


class SummaryLinks(Protocol):
    async def link(self, db: AsyncSession, user: CurrentUser, file_id: UUID) -> SummaryLink: ...


#: The file store, resolved only when the summary is stored (the file service's dependency
#: answers 503 when no store is configured, which must not hide the checks before it).
FileStoreSource = Callable[[], FileStore]

_NOT_WIRED = "The after-visit summary's document service is not available yet"


class UnwiredSummaryStore:
    """Until #157 is wired: 503 when the summary would be stored or read."""

    async def store(self, db: AsyncSession, file_store: FileStore, *, patient_id: UUID,
                    encounter_id: UUID, note_id: UUID, author_practitioner_id: UUID,
                    details: SummaryDetails) -> StoredSummary:
        raise ServiceUnavailable(_NOT_WIRED)

    async def latest(self, db: AsyncSession, encounter_id: UUID) -> StoredSummary | None:
        raise ServiceUnavailable(_NOT_WIRED)


class UnwiredSummaryLinks:
    """Until the file service's link is wired: 503."""

    async def link(self, db: AsyncSession, user: CurrentUser, file_id: UUID) -> SummaryLink:
        raise ServiceUnavailable(_NOT_WIRED)


class SummaryOperations(Protocol):
    async def start(self, db: AsyncSession) -> Operation: ...

    async def succeed(self, db: AsyncSession, operation: Operation, document_id: UUID
                      ) -> Operation: ...


class CoreSummaryOperations:
    """Core's operations, in the caller's transaction (no commit)."""

    async def start(self, db: AsyncSession) -> Operation:
        return await create_operation(db, OPERATION_KIND)

    async def succeed(self, db: AsyncSession, operation: Operation, document_id: UUID
                      ) -> Operation:
        return await finish_operation(db, operation.id, "succeeded",
                                      result=(RESULT_TYPE, document_id))
