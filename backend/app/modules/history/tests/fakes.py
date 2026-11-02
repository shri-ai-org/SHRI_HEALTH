"""In-memory stand-ins for the allergy reads, the write helpers, core's chart check and the
patients module's merged-chart check, so the API tests need no database (test_allergies_live.py
covers the real ones). Each clinic sees only its own rows, every write moves the allergy's version
and a stale one raises StaleVersion. Synthetic data only."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from app.core.deps import CLINIC_A, CurrentUser
from app.core.errors import Conflict, Forbidden, NotFound
from app.db.fhir_store import (
    UNSET,
    AllergyChanges,
    AllergyIn,
    InvalidTransition,
    Reason,
    ResourceNotFound,
    StaleVersion,
    Written,
)

from ...encounters.schemas import CodeableConcept, Coding
from .. import schemas
from ..repository import AllergyRow

NOW = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)


@dataclass
class FakeSession:
    tenant_id: UUID
    commits: int = 0

    async def commit(self) -> None:
        self.commits += 1


@dataclass
class _Allergy:
    data: AllergyIn
    clinic: UUID
    created_by: UUID | None
    version: int = 1
    eie_reason: str | None = None


@dataclass
class World:
    patients: dict[UUID, UUID] = field(default_factory=dict)  # patient -> clinic
    restricted: set[UUID] = field(default_factory=set)
    merged: set[UUID] = field(default_factory=set)
    visits: dict[UUID, tuple[UUID, str]] = field(default_factory=dict)  # encounter -> visit
    allergies: dict[UUID, _Allergy] = field(default_factory=dict)
    user_of: dict[UUID, UUID] = field(default_factory=dict)  # session tenant -> last writer

    def patient(self, clinic: UUID = CLINIC_A) -> UUID:
        patient_id = uuid.uuid4()
        self.patients[patient_id] = clinic
        return patient_id

    async def chart_check(self, db: Any, user: CurrentUser, patient_id: UUID) -> None:
        if self.patients.get(patient_id) != db.tenant_id:
            raise NotFound()
        if patient_id in self.restricted:
            raise Forbidden(code="break-glass-required")
        self.user_of[db.tenant_id] = user.id

    async def writable(self, db: Any, patient_id: UUID) -> None:
        if patient_id in self.merged:
            raise Conflict(code="patient-merged")


def _concept(c: Any) -> CodeableConcept:
    codings = [Coding(system=c.system, code=c.code, display=c.display)] if c.code else []
    return CodeableConcept(codings=codings, text=c.text)


class FakeStore:
    def __init__(self, world: World) -> None:
        self.world = world

    async def create_allergy(self, db: Any, data: AllergyIn) -> Written:
        allergy_id = uuid.uuid4()
        self.world.allergies[allergy_id] = _Allergy(data, db.tenant_id,
                                                    self.world.user_of.get(db.tenant_id))
        return Written(allergy_id, 1, NOW)

    def _locked(self, db: Any, allergy_id: UUID, if_version: int | None) -> _Allergy:
        a = self.world.allergies.get(allergy_id)
        if a is None or a.clinic != db.tenant_id:
            raise ResourceNotFound
        if if_version is not None and a.version != if_version:
            raise StaleVersion(a.version)
        if a.data.verification_status == "entered-in-error":
            raise InvalidTransition("entered-in-error")
        return a

    async def update_allergy(self, db: Any, allergy_id: UUID, changes: AllergyChanges, *,
                             if_version: int) -> Written:
        a = self._locked(db, allergy_id, if_version)
        given = {k: v for k, v in vars(changes).items() if v is not UNSET}
        if "categories" in given:
            given["categories"] = tuple(given["categories"])
        a.data = replace(a.data, **given)
        a.version += 1
        return Written(allergy_id, a.version, NOW)

    async def allergy_entered_in_error(self, db: Any, allergy_id: UUID, reason: Reason, *,
                                       if_version: int | None = None) -> Written:
        a = self._locked(db, allergy_id, if_version)
        a.data = replace(a.data, verification_status="entered-in-error")
        a.eie_reason, a.version = reason.text, a.version + 1
        return Written(allergy_id, a.version, NOW)


class FakeRepository:
    def __init__(self, world: World) -> None:
        self.world = world

    def _out(self, allergy_id: UUID, a: _Allergy) -> schemas.Allergy:
        d = a.data
        eie = d.verification_status == "entered-in-error"
        return schemas.Allergy(
            id=allergy_id, patient_id=d.patient_id,
            clinical_status=None if eie else d.clinical_status,
            verification_status=d.verification_status,
            encounter_id=d.encounter_id, code=_concept(d.code), type=d.type,
            categories=list(d.categories) or None,
            criticality=d.criticality,
            onset_date=d.onset_date_time.date().isoformat() if d.onset_date_time else None,
            reactions=[schemas.AllergyReactionOut(
                manifestations=[_concept(m) for m in r.manifestations],
                severity=r.severity,
                description=r.description) for r in d.reactions] or None,
            note=d.note, entry_source="clinician", recorded_at=NOW)

    async def list(self, db: Any, patient_id: UUID, *, include_entered_in_error: bool,
                   limit: int, offset: int) -> list[schemas.Allergy]:
        found = [self._out(i, a) for i, a in reversed(self.world.allergies.items())
                 if a.clinic == db.tenant_id and a.data.patient_id == patient_id
                 and (include_entered_in_error
                      or a.data.verification_status != "entered-in-error")]
        return found[offset:offset + limit]

    async def get(self, db: Any, patient_id: UUID, allergy_id: UUID) -> AllergyRow:
        a = self.world.allergies.get(allergy_id)
        if a is None or a.clinic != db.tenant_id or a.data.patient_id != patient_id:
            raise NotFound()
        return AllergyRow(self._out(allergy_id, a), a.version, a.created_by)

    async def visit_of(self, db: Any, encounter_id: UUID) -> tuple[UUID, str] | None:
        return self.world.visits.get(encounter_id)
