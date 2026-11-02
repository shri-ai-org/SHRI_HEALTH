"""The scheduling events behind the live status board (EVENTS.md §4; each operation's x-events).

Each one goes into the writer's transaction through core's publish(), so the change and its event
commit together, or neither does. `data` holds IDs and enum statuses only, never patient data
(EVENTS.md §2); core's stream then delivers each event to the users of that facility who may read
appointments, and leaves `data` out for a restricted patient the user may not open.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import publish

BOOKED = "appointment.booked"
RESCHEDULED = "appointment.rescheduled"
CANCELLED = "appointment.cancelled"
CHECKED_IN = "appointment.checked-in"
STATUS_CHANGED = "appointment.status-changed"
ENCOUNTER_ENTERED_IN_ERROR = "encounter.entered-in-error"  # internal only (core never streams it)


def _subject(appointment_id: UUID) -> str:
    return f"appointment/{appointment_id}"


async def booked(db: AsyncSession, appointment_id: UUID, *, patient_id: UUID, provider_id: UUID,
                 facility_id: UUID, start: datetime, rescheduled: bool = False) -> None:
    """bookAppointment (`appointment.booked`) or rescheduleAppointment (`appointment.rescheduled`,
    on the new appointment; the board reads the day again, so the old one drops out)."""
    await publish(db, RESCHEDULED if rescheduled else BOOKED, _subject(appointment_id), {
        "appointmentId": str(appointment_id), "patientId": str(patient_id),
        "providerId": str(provider_id), "facilityId": str(facility_id),
        "start": start.isoformat()}, facility_id=facility_id, patient_id=patient_id)


async def cancelled(db: AsyncSession, appointment_id: UUID, *, patient_id: UUID,
                    facility_id: UUID, reason_code: str) -> None:
    await publish(db, CANCELLED, _subject(appointment_id), {
        "appointmentId": str(appointment_id), "patientId": str(patient_id),
        "facilityId": str(facility_id), "reasonCode": reason_code},
        facility_id=facility_id, patient_id=patient_id)


async def checked_in(db: AsyncSession, appointment_id: UUID, *, patient_id: UUID,
                     facility_id: UUID, encounter_id: UUID) -> None:
    await publish(db, CHECKED_IN, _subject(appointment_id), {
        "appointmentId": str(appointment_id), "patientId": str(patient_id),
        "encounterId": str(encounter_id), "facilityId": str(facility_id),
        "status": "checked-in"}, facility_id=facility_id, patient_id=patient_id)


async def check_in_undone(db: AsyncSession, appointment_id: UUID, *, patient_id: UUID,
                          facility_id: UUID, encounter_id: UUID) -> None:
    """undoCheckIn (D55): the appointment is `booked` again, and the check-in encounter is
    entered-in-error (an internal event: billing and documents may hold its ID)."""
    await publish(db, STATUS_CHANGED, _subject(appointment_id), {
        "appointmentId": str(appointment_id), "patientId": str(patient_id),
        "facilityId": str(facility_id), "status": "booked"},
        facility_id=facility_id, patient_id=patient_id)
    await publish(db, ENCOUNTER_ENTERED_IN_ERROR, f"encounter/{encounter_id}", {
        "encounterId": str(encounter_id), "appointmentId": str(appointment_id)},
        facility_id=facility_id, patient_id=patient_id)
