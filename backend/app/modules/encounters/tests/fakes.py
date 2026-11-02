"""In-memory stand-ins for the database, the write helpers, core's chart check and audit hook,
and the facility's rooms, so the API tests need no database (the *_live.py files cover the real
ones). Like the real pieces where the API depends on it: each clinic sees only its own rows, every
write moves the encounter's version, and a restricted chart is 403 break-glass-required.
Synthetic data only."""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from app.core.deps import CLINIC_A, FACILITY_A, CurrentUser
from app.core.errors import Forbidden, NotFound
from app.db.fhir_store import VitalIn, Written

from .. import schemas
from ..repository import EncounterHead, ReasonIn, Versioned

NOW = datetime(2026, 11, 3, 15, 0, tzinfo=UTC)
ROOM = UUID("9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f")
DOCTOR = UUID("6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c")
LOINC = "http://loinc.org"


@dataclass
class FakeSession:
    tenant_id: UUID
    commits: int = 0

    async def commit(self) -> None:
        self.commits += 1


@dataclass
class FakeEncounter:
    patient_id: UUID
    clinic: UUID = CLINIC_A
    facility_id: UUID = FACILITY_A
    status: str = "arrived"
    version: int = 1
    reasons: list[ReasonIn] = field(default_factory=list)
    location_id: UUID | None = None
    participants: list[tuple[str, UUID]] = field(default_factory=list)


@dataclass
class World:
    encounters: dict[UUID, FakeEncounter] = field(default_factory=dict)
    vitals: list[schemas.Vital] = field(default_factory=list)
    restricted: set[UUID] = field(default_factory=set)
    patients: dict[UUID, UUID] = field(default_factory=dict)  # patient -> clinic
    audited: list[UUID] = field(default_factory=list)

    def add_encounter(self, **kw: Any) -> UUID:
        patient = kw.pop("patient_id", uuid.uuid4())
        self.patients[patient] = kw.get("clinic", CLINIC_A)
        encounter_id = uuid.uuid4()
        self.encounters[encounter_id] = FakeEncounter(patient_id=patient, **kw)
        return encounter_id

    async def chart_check(self, db: Any, user: CurrentUser, patient_id: UUID) -> None:
        if self.patients.get(patient_id) != db.tenant_id:
            raise NotFound()
        if patient_id in self.restricted:
            raise Forbidden(code="break-glass-required")

    def audit(self, request: Any, patient_ids: Iterable[UUID]) -> None:
        self.audited.extend(patient_ids)

    async def rooms(self, db: Any, facility_id: UUID) -> set[UUID]:
        return {ROOM} if facility_id == FACILITY_A else set()

    def encounter(self, db: Any, encounter_id: UUID) -> FakeEncounter:
        found = self.encounters.get(encounter_id)
        if found is None or found.clinic != db.tenant_id:
            raise NotFound()
        return found


class FakeStore:
    def __init__(self, world: World) -> None:
        self.world = world

    async def record_vitals(self, db: Any, patient_id: UUID, encounter_id: UUID | None,
                            vitals: tuple[VitalIn, ...], *, effective_at: datetime | None = None
                            ) -> list[Written]:
        out = []
        for v in vitals:
            vital_id = uuid.uuid4()

            def quantity(m: Any) -> schemas.Quantity | None:
                return None if m is None else schemas.Quantity(value=float(m.value), unit=m.unit)

            systolic, diastolic = quantity(v.systolic), quantity(v.diastolic)
            pressure = (schemas.BloodPressure(systolic=systolic, diastolic=diastolic)
                        if systolic and diastolic else None)
            self.world.vitals.append(schemas.Vital(
                id=vital_id, patient_id=patient_id, encounter_id=encounter_id,
                type=v.type,
                value=quantity(v.value), blood_pressure=pressure,
                effective_at=effective_at or NOW, status="final", entry_source="clinician",
                recorded_at=NOW))
            out.append(Written(vital_id, 1, NOW))
        return out


class FakeRepository:
    def __init__(self, world: World) -> None:
        self.world = world

    async def head(self, db: Any, encounter_id: UUID, *, lock: bool = False) -> EncounterHead:
        e = self.world.encounter(db, encounter_id)
        return EncounterHead(encounter_id, e.patient_id, e.facility_id, e.status, e.version,
                             None)

    async def get(self, db: Any, encounter_id: UUID, *, signed_notes_only: bool
                  ) -> Versioned[schemas.Encounter]:
        e = self.world.encounter(db, encounter_id)
        reasons = [schemas.CodeableConcept(
            codings=[schemas.Coding(system=r.system, code=r.code, display=r.display)]
            if r.system and r.code else [], text=r.text) for r in e.reasons]
        return Versioned(schemas.Encounter(
            id=encounter_id, patient_id=e.patient_id, status=e.status,
            class_="AMB", reasons=reasons or None, facility_id=e.facility_id,
            location_id=e.location_id, time_zone="America/Chicago", started_at=NOW,
            participants=[schemas.EncounterParticipant(role=r, practitioner_id=p)
                          for r, p in e.participants],
            diagnoses=[], notes=[],
            vitals=[v for v in self.world.vitals if v.encounter_id == encounter_id],
            created_at=NOW, updated_at=NOW), e.version)

    def _bump(self, db: Any, encounter_id: UUID) -> FakeEncounter:
        e = self.world.encounter(db, encounter_id)
        e.version += 1
        return e

    async def replace_reasons(self, db: Any, encounter_id: UUID, reasons: Sequence[ReasonIn]
                              ) -> None:
        self._bump(db, encounter_id).reasons = list(reasons)

    async def set_location(self, db: Any, encounter_id: UUID, location_id: UUID | None) -> None:
        self._bump(db, encounter_id).location_id = location_id

    async def replace_participants(self, db: Any, encounter_id: UUID,
                                   participants: Sequence[tuple[str, UUID]]) -> None:
        self._bump(db, encounter_id).participants = list(participants)

    async def practitioners_exist(self, db: Any, ids: Sequence[UUID]) -> set[UUID]:
        return {i for i in ids if i == DOCTOR}

    async def known_code_systems(self, db: Any, uris: Sequence[str]) -> set[str]:
        return {u for u in uris if u in ("http://snomed.info/sct", LOINC)}

    async def vitals(self, db: Any, patient_id: UUID, *, encounter_id: UUID | None = None,
                     ids: Sequence[UUID] | None = None, vital_type: str | None = None,
                     date_from: date | None = None, date_to: date | None = None,
                     include_entered_in_error: bool = False, limit: int = 50, offset: int = 0
                     ) -> list[schemas.Vital]:
        found = [v for v in reversed(self.world.vitals) if v.patient_id == patient_id
                 and (ids is None or v.id in ids) and (vital_type is None or v.type == vital_type)
                 and (encounter_id is None or v.encounter_id == encounter_id)]
        return found[offset:offset + limit]
