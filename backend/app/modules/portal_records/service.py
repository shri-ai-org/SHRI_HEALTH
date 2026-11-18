"""The patient portal's file download, ``GET /portal/me/files/{fileId}/content?token=…``
(downloadPortalFileContent; D105, D84, D93).

Core's portal token comes first: genuine, unexpired, unused, and this session patient's, this
file's and this clinic's (core uses it up), or ``404``. Then ``admin.portal_file()`` (0025), as
``shri_portal``, must give the file: a clean after-visit summary of the session patient on a
current, released, non-PSY document with no active hold. Any other file, an imaging one
included, another patient's, a held or preliminary summary, is the same ``404``, so none can be
probed. The file service decrypts and verifies the whole file before the first byte is sent. The
``export`` audit row is core's (x-audit ``patient: session``); this function writes none and never
commits.
"""
from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient
from app.core.download_tokens import PortalDownloadTokens
from app.core.errors import NotFound

from ..files.crypto import FileCrypto
from ..files.service import FileContent, chunks, decrypted
from ..files.storage import FileStore
from .repository import PortalFileReads


async def serve_file(db: AsyncSession, reads: PortalFileReads, store: FileStore,
                     crypto: FileCrypto, tokens: PortalDownloadTokens, patient: PortalPatient,
                     file_id: UUID, token: str) -> FileContent:
    claims = tokens.verify(token, patient_id=patient.patient_id, file_id=file_id,
                           tenant_id=patient.organization_id)
    if claims is None:
        raise NotFound("File not found")
    file = await reads.file(db, file_id)
    if file is None:
        raise NotFound("File not found")
    plain = await decrypted(store, crypto, file.id, file.storage_key, file.wrapped_data_key)
    return FileContent(file_id=file.id, purpose=file.purpose, content_type=file.content_type,
                       size_bytes=len(plain), patient_ids=frozenset({patient.patient_id}),
                       body=chunks(plain))
