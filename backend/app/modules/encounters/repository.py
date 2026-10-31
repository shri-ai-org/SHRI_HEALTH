"""Encounter and vital-sign reads, and the encounter's own child rows, under the request's session
(row-level security: another clinic's encounter or patient is simply not found).

Writes of resources go through Anand's helpers (``app.db.fhir_store``: ``create_encounter``,
``set_encounter_status``, ``record_vitals``). There is no helper yet for an encounter's reasons,
room or participants (``db/CLAUDE.md`` lists none), so this module writes those child rows itself
with Anand's models, as ``scheduling/repository.py`` does for appointments; the touch trigger moves
the encounter's version with them, so its ETag changes. Columns as
``backend/app/db/docs/contract_mapping.yaml`` maps them.

``SqlEncounterRepository`` is the seam the API uses (tests replace it with an in-memory fake); the
module-level functions are the check-in service's (scheduling, D16, D55).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.db.models import systems
from app.db.models.fhir.workflow import (
    Encounter,
    EncounterLocation,
    EncounterParticipant,
    EncounterReason,
)

from . import schemas

_LIVE = text("""
SELECT e.id FROM clinical.encounter e
WHERE e.appointment_id = :appointment AND e.status <> 'entered-in-error'
""")
# D55: vitals (vital-signs observations), notes (compositions) and diagnoses, none of them
# entered in error.
_CLINICAL = text("""
SELECT EXISTS (SELECT 1 FROM clinical.observation o
                WHERE o.encounter_id = :e AND o.status <> 'entered-in-error')
    OR EXISTS (SELECT 1 FROM clinical.composition c
                WHERE c.encounter_id = :e AND c.status <> 'entered-in-error')
    OR EXISTS (SELECT 1 FROM clinical.encounter_diagnosis d WHERE d.encounter_id = :e)
""")


async def live_encounter(db: AsyncSession, appointment_id: UUID) -> UUID | None:
    found: UUID | None = (await db.execute(_LIVE, {"appointment": appointment_id})
                          ).scalar_one_or_none()
    return found


async def has_clinical_data(db: AsyncSession, encounter_id: UUID) -> bool:
    found: bool = (await db.execute(_CLINICAL, {"e": encounter_id})).scalar_one()
    return found


# ------------------------------------------------------------------------------- vocabulary
#: VitalType -> LOINC (the contract's VitalType; the helpers write the same codes).
VITAL_LOINC: dict[str, str] = {
    "blood-pressure": "85354-9", "heart-rate": "8867-4", "respiratory-rate": "9279-1",
    "body-temperature": "8310-5", "body-height": "8302-2", "body-weight": "29463-7",
    "bmi": "39156-5", "oxygen-saturation": "59408-5", "head-circumference": "9843-4",
}
LOINC_VITAL = {code: kind for kind, code in VITAL_LOINC.items()}
SYSTOLIC, DIASTOLIC = "8480-6", "8462-4"

#: EncounterParticipant.role <-> v3 ParticipationType (the contract's mapping).
ROLE_CODE = {"rendering": "PPRF", "supervising": "SPRF", "attending": "ATND", "referring": "REF"}
CODE_ROLE = {code: role for role, code in ROLE_CODE.items()}


@dataclass(frozen=True)
class EncounterHead:
    """What the rules need before they read or write an encounter."""
    id: UUID
    patient_id: UUID
    facility_id: UUID | None
    status: str
    version: int
    appointment_id: UUID | None


@dataclass(frozen=True)
class ReasonIn:
    """One reason: at most one coding (``encounter_reason`` holds one) and its text."""
    system: str | None
    code: str | None
    display: str | None
    text: str | None


@dataclass(frozen=True)
class Versioned[T]:
    value: T
    version: int


class EncounterRepository(Protocol):
    async def head(self, db: AsyncSession, encounter_id: UUID, *, lock: bool = False
                   ) -> EncounterHead: ...

    async def get(self, db: AsyncSession, encounter_id: UUID, *, signed_notes_only: bool
                  ) -> Versioned[schemas.Encounter]: ...

    async def replace_reasons(self, db: AsyncSession, encounter_id: UUID,
                              reasons: Sequence[ReasonIn]) -> None: ...

    async def set_location(self, db: AsyncSession, encounter_id: UUID,
                           location_id: UUID | None) -> None: ...

    async def replace_participants(self, db: AsyncSession, encounter_id: UUID,
                                   participants: Sequence[tuple[str, UUID]]) -> None: ...

    async def practitioners_exist(self, db: AsyncSession, ids: Sequence[UUID]) -> set[UUID]: ...

    async def known_code_systems(self, db: AsyncSession, uris: Sequence[str]) -> set[str]: ...

    async def vitals(self, db: AsyncSession, patient_id: UUID, *,
                     encounter_id: UUID | None = None, ids: Sequence[UUID] | None = None,
                     vital_type: str | None = None, date_from: date | None = None,
                     date_to: date | None = None, include_entered_in_error: bool = False,
                     limit: int = 50, offset: int = 0) -> list[schemas.Vital]: ...


# ------------------------------------------------------------------------------------- SQL
# Who recorded a row (ClinicianRef, whose id is a Practitioner ID): the recording user's
# practitioner and name, when the user is linked to one. Written out in each query (no SQL is
# built from strings).
_HEAD = text("""
SELECT e.id, e.subject_patient_id, e.ext_facility_id, e.status, e.meta_version_id,
       e.appointment_id
