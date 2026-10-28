"""The encounter service batch 1 needs (IMPL_BATCH1_PLAN §1): check-in opens the visit's encounter
and its undo marks it entered-in-error (D16, D55). Its routes come with batch 2.

Writes go through Anand's FHIR write helpers (``app.db.fhir_store``), in the caller's transaction:
nothing here commits. The helpers' exceptions come back as core's errors.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.db.fhir_store import (
    Coded,
    EncounterIn,
    InvalidTransition,
    ParticipantIn,
    Reason,
    ResourceNotFound,
    SqlFhirStore,
)

from . import repository

_STORE = SqlFhirStore()


async def open_for_check_in(db: AsyncSession, *, patient_id: UUID, facility_id: UUID,
                            appointment_id: UUID, provider_id: UUID | None,
                            reason_for_visit: str | None, self_pay: bool, at: datetime) -> UUID:
    """The visit's encounter, status ``arrived`` (D16): the appointment's provider as primary
    performer, its reason for visit, and ``selfPay`` (#74)."""
    written = await _STORE.create_encounter(db, EncounterIn(
        patient_id=patient_id, facility_id=facility_id, appointment_id=appointment_id,
        status="arrived", started_at=at, self_pay=self_pay,
        participants=(ParticipantIn(practitioner_id=provider_id),) if provider_id else (),
        reasons=(Coded(text=reason_for_visit),) if reason_for_visit else ()))
    return written.id


async def live_for_appointment(db: AsyncSession, appointment_id: UUID) -> UUID | None:
    return await repository.live_encounter(db, appointment_id)


async def has_clinical_data(db: AsyncSession, encounter_id: UUID) -> bool:
    """Vitals, notes or diagnoses on the encounter (D55): any of them blocks the undo."""
    return await repository.has_clinical_data(db, encounter_id)


async def mark_entered_in_error(db: AsyncSession, encounter_id: UUID, reason: str) -> None:
    """The encounter becomes entered-in-error with its Provenance (D14, D24); never deleted."""
    try:
        await _STORE.set_encounter_status(db, encounter_id, "entered-in-error",
                                          reason=Reason(text=reason))
    except ResourceNotFound as gone:
        raise NotFound() from gone
    except InvalidTransition as done:
        raise Conflict(code="invalid-state-transition",
                       currentState=done.current_state) from done
