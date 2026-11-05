"""The after-visit summary's hand-off to Anand's documents module (inventory #86, FRS FR-ENC-06,
D98): this module gathers the visit; his makes the PDF, stores it through the file service and
records it as a DocumentReference (``app.modules.documents.after_visit_summary``, PR #157).

``SummaryStore`` is the shape of #157's two functions, parameter for parameter:

    store(db, file_store, crypto, *, patient_id, encounter_id, note_id, author_practitioner_id,
          details) -> StoredSummary   # renders, seals, stores and records it; never commits
    latest(db, encounter_id) -> StoredSummary | None

``DocumentsSummaryStore`` is the adapter: it converts ``SummaryDetails``/``Medication`` to #157's
``AfterVisitSummaryDetails``/``Medication``, field for field, and calls those two functions.
**#157's module is imported lazily**, inside the adapter's methods, not when this module is
imported, so the encounters module (and the app) still imports where #157 isn't merged; there,
only generating or linking a summary fails. The type checker reads it at the top
(``TYPE_CHECKING``).

``FileServiceLinks`` makes the download link for the stored PDF with the files module's own
service function (``createDownloadUrl``'s): a one-time link to ``GET /files/{fileId}/content``
with core's download token (D105), bound to this user and file. That function runs its own
checks before it signs anything, among them core's restricted-chart check for the patient of the
document the file is attached to (D37), on top of the encounter's own check (D109).
``SummaryOperations`` is core's long-running work (``create_operation``/``finish_operation``), a
seam so the API tests need no database.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.core.deps import CurrentUser
from app.core.download_tokens import DownloadTokens
from app.core.long_running import Operation, create_operation, finish_operation
from app.modules.files import service as files_service
from app.modules.files.crypto import FileCrypto
from app.modules.files.repository import FileRepository
from app.modules.files.storage import FileStore

if TYPE_CHECKING:
    from app.modules.documents import after_visit_summary as documents

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

    async def store(self, db: AsyncSession, file_store: FileStore, crypto: FileCrypto, *,
                    patient_id: UUID, encounter_id: UUID, note_id: UUID,
                    author_practitioner_id: UUID, details: SummaryDetails
                    ) -> StoredSummary: ...

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



def documents_details(details: SummaryDetails) -> documents.AfterVisitSummaryDetails:
    """``details`` as #157's ``AfterVisitSummaryDetails``, field for field."""
    from app.modules.documents import after_visit_summary as documents  # lazy: docstring

    return documents.AfterVisitSummaryDetails(
        practice_name=details.practice_name, patient_name=details.patient_name,
        visit_start=details.visit_start, time_zone=details.time_zone,
        clinician_name=details.clinician_name, facility_name=details.facility_name,
        reason_for_visit=details.reason_for_visit, diagnoses=details.diagnoses,
        medications=tuple(documents.Medication(name=m.name, instructions=m.instructions)
                          for m in details.medications),
        orders=details.orders, instructions=details.instructions,
        follow_up=details.follow_up)


class DocumentsSummaryStore:
    """#157's ``store`` and ``latest`` (``app.modules.documents.after_visit_summary``)."""

    async def store(self, db: AsyncSession, file_store: FileStore, crypto: FileCrypto, *,
                    patient_id: UUID, encounter_id: UUID, note_id: UUID,
                    author_practitioner_id: UUID, details: SummaryDetails) -> StoredSummary:
        from app.modules.documents import after_visit_summary as documents  # lazy: docstring

        return await documents.store(
            db, file_store, crypto, patient_id=patient_id, encounter_id=encounter_id,
            note_id=note_id, author_practitioner_id=author_practitioner_id,
            details=documents_details(details))

    async def latest(self, db: AsyncSession, encounter_id: UUID) -> StoredSummary | None:
        from app.modules.documents import after_visit_summary as documents  # lazy: docstring

        return await documents.latest(db, encounter_id)


class FileServiceLinks:
    """The files module's download link (``createDownloadUrl``'s service function, D105): its
    checks, then core's one-time token. Nothing here signs or builds a token."""

    def __init__(self, request: Request, repo: FileRepository, tokens: DownloadTokens) -> None:
        self._request = request
        self._repo = repo
        self._tokens = tokens

    async def link(self, db: AsyncSession, user: CurrentUser, file_id: UUID) -> SummaryLink:
        issued = await files_service.create_download_url(self._request, db, self._repo,
                                                         self._tokens, user, file_id)
        return SummaryLink(url=issued.link.url, expires_at=issued.link.expires_at)


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
