"""Rules for the patient portal's visit summaries (B8a, D84, D86, D90; inventory #278, #279).

- **Own record only (D84):** the patient is the portal session's. A summary ID that isn't the
  session patient's is 404, as one that doesn't exist (``deps.require_own_record``), on top of
  the shri_portal policies (D93).
- **Released only (D86):** drafts, entered-in-error and psychotherapy documents never appear
  (the database hides them from shri_portal). A **held** summary (D90) is listed as ``held``
  with its ID and date only: no provider, facility or ``availableAt``, never the reason.
  ``admin.portal_held_items()`` doesn't say which kind of document is held, so every held
  DocumentReference of the patient is listed here until it does (no other portal list shows
  documents before B8b). Its date is the document's, in the practice's time zone.
- **Order:** newest first, by visit date (a held one by its document date), then ID.
- **visitDate** is the visit's start in the facility's time zone (D40).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from app.core.deps import PortalPatient, require_own_record
from app.modules.scheduling.portal_service import own_rows
from app.modules.scheduling.service import decode_cursor, encode_cursor

from . import portal_schemas as ps
from .portal_repository import HeldRow, SummaryRow
from .portal_repository import PortalSummaryReads as Reads

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _local_date(moment: datetime, zone: str) -> Any:
    return moment.astimezone(ZoneInfo(zone)).date()


def _available(row: SummaryRow, names: dict[UUID, str]) -> tuple[datetime, ps.PortalVisitSummary]:
    return row.visit_start, ps.PortalVisitSummary(
        id=row.id, visit_date=_local_date(row.visit_start, row.time_zone),
        provider_display_name=names.get(row.provider_id) if row.provider_id else None,
        facility_name=row.facility_name, release_status="available",
        available_at=row.available_at)


def _held(row: HeldRow, zone: str) -> tuple[datetime, ps.PortalVisitSummary]:
    when = row.date or _EPOCH
    return when, ps.PortalVisitSummary(id=row.id, visit_date=_local_date(when, zone),
                                       release_status="held")


async def _all(db: Any, reads: Reads, patient: PortalPatient) -> list[ps.PortalVisitSummary]:
    released = own_rows(patient, await reads.released(db, patient.patient_id))
    held = await reads.held(db)
    zone = await reads.practice_time_zone(db) if held else "UTC"
    names = await reads.provider_names(
        db, [r.provider_id for r in released if r.provider_id is not None])
    shown = {r.id for r in released}
    keyed = [_available(r, names) for r in released] + [
        _held(h, zone) for h in held if h.id not in shown]
    keyed.sort(key=lambda k: (k[0], str(k[1].id)), reverse=True)
    return [summary for _, summary in keyed]


async def list_mine(db: Any, reads: Reads, patient: PortalPatient, *, limit: int,
                    cursor: str | None) -> ps.PortalVisitSummaryList:
    offset = decode_cursor(cursor)
    items = await _all(db, reads, patient)
    end = offset + limit
    return ps.PortalVisitSummaryList(
        items=items[offset:end], next_cursor=encode_cursor(end) if len(items) > end else None)


async def one(db: Any, reads: Reads, patient: PortalPatient, summary_id: UUID
              ) -> ps.PortalVisitSummary:
    found = next((s for s in await _all(db, reads, patient) if s.id == summary_id), None)
    # Every item _all returns is the session patient's (released rows by own_rows; held items
    # come from portal_held_items(), which reads only the session patient's holds).
    if found is None:
        require_own_record(patient, None)  # 404, as for another patient's record (D84)
        raise AssertionError("unreachable")
    return found
