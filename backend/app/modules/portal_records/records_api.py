"""Patient portal: "My records", the patient's own record as a PDF (getPortalRecordDownloadUrl;
portal.yaml ``/portal/me/record-download-url``; x-owner anand). See records_service.py for the
rules.

Portal routes never use a staff session: ``require_patient`` checks role PAT's
``portal-records:export`` on the portal session, and ``portal_db`` runs as ``shri_portal`` with
the session's patient set (D93). The PDF is built while the request waits (the screen shows
"preparing"). Core writes the export audit row with the patient from the session (x-audit
``patient: session``, ``actor: patient``) with the endpoint's commit; the download it links to
(``downloadPortalFileContent``, api.py) is audited again on its own.
"""
from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import audit_detail
from app.core.deps import PortalPatient, portal_db, require_patient
from app.core.download_tokens import PortalDownloadTokens, portal_download_tokens

from ..encounters.portal_repository import SqlPortalSummaryReads
from ..files.crypto import FileCrypto, file_crypto
from ..files.storage import FileStore, file_store
from ..history.portal_repository import SqlPortalHistoryReads
from ..medications.portal_repository import SqlPortalMedicationReads
from ..scheduling.portal_repository import SqlPortalAppointmentReads
from . import records_service as service
from . import schemas
from .records_repository import ExportWrites, SqlExportWrites, SqlRecordReads
from .repository import SqlLabResultReads

router = APIRouter(tags=["portal"])


def record_readers() -> service.Readers:
    return service.Readers(history=SqlPortalHistoryReads(),
                           medications=SqlPortalMedicationReads(), labs=SqlLabResultReads(),
                           summaries=SqlPortalSummaryReads(),
                           appointments=SqlPortalAppointmentReads(), records=SqlRecordReads())


def export_writes() -> ExportWrites:
    return SqlExportWrites()


@router.get("/portal/me/record-download-url", operation_id="getPortalRecordDownloadUrl",
            response_model=schemas.PortalDownloadUrl, response_model_exclude_none=True)
async def get_portal_record_download_url(
    request: Request,
    patient: Annotated[PortalPatient, Depends(require_patient("portal-records:export"))],
    format: Annotated[Literal["pdf", "fhir-r4"], Query()],
    db: Annotated[AsyncSession, Depends(portal_db)],
    reads: Annotated[service.Readers, Depends(record_readers)],
    writes: Annotated[ExportWrites, Depends(export_writes)],
    store: Annotated[FileStore, Depends(file_store)],
    crypto: Annotated[FileCrypto, Depends(file_crypto)],
    tokens: Annotated[PortalDownloadTokens, Depends(portal_download_tokens)],
) -> schemas.PortalDownloadUrl:
    link = await service.record_download_url(db, reads, writes, store, crypto, tokens, patient,
                                             format)
    audit_detail(request, action="export", reason=f"format {format}")  # never the content
    await db.commit()  # the file's row, its export row and the audit row: all or nothing
    return link
