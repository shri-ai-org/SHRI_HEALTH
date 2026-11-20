"""The reads and the one write behind "My records" (getPortalRecordDownloadUrl; D86, D90, D93,
D105; migration 0032), in core's ``portal_db`` session: role ``shri_portal`` with the session's
patient set.

**The same reads as the portal's pages.** The sections the portal already shows are read by the
pages' own readers (history's allergies, problems and vitals, medications' list, this module's
lab results, encounters' visit summaries), so the PDF holds exactly what those pages show. The
rest are read here, under the same own-chart policies: the clinic's name and time zone
(``admin.portal_clinic()``, 0032: shri_portal has no privilege on ``admin.tenant``), the
patient's name, date of birth and chart number, immunizations and imaging reports (the report
text only). Visits are the portal's own past appointments (``scheduling.portal_repository``);
this module only says which of them carry a PSY, R or V label, on the appointment or its
encounter, so the PDF leaves them out entirely. The policies hide held, draft, entered-in-error,
PSY-labelled and non-final records (0011, 0022), and each query names the session patient too,
so the rule holds twice. No note, inbox item or staff-only text is read.

**The write.** ``admin.portal_record_export()`` (0032) records the file the service has just
encrypted and stored, with the clinic and patient from the session; shri_portal has no privilege
on ``admin.binary_object`` or ``admin.portal_record_export``. A refusal comes back as
``Refused`` with the function's constraint name (or ``not-found``). Nothing here logs record
content.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.errors import db_error_detail
from app.db.models import systems

from .repository import V2_0074

V2_0203 = systems.V2_0203


class Refused(Exception):
    """A function's refusal: ``reason`` is its constraint name, or ``not-found`` (P0002)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Header:
    clinic_name: str
    time_zone: str
    patient_name: str
    birth_date: date | None
    chart_number: str | None


@dataclass(frozen=True)
class Immunization:
    display: str
    occurred_at: datetime | None
    occurred_text: str | None


@dataclass(frozen=True)
class ImagingReport:
    display: str
    status: str
    effective_at: datetime | None
    issued_at: datetime | None
    text: list[str] = field(default_factory=list)  # technique and findings, then impression


@dataclass(frozen=True)
class Visit:
    started_at: datetime
    time_zone: str | None
    clinician: str | None
    reasons: list[str]


_CLINIC = text("SELECT name, timezone FROM admin.portal_clinic()")
_PATIENT = text("""
SELECT p.birth_date,
       (SELECT nullif(concat_ws(' ', array_to_string(n.given, ' '), n.family), '')
          FROM clinical.human_name n
         WHERE n.patient_id = p.id AND coalesce(n.use, 'usual') NOT IN ('old', 'maiden')
         ORDER BY (n.use = 'official') DESC, (n.use = 'usual') DESC, n.created_at, n.id
         LIMIT 1) AS name,
       (SELECT i.value FROM clinical.identifier i
         WHERE i.patient_id = p.id AND i.type_system = :v2_0203 AND i.type_code = 'MR'
         ORDER BY i.created_at, i.id LIMIT 1) AS mrn
FROM clinical.patient p WHERE p.id = :patient
""")
# A completed immunization only: never not-done, and the policy hides draft and entered-in-error.
_IMMUNIZATIONS = text("""
SELECT coalesce(m.vaccine_code_text, m.vaccine_code_display) AS display,
       m.occurrence_date_time, m.occurrence_string
FROM clinical.immunization m
WHERE m.patient_id = :patient AND m.status = 'completed'
ORDER BY m.occurrence_date_time DESC NULLS LAST, m.id
LIMIT :limit
""")
# Imaging reports (v2-0074 RAD) the policy shows: final, amended, corrected or appended and not
# held. The text is the report's narrative observations, then its impression; never an image.
_IMAGING = text("""
SELECT r.id, coalesce(r.code_text, r.code_display) AS display, r.status::text AS status,
       r.effective_date_time, r.issued, r.conclusion
FROM clinical.diagnostic_report r
WHERE r.subject_patient_id = :patient AND r.status IN ('final', 'amended', 'corrected', 'appended')
  AND EXISTS (SELECT 1 FROM clinical.diagnostic_report_category c
               WHERE c.diagnostic_report_id = r.id AND c.category_system = :system
                 AND c.category_code = 'RAD')
ORDER BY r.effective_date_time DESC NULLS LAST, r.issued DESC NULLS LAST, r.id
LIMIT :limit
""")
_IMAGING_TEXT = text("""
SELECT l.diagnostic_report_id, o.value_string
FROM clinical.diagnostic_report_result l
JOIN clinical.observation o ON o.id = l.observation_id
WHERE l.diagnostic_report_id = ANY(:reports) AND o.subject_patient_id = :patient
  AND o.status IN ('final', 'amended', 'corrected') AND o.value_string IS NOT NULL
ORDER BY l.diagnostic_report_id, l.sequence, o.id
""")
# The visits the PDF must leave out entirely (Anand on #480): an appointment, or the encounter
# made from it, labelled psychotherapy (PSY) or restricted (R, V). No date, clinician or reason.
HIDDEN_LABELS = ("PSY", "R", "V")
_HIDDEN_VISITS = text("""
SELECT a.id FROM clinical.appointment a
WHERE a.id = ANY(:ids)
  AND (a.meta_security && CAST(:labels AS varchar[])
       OR EXISTS (SELECT 1 FROM clinical.encounter e
                   WHERE e.appointment_id = a.id
                     AND e.meta_security && CAST(:labels AS varchar[])))
""")
_RECORD = text("SELECT admin.portal_record_export(:file, :format, :key, :wrapped, :size, :sha)")