FROM clinical.encounter e WHERE e.id = :id
""")
_HEAD_LOCKED = text("""
SELECT e.id, e.subject_patient_id, e.ext_facility_id, e.status, e.meta_version_id,
       e.appointment_id
FROM clinical.encounter e WHERE e.id = :id
FOR UPDATE
""")
_ENCOUNTER = text("""
SELECT e.id, e.subject_patient_id, e.status, e.class, e.appointment_id, e.ext_facility_id,
       f.timezone, e.period_start, e.period_end, e.created_at, e.meta_last_updated,
       e.meta_version_id,
       (SELECT l.location_id FROM clinical.encounter_location l
         WHERE l.encounter_id = e.id AND l.status = 'active'
         ORDER BY l.period_start DESC NULLS LAST LIMIT 1) AS location_id
FROM clinical.encounter e LEFT JOIN admin.facility f ON f.id = e.ext_facility_id
WHERE e.id = :id
""")
_TYPES = text("""
SELECT type_system, type_code, type_display, type_text FROM clinical.encounter_type
WHERE encounter_id = :id ORDER BY created_at, id
""")
_REASONS = text("""
SELECT reason_code_system, reason_code_code, reason_code_display, reason_code_text
FROM clinical.encounter_reason WHERE encounter_id = :id ORDER BY created_at, id
""")
_PARTICIPANTS = text("""
SELECT p.type_code, p.individual_practitioner_id,
       (SELECT concat_ws(' ', array_to_string(n.prefix, ' '), array_to_string(n.given, ' '),
                         n.family, array_to_string(n.suffix, ' '))
          FROM clinical.human_name n WHERE n.practitioner_id = p.individual_practitioner_id
         ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) AS name
FROM clinical.encounter_participant p
WHERE p.encounter_id = :id AND p.individual_practitioner_id IS NOT NULL
ORDER BY p.created_at, p.id
""")
_DIAGNOSES = text("""
SELECT c.id, d.rank, c.code_system, c.code_code, c.code_display, c.verification_status,
       c.onset_date_time, c.ai_suggestion_id, c.entry_source,
       coalesce(c.recorded_date, c.created_at) AS recorded_at,
       cu.practitioner_id AS by_id, coalesce(cn.name, cu.display_name) AS by_name
FROM clinical.encounter_diagnosis d JOIN clinical.condition c ON c.id = d.condition_id
LEFT JOIN admin.app_user cu ON cu.id = c.created_by_user_id
LEFT JOIN LATERAL (SELECT concat_ws(' ', array_to_string(n.prefix, ' '),
                                    array_to_string(n.given, ' '), n.family,
                                    array_to_string(n.suffix, ' ')) AS name
                     FROM clinical.human_name n WHERE n.practitioner_id = cu.practitioner_id
                    ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) cn ON true
WHERE d.encounter_id = :id AND c.verification_status IS DISTINCT FROM 'entered-in-error'
  AND c.code_code IS NOT NULL
ORDER BY d.rank
""")
_NOTES = text("""
SELECT c.id, c.type_system, c.type_code, c.type_display, c.type_text, c.title, c.status,
       c.ext_cosign_status, c.ext_is_ai_assisted, c.meta_last_updated,
       (SELECT a.time FROM clinical.composition_attester a
         WHERE a.composition_id = c.id AND a.mode = 'legal' ORDER BY a.time LIMIT 1) AS signed_at,
       au.practitioner_id AS author_id,
       (SELECT concat_ws(' ', array_to_string(n.prefix, ' '), array_to_string(n.given, ' '),
                         n.family, array_to_string(n.suffix, ' '))
          FROM clinical.human_name n WHERE n.practitioner_id = au.practitioner_id
         ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) AS author_name
