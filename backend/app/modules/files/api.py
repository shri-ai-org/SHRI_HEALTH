"""File service API (contracts/openapi/modules/files.yaml; API_STANDARDS §15).

``createUploadUrl``, ``completeUpload`` and ``createDownloadUrl``. The permission (``require``)
is the first dependency, so a caller without it gets 401 or 403 before anything else is
resolved. Core does the rest of what the contract asks around the endpoints: ``tenant_db``
claims an Idempotency-Key on ``createUploadUrl`` (x-idempotency: supported) and replays a
finished one, and the audit rows (x-audit) commit with the endpoint's changes, or are written
before the response for the download link (category export). The endpoints have no idempotency
or audit code of their own. The rules are in service.py.

The store, the scanner, the encryption and the download tokens are dependencies, each a seam
until its real service exists (storage.py, scanner.py, crypto.py, tokens.py); the operations are
core's (operations.py). Tests override them all.

The decrypting download (service.serve_content, proposed ``GET /files/{fileId}/content`` on
#128) has no route yet: core refuses a route that isn't in the contract's operations map.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, require, tenant_db
from app.core.long_running import accepted

from . import schemas, service
from .crypto import FileCrypto, file_crypto
from .operations import Operations, operations
from .repository import FileRepository, SqlFileRepository
from .scanner import Scanner, scanner
from .storage import FileStore, file_store
from .tokens import DownloadTokens, download_tokens

router = APIRouter(tags=["files"])

def repository() -> FileRepository:
    return SqlFileRepository()


Repo = Annotated[FileRepository, Depends(repository)]
Store = Annotated[FileStore, Depends(file_store)]
DB = Annotated[AsyncSession, Depends(tenant_db)]
FileId = Annotated[UUID, Path(alias="fileId")]


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
    scan: Annotated[Scanner, Depends(scanner)], crypto: Annotated[FileCrypto, Depends(file_crypto)],
    ops: Annotated[Operations, Depends(operations)], db: DB,
) -> JSONResponse:
    operation = await service.complete_upload(db, repo, store, scan, crypto, ops, user, file_id)
    return accepted(operation)  # 202, Location and Retry-After, as core answers


@router.get("/files/{fileId}/download-url", operation_id="createDownloadUrl",
            response_model=schemas.DownloadLink, response_model_exclude_none=True)
async def create_download_url(
    user: Annotated[CurrentUser, Depends(require("files:read"))],
    file_id: FileId, request: Request, repo: Repo, store: Store,
    tokens: Annotated[DownloadTokens, Depends(download_tokens)], db: DB,
) -> schemas.DownloadLink:
    return await service.create_download_url(request, db, repo, store, tokens, user, file_id)
