"""Refill requests (#400; inventory #128, #129): their rows, and the writes through Anand's helpers.

A refill request is a MedicationRequest with intent ``proposal``: the patient as ``requester``,
the prescription to refill as ``priorPrescription``, the patient's note as its annotation, and,
once declined, the reason as ``statusReason``. Its FHIR status is the contract's: ``active`` is
``requested``, ``completed`` ``approved``, ``cancelled`` ``declined``.

- **Writes** go through Anand's helpers in ``app.db.fhir_store`` (``create_refill_request``,
  ``respond_to_refill_request``, and ``PrescriptionIn.prior_prescription_id`` for the approved
  draft; asked for on #85). Until they are merged, ``SqlRefillStore`` and ``draft_in`` answer
  ``503`` (``HELPERS_MISSING``) before anything is written; ``helpers_ready()`` says whether
  they are there.
- **Reads** are plain SQL, in the caller's session: ``shri_app`` (the clinic's rows) for the
  staff reads, ``shri_portal`` (the session patient's chart, never a draft) for the portal's.
  The portal's reads name no table ``shri_portal`` can't read (the request's annotation, the
  users): its columns are a subset of the staff's.
- **The approved draft** is the earliest prescription (intent ``order``) with the same
  ``priorPrescription``, written at or after the answer (``created_at >= meta_last_updated``;
  both are the answering transaction's ``now()``). A draft is invisible to ``shri_portal``, so
  the portal shows ``newPrescriptionId`` once the prescriber has signed it.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ServiceUnavailable
from app.db import fhir_store as fs

from .repository import PrescriptionRow

HELPERS_MISSING = "Refill requests need the database's refill helpers (Anand, #85)"
#: The FHIR statuses a refill request can have, as the contract names them.
STATUS = {"active": "requested", "completed": "approved", "cancelled": "declined"}


# ---------------------------------------------------------------------------------- rows
@dataclass(frozen=True)
class RefillablePrescription:
    """What asking for a refill checks about the prescription."""
    id: UUID
    patient_id: UUID
    intent: str
    status: str
    signed: bool
    dea_schedule: str | None
    facility_id: UUID | None  # its visit's


@dataclass(frozen=True)
class RefillRow:
    id: UUID
    patient_id: UUID
    status: str  # FHIR: active | completed | cancelled
    prescription_id: UUID
    requested_at: datetime
    last_updated: datetime
    version: int
    decline_reason: str | None
    display: str | None
    dosage_text: str | None
    facility_id: UUID | None  # the refilled prescription's visit's
    new_prescription_id: UUID | None
    note: str | None = None  # staff reads only
    responder_id: UUID | None = None  # the answering practitioner (staff reads only)
    responder_name: str | None = None

    @property
    def responded_at(self) -> datetime | None:
        return self.last_updated if self.status != "active" else None


@dataclass(frozen=True)
class RefillRequestIn:
    """``fs.RefillRequestIn``'s fields (Anand's, to come)."""
    patient_id: UUID
    prior_prescription_id: UUID
    note: str | None = None


# ------------------------------------------------------------------------------ protocols
class RefillStore(Protocol):
    """The writes, through Anand's helpers (no commit)."""

    async def create_refill_request(self, db: AsyncSession, request: RefillRequestIn
                                    ) -> fs.Written: ...

    async def respond_to_refill_request(self, db: AsyncSession, request_id: UUID, *,
                                        approve: bool, reason: str | None, if_version: int
                                        ) -> fs.Written:
        """Raises ``fs.InvalidTransition`` when the request is no longer active."""
        ...


class RefillReads(Protocol):
    async def prescription(self, db: AsyncSession, prescription_id: UUID
                           ) -> RefillablePrescription | None: ...

    async def open_request(self, db: AsyncSession, prescription_id: UUID) -> bool:
        """An active refill request for this prescription exists."""
        ...

    async def portal_requests(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                              offset: int, request_id: UUID | None = None
                              ) -> list[RefillRow]:
        """The patient's requests, newest first (only ``request_id``'s when given)."""
        ...

    async def staff_requests(self, db: AsyncSession, *, status: str,
                             facility_ids: Collection[UUID], limit: int, offset: int
                             ) -> list[RefillRow]:
        """The clinic's requests in this FHIR status whose prescription's visit is at one of
        these facilities (or has no visit), open first, then oldest first."""
        ...

    async def staff_request(self, db: AsyncSession, request_id: UUID) -> RefillRow | None: ...


# ---------------------------------------------------------------------------- the helpers
_STORE = fs.SqlFhirStore()


