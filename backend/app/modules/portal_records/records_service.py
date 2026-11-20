"""The patient's "My records" download, ``GET /portal/me/record-download-url?format=pdf``
(getPortalRecordDownloadUrl; D86, D90, D105; Anand's design, go on 20 Nov).

1. **Format.** ``pdf`` only in this round: ``fhir-r4`` is ``422 validation-failed`` naming the
   query parameter ``format`` (``not-allowed-value``) until the bundle is built.
2. **Build, on request.** In the portal session (``shri_portal``, own chart only), the same reads
   as the portal's pages (records_repository), rendered in memory (records_pdf). It holds what
   the portal shows and nothing more: held, draft, entered-in-error, PSY-labelled and non-final
   items are hidden by the policies, and no note, inbox item or staff-only text is read. Visits
   are the portal's own past appointments (scheduling's ``listPortalAppointments`` read), less
   any whose appointment or encounter is labelled PSY, R or V, which leave no trace at all.
3. **Size limit.** Allergies, problems and current medications are always listed in full. Every
   other section holds at most ``SECTION_LIMIT`` (100) items, the newest, and the PDF says when
   one was cut (Anand on #480). A PDF over ``MAX_PDF_BYTES`` (4 MiB) is refused with ``422
   business-rule-violation`` naming ``format`` (``out-of-range``), and nothing is stored.
4. **Store.** The file service's envelope encryption (a fresh data key, wrapped by core) under
   ``<clinic>/<file>`` in the clean bucket, then ``admin.portal_record_export()`` (0032) records
   the file (purpose ``export``) and its export row, served for 15 minutes and purged 24 hours
   after that. If the record is refused, the stored bytes are removed again. More than 10
   exports in an hour is ``429 rate-limited``.
5. **Link.** Core's portal token (#409): one minute, single use, bound to this patient, this
   file and this clinic, to ``GET /portal/me/files/{fileId}/content``.

Core writes the request's audit row from x-audit (export, patient from the session) with the
endpoint's commit, and the format as its reason. Never the content, the file name or the token
in any log, event or audit row. The caller commits; this never does.
"""
from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlencode
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient
from app.core.download_tokens import PortalDownloadTokens
from app.core.errors import AppError, InternalError, NotFound, ValidationFailed, field_error

from ..encounters.portal_repository import PortalSummaryReads
from ..files.crypto import FileCrypto
from ..files.storage import CLEAN_BUCKET, FileStore, storage_key
from ..history.portal_repository import PortalHistoryReads
from ..medications.portal_repository import PortalMedicationReads
from ..scheduling.portal_repository import PortalAppointmentReads
from . import records_pdf, schemas
from .records_pdf import Section, Summary
from .records_repository import ExportWrites, RecordReads, Refused, Visit
from .repository import LabResultReads

SECTION_LIMIT = 100
MAX_PDF_BYTES = 4 * 1024 * 1024
#: The page size for the sections that are never cut (allergies, problems, medications) and for
#: the visits, which are filtered after the read.
PAGE = 100
#: Past appointments that are not visits: never kept, or called off.
NOT_A_VISIT = frozenset({"cancelled", "noshow"})
VITALS_WINDOW = timedelta(days=366)
FORMATS = ("pdf", "fhir-r4")
#: The function's per-patient limit window (0032), for the client's Retry-After.
RETRY_AFTER_SECONDS = 3600
ACTIVE_PROBLEM = frozenset({"active", "recurrence", "relapse"})


class TooManyExports(AppError):
    default_code = "rate-limited"


@dataclass(frozen=True)
class Readers:
    """The portal pages' own readers, and this module's."""
    history: PortalHistoryReads
    medications: PortalMedicationReads
    labs: LabResultReads
    summaries: PortalSummaryReads
    appointments: PortalAppointmentReads
    records: RecordReads


def _cut(found: list[object]) -> Section:
    return Section(found[:SECTION_LIMIT], truncated=len(found) > SECTION_LIMIT)


async def _every[T](read: Callable[[int, int], Awaitable[list[T]]]) -> list[T]:
    """Every row of a paged read, page by page: for the sections that are never cut."""
    out: list[T] = []
    while True:
        page = await read(PAGE, len(out))
        out += page
        if len(page) < PAGE:
            return out