FROM clinical.composition c
LEFT JOIN LATERAL (SELECT x.practitioner_id FROM clinical.composition_author x
                    WHERE x.composition_id = c.id AND x.practitioner_id IS NOT NULL
                    ORDER BY x.created_at LIMIT 1) au ON true
WHERE c.encounter_id = :id
  AND NOT EXISTS (SELECT 1 FROM clinical.composition_relates_to r
                   WHERE r.composition_id = c.id AND r.code = 'appends')  -- an addendum
  AND (NOT :signed_only OR c.status IN ('final', 'amended'))
ORDER BY c.date DESC, c.id
LIMIT 50
""")
_FOLLOW_UP = text("""
SELECT interval_value, interval_unit, appointment_type_id, practitioner_id, note, status,
       requested_by_user_id, requested_at, booked_appointment_id, status_reason
FROM clinical.encounter_follow_up WHERE encounter_id = :id
""")
_VITALS = text("""
SELECT o.id, o.subject_patient_id, o.encounter_id, o.code_code, o.status,
       o.effective_date_time, coalesce(o.issued, o.created_at) AS recorded_at, o.entry_source,
       o.value_quantity_value, o.value_quantity_unit,
       s.value_quantity_value AS sys_value, s.value_quantity_unit AS sys_unit,
       d.value_quantity_value AS dia_value, d.value_quantity_unit AS dia_unit,
       ru.practitioner_id AS by_id, coalesce(rn.name, ru.display_name) AS by_name
FROM clinical.observation o
LEFT JOIN clinical.observation_component s
       ON s.observation_id = o.id AND s.code_code = :systolic
LEFT JOIN clinical.observation_component d
       ON d.observation_id = o.id AND d.code_code = :diastolic
LEFT JOIN admin.app_user ru ON ru.id = o.created_by_user_id
LEFT JOIN LATERAL (SELECT concat_ws(' ', array_to_string(n.prefix, ' '),
                                    array_to_string(n.given, ' '), n.family,
                                    array_to_string(n.suffix, ' ')) AS name
                     FROM clinical.human_name n WHERE n.practitioner_id = ru.practitioner_id
                    ORDER BY (n.use = 'official') DESC, n.created_at LIMIT 1) rn ON true
WHERE o.subject_patient_id = :patient
  AND o.code_system = :loinc AND o.code_code = ANY(:codes)
  AND EXISTS (SELECT 1 FROM clinical.observation_category k
               WHERE k.observation_id = o.id AND k.category_code = 'vital-signs')
  AND (CAST(:encounter AS uuid) IS NULL OR o.encounter_id = :encounter)
  AND (CAST(:ids AS uuid[]) IS NULL OR o.id = ANY(:ids))
  AND (:include_eie OR o.status <> 'entered-in-error')
  AND (CAST(:day_from AS date) IS NULL OR o.effective_date_time >= CAST(:day_from AS date))
  AND (CAST(:day_to AS date) IS NULL
       OR o.effective_date_time < CAST(:day_to AS date) + 1)
