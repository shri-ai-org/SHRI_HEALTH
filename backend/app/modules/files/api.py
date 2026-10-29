"""File service API (contracts/openapi/modules/files.yaml; API_STANDARDS §15).

``createUploadUrl``, ``completeUpload``, ``createDownloadUrl`` and ``downloadFileContent``
(D105). The permission (``require``)
is the first dependency, so a caller without it gets 401 or 403 before anything else is
resolved. Core does the rest of what the contract asks around the endpoints: ``tenant_db``
claims an Idempotency-Key on ``createUploadUrl`` (x-idempotency: supported) and replays a
finished one, and the audit rows (x-audit) commit with the endpoint's changes, or are written
before the response for the download link (category export). The endpoints have no idempotency
or audit code of their own. The rules are in service.py.

The store, the scanner and the encryption are dependencies (storage.py, scanner.py,
crypto.py); the operations and the download tokens are core's (operations.py,
``app.core.download_tokens``). Tests override them all.

``downloadFileContent`` serves a file only through its one-time link: the token, and the same
user's session (``require("authenticated")``). It reports the file's patients for its audit row
(x-audit ``patient: result``); core keeps the query string, with its token, out of the logs.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.deps import CurrentUser, require, tenant_db
from app.core.download_tokens import DownloadTokens, download_tokens
from app.core.long_running import accepted

from . import schemas, service
from .crypto import FileCrypto, file_crypto
from .operations import Operations, operations
from .repository import FileRepository, SqlFileRepository
from .scanner import Scanner, scanner
from .storage import FileStore, file_store

router = APIRouter(tags=["files"])


def repository() -> FileRepository:
    return SqlFileRepository()


Repo = Annotated[FileRepository, Depends(repository)]
Store = Annotated[FileStore, Depends(file_store)]
DB = Annotated[AsyncSession, Depends(tenant_db)]
FileId = Annotated[UUID, Path(alias="fileId")]
Crypto = Annotated[FileCrypto, Depends(file_crypto)]
PatientAudit = Callable[[Request, Iterable[UUID]], None]


def patient_audit() -> PatientAudit:
    """FastAPI dependency: core's ``audit_patients``, naming the patients on the audit row."""
    return audit.audit_patients


Tokens = Annotated[DownloadTokens, Depends(download_tokens)]


@router.post("/files/upload-url", operation_id="createUploadUrl",
             status_code=status.HTTP_201_CREATED, response_model=schemas.UploadTicket,
             response_model_exclude_none=True)
async def create_upload_url(
    user: Annotated[CurrentUser, Depends(require("files:create"))],
    body: schemas.UploadUrlRequest, repo: Repo, store: Store, db: DB,
) -> schemas.UploadTicket:
    return await service.create_upload_url(db, repo, store, user, body)


@router.post("/files/{fileId}/complete", operation_id="completeUpload",
             status_code=status.HTTP_202_ACCEPTED, response_class=JSONResponse)
async def complete_upload(
    user: Annotated[CurrentUser, Depends(require("files:create"))],
    file_id: FileId, repo: Repo, store: Store,
    scan: Annotated[Scanner, Depends(scanner)], crypto: Crypto,
    ops: Annotated[Operations, Depends(operations)], db: DB,
) -> JSONResponse:
    operation = await service.complete_upload(db, repo, store, scan, crypto, ops, user, file_id)
    return accepted(operation)  # 202, Location and Retry-After, as core answers


@router.get("/files/{fileId}/download-url", operation_id="createDownloadUrl",
            response_model=schemas.DownloadLink, response_model_exclude_none=True)
async def create_download_url(
    user: Annotated[CurrentUser, Depends(require("files:read"))],
    file_id: FileId, request: Request, repo: Repo, tokens: Tokens, db: DB,
) -> schemas.DownloadLink:
    return await service.create_download_url(request, db, repo, tokens, user, file_id)


@router.get("/files/{fileId}/content", operation_id="downloadFileContent",
            response_class=StreamingResponse)
async def download_file_content(
    user: Annotated[CurrentUser, Depends(require("authenticated"))],
    file_id: FileId,
    token: Annotated[str, Query(min_length=32, max_length=512, pattern=r"^[A-Za-z0-9_.-]+$")],
    request: Request, repo: Repo, store: Store, crypto: Crypto, tokens: Tokens,
    audit_patients: Annotated[PatientAudit, Depends(patient_audit)], db: DB,
) -> StreamingResponse:
    content = await service.serve_content(request, db, repo, store, crypto, tokens, user,
                                          file_id, token)
    audit_patients(request, sorted(content.patient_ids))
    return StreamingResponse(content.body, media_type=content.content_type,
                             headers=content.headers)
