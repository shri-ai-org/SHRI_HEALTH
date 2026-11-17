"""The patient portal's read of the patient's own medication list (listPortalMedications; D28,
D84, D93).

It runs in core's ``portal_db`` session: role ``shri_portal`` with the session's patient set, so
the own-chart policies show this patient's rows only, never a draft or an entered-in-error one.
The query also names the session's patient, so the rule holds twice. On the list, as the staff
list has it (D28): what was prescribed and signed here (intent ``order``) and what the patient
reported taking (intent ``plan``, reported); never a refill request (intent ``proposal``).
Active ones first, then the newest. The prescriber's name comes from the practitioner's official
name (staff, not patient data), as notes show their signers. The pharmacy and the transmission
status are left out until ``shri_portal`` may read ``admin.pharmacy`` and its own chart's
``admin.erx_transaction`` rows (a migration requested from Anand on #85).
"""
from __future__ import annotations

from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from . import portal_schemas as ps

_LIST = text("""
SELECT m.id, m.intent, m.status,
       coalesce(m.medication_codeable_concept_text, m.medication_codeable_concept_display)
         AS display,
       (SELECT d.text FROM clinical.dosage d WHERE d.medication_request_id = m.id
         ORDER BY d.sequence NULLS LAST, d.id LIMIT 1) AS dosage_text,
       CASE WHEN m.intent = 'order' THEN m.ext_signed_at END AS prescribed_at,
       CASE WHEN m.intent = 'order' THEN (
         SELECT nullif(concat_ws(' ', array_to_string(n.prefix, ' '),
                                 array_to_string(n.given, ' '), n.family,
                                 array_to_string(n.suffix, ' ')), '')
           FROM clinical.human_name n WHERE n.practitioner_id = m.ext_signed_by_practitioner_id
          ORDER BY (n.use = 'official') DESC, n.created_at, n.id LIMIT 1) END AS prescriber
FROM clinical.medication_request m
WHERE m.subject_patient_id = :patient
  AND m.status IN ('active', 'on-hold', 'completed', 'stopped', 'cancelled')
  AND ((m.intent = 'plan' AND m.reported_boolean)
       OR (m.intent = 'order' AND m.ext_signed_at IS NOT NULL))
ORDER BY (m.status IN ('active', 'on-hold')) DESC,
         coalesce(m.ext_signed_at, m.authored_on, m.created_at) DESC, m.id
LIMIT :limit OFFSET :offset
""")

# The patient's words for the list: on hold is still a current medicine; a cancelled one stopped.
STATUS = {"active": "active", "on-hold": "active", "completed": "completed",
          "stopped": "stopped", "cancelled": "stopped"}


def _medication(r: Any) -> ps.PortalMedication:
    return ps.PortalMedication(
        id=r.id, display=(r.display or "Medication")[:500], dosage_text=r.dosage_text,
        status=STATUS[r.status], source="prescription" if r.intent == "order" else "reported",
        prescribed_at=r.prescribed_at,
        prescriber_display_name=" ".join(r.prescriber.split())[:200] if r.prescriber else None)


class PortalMedicationReads(Protocol):
    async def medications(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                          offset: int) -> list[ps.PortalMedication]: ...


class SqlPortalMedicationReads:
    async def medications(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                          offset: int) -> list[ps.PortalMedication]:
        rows = await db.execute(_LIST, {"patient": patient_id, "limit": limit, "offset": offset})
        return [_medication(r) for r in rows]