ORDER BY o.effective_date_time DESC, o.id
LIMIT :limit OFFSET :offset
""")
_PRACTITIONERS = text("SELECT id FROM clinical.practitioner WHERE id = ANY(:ids)")
# A code needs a registered code system (the coded columns' foreign key to admin.code_system).
_CODE_SYSTEMS = text("SELECT uri FROM admin.code_system WHERE uri = ANY(:uris)")


def _coded(system: str | None, code: str | None, display: str | None, txt: str | None
           ) -> schemas.CodeableConcept:
    codings = [schemas.Coding(system=system, code=code, display=display)] if (
        system and code) else []
    return schemas.CodeableConcept(codings=codings, text=txt)


def _quantity(value: Decimal | None, unit: str | None) -> schemas.Quantity | None:
    if value is None or unit is None:
        return None
    return schemas.Quantity(value=float(value), unit=unit)


def _who(by_id: UUID | None, by_name: str | None) -> schemas.ClinicianRef | None:
    if by_id is None:
        return None
    return schemas.ClinicianRef(id=by_id, display_name=" ".join((by_name or "").split())
                                or "Unnamed clinician")


def vital_out(r: Any) -> schemas.Vital:
    kind = LOINC_VITAL[r["code_code"]]
    pressure = None
    if kind == "blood-pressure":
        systolic, diastolic = (_quantity(r["sys_value"], r["sys_unit"]),
                               _quantity(r["dia_value"], r["dia_unit"]))
        if systolic is not None and diastolic is not None:
            pressure = schemas.BloodPressure(systolic=systolic, diastolic=diastolic)
    return schemas.Vital(
        id=r["id"], patient_id=r["subject_patient_id"], encounter_id=r["encounter_id"],
        type=kind,
        value=None if kind == "blood-pressure" else _quantity(r["value_quantity_value"],
                                                              r["value_quantity_unit"]),
        blood_pressure=pressure, effective_at=r["effective_date_time"], status=r["status"],
        entry_source=r["entry_source"], recorded_at=r["recorded_at"],
        recorded_by=_who(r["by_id"], r["by_name"]))


def _partial(value: datetime | None) -> str | None:
    return value.date().isoformat() if value else None


class SqlEncounterRepository:
    async def head(self, db: AsyncSession, encounter_id: UUID, *, lock: bool = False
                   ) -> EncounterHead:
        r = (await db.execute(_HEAD_LOCKED if lock else _HEAD, {"id": encounter_id})
             ).mappings().first()
        if r is None:
            raise NotFound()
        return EncounterHead(r["id"], r["subject_patient_id"], r["ext_facility_id"],
                             r["status"], r["meta_version_id"], r["appointment_id"])

    async def get(self, db: AsyncSession, encounter_id: UUID, *, signed_notes_only: bool
                  ) -> Versioned[schemas.Encounter]:
        e = (await db.execute(_ENCOUNTER, {"id": encounter_id})).mappings().first()
        if e is None:
            raise NotFound()
        params = {"id": encounter_id}
        types = [_coded(*r) for r in (await db.execute(_TYPES, params)).all()]
        reasons = [_coded(*r) for r in (await db.execute(_REASONS, params)).all()]
        participants = [
            schemas.EncounterParticipant(
                role=CODE_ROLE.get(r[0] or "", "attending"),
                practitioner_id=r[1], display_name=" ".join((r[2] or "").split()) or None)
            for r in (await db.execute(_PARTICIPANTS, params)).all()]
        diagnoses = [schemas.EncounterDiagnosis(
            id=r["id"], encounter_id=encounter_id, rank=r["rank"],
            code=schemas.Coding(system=r["code_system"], code=r["code_code"],
                                display=r["code_display"]),
            verification_status=r["verification_status"] or "confirmed",
            onset_date=_partial(r["onset_date_time"]), ai_suggestion_id=r["ai_suggestion_id"],
            entry_source=r["entry_source"], recorded_at=r["recorded_at"],
            recorded_by=_who(r["by_id"], r["by_name"]))
            for r in (await db.execute(_DIAGNOSES, params)).mappings()]
        notes = []
        for r in (await db.execute(_NOTES, {**params, "signed_only": signed_notes_only})
                  ).mappings():
            author = _who(r["author_id"], r["author_name"])
            if author is None:
                continue  # a note always has a practitioner author (the notes helpers)
            notes.append(schemas.NoteSummary(
                id=r["id"], note_type=_coded(r["type_system"], r["type_code"],
                                             r["type_display"], r["type_text"]),
                title=r["title"], status=r["status"], cosign_status=r["ext_cosign_status"],
                author=author, ai_assisted=bool(r["ext_is_ai_assisted"]),
                signed_at=r["signed_at"], updated_at=r["meta_last_updated"]))
        f = (await db.execute(_FOLLOW_UP, params)).mappings().first()
        follow_up = None
        if f is not None:
            follow_up = schemas.FollowUpRequest(
                interval=schemas.FollowUpInterval(value=f["interval_value"],
                                                  unit=str(f["interval_unit"])),
                appointment_type_id=f["appointment_type_id"], provider_id=f["practitioner_id"],
                note=f["note"], status=str(f["status"]),
                requested_by=f["requested_by_user_id"], requested_at=f["requested_at"],
                booked_appointment_id=f["booked_appointment_id"],
                declined_reason=f["status_reason"] if f["status"] == "declined" else None,
                withdrawn_reason=f["status_reason"] if f["status"] == "withdrawn" else None)
        vitals = await self.vitals(db, e["subject_patient_id"], encounter_id=encounter_id,
                                   limit=50)
        encounter = schemas.Encounter(
            id=e["id"], patient_id=e["subject_patient_id"], status=e["status"],
            class_=e["class"], types=types or None, reasons=reasons or None,
            appointment_id=e["appointment_id"], facility_id=e["ext_facility_id"],
            location_id=e["location_id"], time_zone=e["timezone"] or "UTC",
            started_at=e["period_start"], ended_at=e["period_end"],
            participants=participants, diagnoses=diagnoses, vitals=vitals, notes=notes,
            created_at=e["created_at"], updated_at=e["meta_last_updated"], follow_up=follow_up)
        return Versioned(encounter, e["meta_version_id"])

    async def _touch(self, db: AsyncSession, encounter_id: UUID) -> None:
        """Who changed the encounter last; the child rows' touch trigger moves its version."""
        user = (await db.execute(text(
            "SELECT NULLIF(current_setting('app.current_user_id', true), '')"))).scalar_one()
        row = (await db.execute(select(Encounter).where(Encounter.id == encounter_id))
               ).scalar_one()
        row.updated_by_user_id = UUID(user) if user else None
        await db.flush()

    async def replace_reasons(self, db: AsyncSession, encounter_id: UUID,
                              reasons: Sequence[ReasonIn]) -> None:
        for old in (await db.execute(select(EncounterReason).where(
                EncounterReason.encounter_id == encounter_id))).scalars():
            await db.delete(old)  # a child row of the encounter; its history keeps it
        await db.flush()
        db.add_all(EncounterReason(encounter_id=encounter_id, reason_code_system=r.system,
                                   reason_code_code=r.code, reason_code_display=r.display,
                                   reason_code_text=r.text) for r in reasons)
        await self._touch(db, encounter_id)

    async def set_location(self, db: AsyncSession, encounter_id: UUID,
                           location_id: UUID | None) -> None:
        """Rooming is an active encounter_location (the model's docstring): the active one is
        completed and the new room, if any, becomes active."""
        now = (await db.execute(text("SELECT now()"))).scalar_one()
        for active in (await db.execute(select(EncounterLocation).where(
                EncounterLocation.encounter_id == encounter_id,
                EncounterLocation.status == "active"))).scalars():
            if active.location_id == location_id:
                return  # already there
            active.status, active.period_end = "completed", now
        await db.flush()
        if location_id is not None:
            db.add(EncounterLocation(encounter_id=encounter_id, location_id=location_id,
                                     status="active", period_start=now))
        await self._touch(db, encounter_id)

    async def replace_participants(self, db: AsyncSession, encounter_id: UUID,
                                   participants: Sequence[tuple[str, UUID]]) -> None:
        for old in (await db.execute(select(EncounterParticipant).where(
                EncounterParticipant.encounter_id == encounter_id))).scalars():
            await db.delete(old)
        await db.flush()
        db.add_all(EncounterParticipant(encounter_id=encounter_id,
                                        type_system=systems.V3_PARTICIPATION_TYPE,
                                        type_code=ROLE_CODE[role],
                                        individual_practitioner_id=practitioner)
                   for role, practitioner in participants)
        await self._touch(db, encounter_id)

    async def practitioners_exist(self, db: AsyncSession, ids: Sequence[UUID]) -> set[UUID]:
        if not ids:
            return set()
        return {r[0] for r in (await db.execute(_PRACTITIONERS, {"ids": list(ids)})).all()}

    async def known_code_systems(self, db: AsyncSession, uris: Sequence[str]) -> set[str]:
        if not uris:
            return set()
        return {r[0] for r in (await db.execute(_CODE_SYSTEMS, {"uris": list(uris)})).all()}

    async def vitals(self, db: AsyncSession, patient_id: UUID, *,
                     encounter_id: UUID | None = None, ids: Sequence[UUID] | None = None,
                     vital_type: str | None = None, date_from: date | None = None,
                     date_to: date | None = None, include_entered_in_error: bool = False,
                     limit: int = 50, offset: int = 0) -> list[schemas.Vital]:
        codes = [VITAL_LOINC[vital_type]] if vital_type else list(VITAL_LOINC.values())
        rows = (await db.execute(_VITALS, {
            "patient": patient_id, "loinc": systems.LOINC, "codes": codes,
            "systolic": SYSTOLIC, "diastolic": DIASTOLIC,
            "encounter": encounter_id, "ids": list(ids) if ids is not None else None,
            "include_eie": include_entered_in_error, "day_from": date_from, "day_to": date_to,
            "limit": limit, "offset": offset})).mappings()
        return [vital_out(r) for r in rows]