class RecordReads(Protocol):
    async def header(self, db: AsyncSession, patient_id: UUID) -> Header: ...

    async def immunizations(self, db: AsyncSession, patient_id: UUID, *, limit: int
                            ) -> list[Immunization]: ...

    async def imaging_reports(self, db: AsyncSession, patient_id: UUID, *, limit: int
                              ) -> list[ImagingReport]: ...

    async def hidden_visits(self, db: AsyncSession, appointment_ids: list[UUID]
                            ) -> set[UUID]:
        """Those of these appointments the PDF never shows (``HIDDEN_LABELS``)."""
        ...


class ExportWrites(Protocol):
    async def record(self, db: AsyncSession, *, file_id: UUID, format: str, storage_key: str,
                     wrapped_data_key: str, size_bytes: int, sha256: str) -> datetime:
        """Records the stored export; returns when it stops being served (15 minutes)."""
        ...


class SqlRecordReads:
    async def header(self, db: AsyncSession, patient_id: UUID) -> Header:
        clinic = (await db.execute(_CLINIC)).one_or_none()
        me = (await db.execute(_PATIENT, {"patient": patient_id, "v2_0203": V2_0203})
              ).one_or_none()
        return Header(clinic_name=(clinic.name if clinic else None) or "Your clinic",
                      time_zone=(clinic.timezone if clinic else None) or "UTC",
                      patient_name=(me.name if me else None) or "Patient",
                      birth_date=me.birth_date if me else None,
                      chart_number=me.mrn if me else None)

    async def immunizations(self, db: AsyncSession, patient_id: UUID, *, limit: int
                            ) -> list[Immunization]:
        rows = await db.execute(_IMMUNIZATIONS, {"patient": patient_id, "limit": limit})
        return [Immunization(r.display or "Immunization", r.occurrence_date_time,
                             r.occurrence_string) for r in rows]

    async def imaging_reports(self, db: AsyncSession, patient_id: UUID, *, limit: int
                              ) -> list[ImagingReport]:
        reports = list((await db.execute(_IMAGING, {
            "patient": patient_id, "system": V2_0074, "limit": limit})).mappings())
        texts: dict[UUID, list[str]] = {}
        if reports:
            for row in await db.execute(_IMAGING_TEXT, {
                    "reports": [r["id"] for r in reports], "patient": patient_id}):
                texts.setdefault(row.diagnostic_report_id, []).append(row.value_string)
        return [ImagingReport(
            display=r["display"] or "Imaging report", status=r["status"],
            effective_at=r["effective_date_time"], issued_at=r["issued"],
            text=texts.get(r["id"], []) + ([f"Impression: {r['conclusion']}"]
                                           if r["conclusion"] else []))
            for r in reports]

    async def hidden_visits(self, db: AsyncSession, appointment_ids: list[UUID]
                            ) -> set[UUID]:
        if not appointment_ids:
            return set()
        rows = await db.execute(_HIDDEN_VISITS, {"ids": appointment_ids,
                                                 "labels": list(HIDDEN_LABELS)})
        return {r.id for r in rows}


class SqlExportWrites:
    async def record(self, db: AsyncSession, *, file_id: UUID, format: str, storage_key: str,
                     wrapped_data_key: str, size_bytes: int, sha256: str) -> datetime:
        params: dict[str, Any] = {"file": file_id, "format": format, "key": storage_key,
                                  "wrapped": wrapped_data_key, "size": size_bytes,
                                  "sha": sha256}
        try:
            async with db.begin_nested():
                expires: datetime = (await db.execute(_RECORD, params)).scalar_one()
        except DBAPIError as error:
            detail = db_error_detail(error)
            # asyncpg keeps the constraint name on the driver's own exception.
            constraint = detail.constraint or getattr(
                getattr(error.orig, "__cause__", None), "constraint_name", None)
            if detail.sqlstate == "P0002":
                raise Refused("not-found") from None
            if detail.sqlstate == "P0001" and constraint:
                raise Refused(constraint) from None
            raise
        return expires