def helpers_ready() -> bool:
    """Anand's refill helpers are merged (``fs.RefillRequestIn``, the store's two methods and
    ``PrescriptionIn.prior_prescription_id``)."""
    return (hasattr(fs, "RefillRequestIn")
            and hasattr(fs.SqlFhirStore, "create_refill_request")
            and hasattr(fs.SqlFhirStore, "respond_to_refill_request")
            and "prior_prescription_id" in {f.name for f in dataclasses.fields(fs.PrescriptionIn)})


def _helper(name: str) -> Any:
    found = getattr(_STORE, name, None)
    if found is None:
        raise ServiceUnavailable(HELPERS_MISSING)
    return found


class SqlRefillStore:
    async def create_refill_request(self, db: AsyncSession, request: RefillRequestIn
                                    ) -> fs.Written:
        shape = getattr(fs, "RefillRequestIn", None)
        create = _helper("create_refill_request")
        if shape is None:
            raise ServiceUnavailable(HELPERS_MISSING)
        written: fs.Written = await create(db, shape(
            patient_id=request.patient_id, prior_prescription_id=request.prior_prescription_id,
            note=request.note))
        return written

    async def respond_to_refill_request(self, db: AsyncSession, request_id: UUID, *,
                                        approve: bool, reason: str | None, if_version: int
                                        ) -> fs.Written:
        respond = _helper("respond_to_refill_request")
        written: fs.Written = await respond(db, request_id, approve=approve, reason=reason,
                                            if_version=if_version)
        return written


def draft_in(prior: PrescriptionRow, *, pharmacy_id: UUID | None, dea_schedule: str | None,
             refills: int | None) -> fs.PrescriptionIn:
    """The approved refill's draft: the prior prescription's drug, directions, quantity, days'
    supply, refills, substitution and pharmacy, outside any visit, with ``priorPrescription``.
    ``503`` while ``PrescriptionIn`` has no ``prior_prescription_id`` (checked before anything
    is written)."""
    if "prior_prescription_id" not in {f.name for f in dataclasses.fields(fs.PrescriptionIn)}:
        raise ServiceUnavailable(HELPERS_MISSING)
    drug = prior.drug
    values: dict[str, Any] = {
        "patient_id": prior.patient_id,
        "medication": fs.Coded(system=drug.system, code=drug.code, display=drug.display,
                               text=drug.text),
        "dosage_text": prior.dosage_text,
        "quantity": fs.DispenseQuantity(prior.quantity_value, prior.quantity_unit)
        if prior.quantity_value is not None and prior.quantity_unit else None,
        "days_supply": int(prior.days_supply) if prior.days_supply is not None else None,
        "refills": refills, "substitution_allowed": prior.substitution_allowed,
        "pharmacy_id": pharmacy_id, "dea_schedule": dea_schedule,
        "prior_prescription_id": prior.id,
    }
    return fs.PrescriptionIn(**values)


# ------------------------------------------------------------------------------------ SQL
_PRESCRIPTION = text("""
SELECT m.id, m.subject_patient_id, m.intent, m.status, m.ext_signed_at IS NOT NULL AS signed,
       m.ext_dea_schedule, e.ext_facility_id AS facility_id
FROM clinical.medication_request m
LEFT JOIN clinical.encounter e ON e.id = m.encounter_id
WHERE m.id = :id
""")
_OPEN = text("""
SELECT EXISTS (SELECT 1 FROM clinical.medication_request r
               WHERE r.intent = 'proposal' AND r.prior_prescription_id = :id
                 AND r.status = 'active')
""")
# What both sessions may read: the request, its prescription, that prescription's directions
# and visit, and the draft an approval wrote.
_COLUMNS = """
SELECT r.id, r.subject_patient_id, r.status, r.prior_prescription_id, r.created_at,
       r.meta_last_updated, r.meta_version_id,
       CASE WHEN r.status = 'cancelled' THEN r.status_reason_text END AS decline_reason,
       coalesce(p.medication_codeable_concept_text, p.medication_codeable_concept_display,
                r.medication_codeable_concept_text, r.medication_codeable_concept_display)
         AS display,
       (SELECT d.text FROM clinical.dosage d WHERE d.medication_request_id = p.id
         ORDER BY d.sequence NULLS LAST, d.id LIMIT 1) AS dosage_text,
       e.ext_facility_id AS facility_id,
       CASE WHEN r.status = 'completed' THEN (
         SELECT o.id FROM clinical.medication_request o
          WHERE o.intent = 'order' AND o.prior_prescription_id = r.prior_prescription_id
            AND o.subject_patient_id = r.subject_patient_id
            AND o.created_at >= r.meta_last_updated
          ORDER BY o.created_at, o.id LIMIT 1) END AS new_prescription_id"""
