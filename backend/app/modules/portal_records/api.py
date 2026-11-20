"""Patient portal: the patient's own lab results (listPortalLabResults) and the file download
(downloadPortalFileContent); portal.yaml, x-owner anand; D83, D84, D86, D90, D93, D105, Q32.

Portal routes never use a staff session: ``require_patient`` checks role PAT's permission on the
portal session, and ``portal_db`` reads as ``shri_portal`` with the session's patient set, so
another patient's results simply don't exist here. Core writes the ``phi-read`` audit row with
the patient from the session (x-audit ``patient: session``, ``actor: patient``).
"""
from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient, portal_db, require_patient
from app.core.download_tokens import PortalDownloadTokens, portal_download_tokens

from ..files.crypto import FileCrypto, file_crypto
from ..files.storage import FileStore, file_store
from ..history.service import decode_cursor, encode_cursor
from . import schemas, service
from .repository import LabResultReads, PortalFileReads, SqlLabResultReads, SqlPortalFileReads

router = APIRouter(tags=["portal"])


def lab_results_reads() -> LabResultReads:
    return SqlLabResultReads()


def portal_file_reads() -> PortalFileReads:
    return SqlPortalFileReads()


DB = Annotated[AsyncSession, Depends(portal_db)]
Reads = Annotated[LabResultReads, Depends(lab_results_reads)]
Patient = Annotated[PortalPatient, Depends(require_patient("portal-records:read"))]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


@router.get("/portal/me/lab-results", operation_id="listPortalLabResults",
            response_model=schemas.LabResultList, response_model_exclude_none=True)
async def list_portal_lab_results(patient: Patient, db: DB, reads: Reads, limit: Limit = 25,
                                  cursor: Cursor = None) -> schemas.LabResultList:
    offset = decode_cursor(cursor)
    found = await reads.lab_results(db, patient.patient_id, limit=limit + 1, offset=offset)
    if len(found) > limit:
        return schemas.LabResultList(items=found[:limit], next_cursor=encode_cursor(offset + limit))
    return schemas.LabResultList(items=found)


@router.get("/portal/me/files/{fileId}/content", operation_id="downloadPortalFileContent",
            response_class=StreamingResponse)
async def download_portal_file_content(
    patient: Annotated[PortalPatient, Depends(require_patient("authenticated"))],
    file_id: Annotated[UUID, Path(alias="fileId")],
    token: Annotated[str, Query(min_length=32, max_length=512, pattern=r"^[A-Za-z0-9_-]+$")],
    db: DB, files: Annotated[PortalFileReads, Depends(portal_file_reads)],
    store: Annotated[FileStore, Depends(file_store)],
    crypto: Annotated[FileCrypto, Depends(file_crypto)],
    tokens: Annotated[PortalDownloadTokens, Depends(portal_download_tokens)],
) -> StreamingResponse:
    """Only a clean after-visit summary of the session patient's (``service.serve_file``);
    anything else, the same 404."""
    content = await service.serve_file(db, files, store, crypto, tokens, patient, file_id, token)
    return StreamingResponse(content.body, media_type=content.content_type,
                             headers=content.headers)


# Secure messages (#398; messages_api.py), on this module's router.
from .messages_api import router as _messages_router  # noqa: E402 (after this module's routes)

router.include_router(_messages_router)
