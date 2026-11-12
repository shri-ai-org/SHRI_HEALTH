"""The patient portal's visit-summary reads (B8a, D84, D86, D90, D93; inventory #278, #279).

A visit summary is the after-visit summary the encounter generates (D98): a DocumentReference
with LOINC 34133-9 (Summary of episode note), origin ``generated``, status ``current``, on the
visit (``context_encounter_id``), never with a preliminary (draft) ``docStatus``, as Anand's
``documents.after_visit_summary`` records it (draft #157). The portal shows the latest one per
visit; its ID is the DocumentReference's.

Everything runs in core's ``portal_db`` session (``shri_portal``, the session's patient set):
the own-chart policies hide other patients' rows, entered-in-error and PSY-labelled documents,
and **held** ones (D90). A held summary is therefore found only through
``admin.portal_held_items()`` (type, ID and date; never the reason or the clinician), and shown
as held without content. Each query also names the session's patient.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import systems
from app.modules.scheduling import repository as scheduling

#: LOINC Summary of episode note: the after-visit summary's type (#157).
AVS_TYPE_CODE = "34133-9"


@dataclass(frozen=True)
class SummaryRow:
    """A released visit summary."""
    id: UUID
    patient_id: UUID
    visit_start: datetime
    time_zone: str
    provider_id: UUID | None
    facility_name: str | None
    available_at: datetime | None


@dataclass(frozen=True)
class HeldRow:
    """A held DocumentReference of the session's patient: its ID and date only (D90)."""
    id: UUID
    date: datetime | None


class PortalSummaryReads(Protocol):
    async def released(self, db: Any, patient_id: UUID) -> list[SummaryRow]: ...

    async def held(self, db: Any) -> list[HeldRow]: ...

    async def practice_time_zone(self, db: Any) -> str: ...

    async def provider_names(self, db: Any, ids: list[UUID]) -> dict[UUID, str]: ...


# The latest current summary of each visit. available_at: when it was made, or when its last
# hold was lifted, whichever is later (a lifted hold's marker row stays readable, D90).
_RELEASED = text(f"""
SELECT DISTINCT ON (d.context_encounter_id)
       d.id, d.subject_patient_id, d.date, coalesce(e.period_start, d.date) AS visit_start,
       f.name AS facility_name, f.timezone,
       (SELECT x.individual_practitioner_id FROM clinical.encounter_participant x
         WHERE x.encounter_id = e.id AND x.individual_practitioner_id IS NOT NULL
         ORDER BY (x.type_code = 'PPRF') DESC, x.created_at LIMIT 1) AS provider_id,
       (SELECT max(h.lifted_at) FROM admin.release_hold h
         WHERE h.document_reference_id = d.id) AS lifted_at
FROM clinical.document_reference d
JOIN clinical.encounter e ON e.id = d.context_encounter_id
LEFT JOIN admin.facility f ON f.id = e.ext_facility_id
WHERE d.subject_patient_id = :patient AND d.status = 'current' AND d.ext_origin = 'generated'
  AND (d.doc_status IS NULL OR d.doc_status IN ('final', 'amended'))
  AND d.type_system = :loinc AND d.type_code = '{AVS_TYPE_CODE}'
ORDER BY d.context_encounter_id, d.date DESC, d.id
""")  # noqa: S608 (a constant, not input)
_HELD = text("SELECT item_id, item_date FROM admin.portal_held_items() "
             "WHERE item_type = 'DocumentReference'")
_ZONE = text("SELECT timezone FROM admin.facility WHERE is_active ORDER BY code, id LIMIT 1")
DEFAULT_ZONE = "UTC"


class SqlPortalSummaryReads:
    async def released(self, db: AsyncSession, patient_id: UUID) -> list[SummaryRow]:
        rows = list((await db.execute(_RELEASED, {"patient": patient_id,
                                                  "loinc": systems.LOINC})).mappings())
        fallback = (await self.practice_time_zone(db)
                    if any(r["timezone"] is None for r in rows) else DEFAULT_ZONE)
        return [SummaryRow(r["id"], r["subject_patient_id"], r["visit_start"],
                           r["timezone"] or fallback, r["provider_id"], r["facility_name"],
                           max((t for t in (r["date"], r["lifted_at"]) if t), default=None))
                for r in rows]

    async def held(self, db: AsyncSession) -> list[HeldRow]:
        return [HeldRow(r["item_id"], r["item_date"])
                for r in (await db.execute(_HELD)).mappings()]

    async def practice_time_zone(self, db: AsyncSession) -> str:
        """For a summary without a facility: the clinic's first facility's zone (D40)."""
        found = (await db.execute(_ZONE)).scalar_one_or_none()
        return str(found) if found else DEFAULT_ZONE

    async def provider_names(self, db: AsyncSession, ids: list[UUID]) -> dict[UUID, str]:
        return await scheduling.provider_names(db, ids)