# Staff only: the patient's note, and who answered (the practitioner's official name, else the
# user's display name: staff, not patient data).
_STAFF_ONLY = """,
       (SELECT n.text FROM clinical.annotation n WHERE n.medication_request_id = r.id
         ORDER BY n.time NULLS LAST, n.id LIMIT 1) AS note,
       u.practitioner_id AS responder_id,
       coalesce((SELECT nullif(concat_ws(' ', array_to_string(n.prefix, ' '),
                                         array_to_string(n.given, ' '), n.family,
                                         array_to_string(n.suffix, ' ')), '')
                   FROM clinical.human_name n WHERE n.practitioner_id = u.practitioner_id
                  ORDER BY (n.use = 'official') DESC, n.created_at, n.id LIMIT 1),
                u.display_name) AS responder_name"""
_STAFF_COLUMNS = _COLUMNS + _STAFF_ONLY
_FROM = """
FROM clinical.medication_request r
LEFT JOIN clinical.medication_request p ON p.id = r.prior_prescription_id
LEFT JOIN clinical.encounter e ON e.id = p.encounter_id
"""
_STAFF_FROM = _FROM + """LEFT JOIN admin.app_user u
  ON u.id = r.updated_by_user_id AND r.status IN ('completed', 'cancelled')
"""
_REFILLS = """r.intent = 'proposal' AND r.prior_prescription_id IS NOT NULL
  AND r.status IN ('active', 'completed', 'cancelled')"""
_PORTAL = text(_COLUMNS + _FROM + "WHERE " + _REFILLS + """
  AND r.subject_patient_id = :patient AND r.requester_patient_id = :patient
  AND (CAST(:id AS uuid) IS NULL OR r.id = CAST(:id AS uuid))
ORDER BY r.created_at DESC, r.id
LIMIT :limit OFFSET :offset
""")
_STAFF_LIST = text(_STAFF_COLUMNS + _STAFF_FROM + "WHERE " + _REFILLS + """
  AND r.status = :status
  AND (e.ext_facility_id IS NULL OR e.ext_facility_id = ANY(:facilities))
ORDER BY (r.status = 'active') DESC, r.created_at, r.id
LIMIT :limit OFFSET :offset
""")
_STAFF_ONE = text(_STAFF_COLUMNS + _STAFF_FROM + "WHERE " + _REFILLS + " AND r.id = :id")


def _row(r: Any, *, staff: bool) -> RefillRow:
    name = getattr(r, "responder_name", None) if staff else None
    return RefillRow(
        id=r.id, patient_id=r.subject_patient_id, status=r.status,
        prescription_id=r.prior_prescription_id, requested_at=r.created_at,
        last_updated=r.meta_last_updated, version=r.meta_version_id,
        decline_reason=r.decline_reason, display=r.display, dosage_text=r.dosage_text,
        facility_id=r.facility_id, new_prescription_id=r.new_prescription_id,
        note=r.note if staff else None, responder_id=r.responder_id if staff else None,
        responder_name=" ".join(name.split()) or None if name else None)


class SqlRefillReads:
    async def prescription(self, db: AsyncSession, prescription_id: UUID
                           ) -> RefillablePrescription | None:
        r = (await db.execute(_PRESCRIPTION, {"id": prescription_id})).one_or_none()
        if r is None:
            return None
        return RefillablePrescription(
            id=r.id, patient_id=r.subject_patient_id, intent=r.intent, status=r.status,
            signed=bool(r.signed), dea_schedule=r.ext_dea_schedule, facility_id=r.facility_id)

    async def open_request(self, db: AsyncSession, prescription_id: UUID) -> bool:
        return bool((await db.execute(_OPEN, {"id": prescription_id})).scalar_one())

    async def portal_requests(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                              offset: int, request_id: UUID | None = None
                              ) -> list[RefillRow]:
        rows = await db.execute(_PORTAL, {"patient": patient_id, "id": request_id,
                                          "limit": limit, "offset": offset})
        return [_row(r, staff=False) for r in rows]

    async def staff_requests(self, db: AsyncSession, *, status: str,
                             facility_ids: Collection[UUID], limit: int, offset: int
                             ) -> list[RefillRow]:
        rows = await db.execute(_STAFF_LIST, {"status": status,
                                              "facilities": sorted(facility_ids),
                                              "limit": limit, "offset": offset})
        return [_row(r, staff=True) for r in rows]

    async def staff_request(self, db: AsyncSession, request_id: UUID) -> RefillRow | None:
        r = (await db.execute(_STAFF_ONE, {"id": request_id})).one_or_none()
        return _row(r, staff=True) if r is not None else None