async def _visits(db: AsyncSession, reads: Readers, me: UUID, now: datetime
                  ) -> list[object]:
    """The patient's past visits as the portal's appointment list shows them, newest first, less
    the PSY, R or V labelled ones; up to one more than a section holds, to know it was cut."""
    out: list[object] = []
    offset = 0
    while len(out) <= SECTION_LIMIT:
        page = await reads.appointments.list(db, me, upcoming=False, now=now, limit=PAGE,
                                             offset=offset)
        offset += len(page)
        kept = [a for a in page if a.status not in NOT_A_VISIT]
        hidden = await reads.records.hidden_visits(db, [a.id for a in kept])
        out += [Visit(started_at=a.start, time_zone=a.time_zone, clinician=a.provider_name,
                      reasons=[a.reason] if a.reason else [])
                for a in kept if a.id not in hidden]
        if len(page) < PAGE:
            break
    return out


async def gather(db: AsyncSession, reads: Readers, patient: PortalPatient) -> Summary:
    """What the PDF shows, read as shri_portal for the session patient only."""
    me = patient.patient_id
    now = (await db.execute(text("SELECT now()"))).scalar_one()
    header = await reads.records.header(db, me)
    allergies = await _every(lambda limit, offset: reads.history.allergies(
        db, me, allergy_id=None, limit=limit, offset=offset))
    problems = [p for p in await _every(lambda limit, offset: reads.history.problems(
        db, me, problem_id=None, limit=limit, offset=offset))
        if p.release_status == "available" and p.clinical_status in ACTIVE_PROBLEM]
    medications = [m for m in await _every(lambda limit, offset: reads.medications.medications(
        db, me, limit=limit, offset=offset)) if m.status == "active"]
    # Each summary dated in its visit's facility time zone, as the portal's list dates it (D40).
    summaries = [records_pdf.VisitSummary(s.visit_start, s.time_zone) for s in sorted(
        await reads.summaries.released(db, me), key=lambda s: s.visit_start, reverse=True)]
    more = SECTION_LIMIT + 1
    return Summary(
        header=header, generated_at=now, limit=SECTION_LIMIT,
        allergies=Section(list(allergies)), problems=Section(list(problems)),
        medications=Section(list(medications)),
        immunizations=_cut(list(await reads.records.immunizations(db, me, limit=more))),
        vitals=_cut(list(await reads.history.vitals(
            db, me, vital_type=None, date_from=(now - VITALS_WINDOW).date(), date_to=None,
            limit=more, offset=0))),
        lab_results=_cut(list(await reads.labs.lab_results(db, me, limit=more, offset=0))),
        imaging=_cut(list(await reads.records.imaging_reports(db, me, limit=more))),
        visits=_cut(await _visits(db, reads, me, now)),
        visit_summaries=_cut(list(summaries)))


def _refusal(refused: Refused) -> AppError:
    match refused.reason:
        case "portal_record_export_rate_limited":
            return TooManyExports("Too many record downloads; try again later",
                                  headers={"Retry-After": str(RETRY_AFTER_SECONDS)})
        case "not-found":  # no session patient: never for a signed-in patient
            return NotFound()
        case _:  # portal_record_export_format or _file: our own bug, never the patient's
            return InternalError()


async def record_download_url(db: AsyncSession, reads: Readers, writes: ExportWrites,
                              store: FileStore, crypto: FileCrypto,
                              tokens: PortalDownloadTokens, patient: PortalPatient,
                              format: str) -> schemas.PortalDownloadUrl:
    if format != "pdf":
        raise ValidationFailed("Only the PDF summary can be downloaded for now",
                               errors=[field_error("query", "format", "not-allowed-value")])
    data = records_pdf.render(await gather(db, reads, patient))
    if len(data) > MAX_PDF_BYTES:
        raise ValidationFailed("The record is too large to download as one file; contact your "
                               "clinic for a copy", code="business-rule-violation",
                               errors=[field_error("query", "format", "out-of-range")])
    file_id = uuid4()
    key = storage_key(patient.organization_id, file_id)
    sealed = await crypto.seal(data, context=key)  # no key service: 503, nothing written
    await store.put(key, sealed.data, records_pdf.CONTENT_TYPE, bucket=CLEAN_BUCKET)
    try:
        await writes.record(db, file_id=file_id, format=format, storage_key=key,
                            wrapped_data_key=sealed.wrapped_data_key, size_bytes=len(data),
                            sha256=hashlib.sha256(data).hexdigest())
    except Refused as refused:
        await store.delete(key, bucket=CLEAN_BUCKET)
        raise _refusal(refused) from None
    except Exception:
        await store.delete(key, bucket=CLEAN_BUCKET)
        raise
    claims = tokens.claims(file_id, patient.patient_id, patient.organization_id)
    token = tokens.sign(claims)
    return schemas.PortalDownloadUrl(
        url=f"/api/v1/portal/me/files/{file_id}/content?{urlencode({'token': token})}",
        expires_at=claims.expires_at)
