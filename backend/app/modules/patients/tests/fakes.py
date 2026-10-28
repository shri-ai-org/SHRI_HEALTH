"""In-memory stand-ins for the database, the FHIR write helpers and core's chart check, so the API
tests need no database (test_patients_live.py covers the real ones).

They behave like the real pieces where the API depends on it:
- each clinic sees only its own rows, as forced row-level security does (another clinic's patient
  is not found);
- every write bumps the resource's version, and an update with a stale version raises
  ``StaleVersion``;
- the MRN counter is per clinic, ``TEST-000001`` upwards;
- a restricted chart raises ``break-glass-required`` unless the user holds a grant.
Synthetic data only.
"""

from __future__ import annotations

import itertools
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime
from typing import Any, cast
from uuid import UUID

from app.core.deps import CurrentUser
from app.core.errors import Forbidden, NotFound

from .. import schemas
from ..matching import Person
from ..repository import Versioned
from ..store import (
    UNSET,
    ChildWritten,
    IdentifierIn,
    InvalidInput,
    Name,
    PatientChanges,
    PatientIn,
    RelatedPersonChanges,
    RelatedPersonIn,
    ResourceNotFound,
    StaleVersion,
    Telecom,
    Written,
)

MRN_SYSTEM = "https://company-domain.invalid/sid/mrn/TEST"
_NOW = datetime(2026, 11, 3, 15, 0, tzinfo=UTC)


@dataclass
class FakeSession:
    """What tenant_db yields in these tests: the clinic it is scoped to, and its commits."""

    tenant_id: UUID
    commits: int = 0

    async def commit(self) -> None:
        self.commits += 1


@dataclass
class _Patient:
    data: PatientIn
    version: int = 1
    labels: set[str] = field(default_factory=set)
    identifiers: list[schemas.PatientIdentifier] = field(default_factory=list)


@dataclass
class _Related:
    data: RelatedPersonIn
    version: int = 1
    created_at: datetime = _NOW


@dataclass
class World:
    """Everything the fakes share, per clinic."""

    patients: dict[UUID, dict[UUID, _Patient]] = field(default_factory=dict)
    related: dict[UUID, dict[UUID, _Related]] = field(default_factory=dict)
    counters: dict[UUID, itertools.count[int]] = field(default_factory=dict)
    grants: set[tuple[UUID, UUID]] = field(default_factory=set)  # (user, patient)
    audited: list[list[UUID]] = field(default_factory=list)  # each call of audit_patients
    details: list[tuple[str, str | None]] = field(default_factory=list)  # audit_detail calls

    def clinic(self, db: Any) -> dict[UUID, _Patient]:
        return self.patients.setdefault(db.tenant_id, {})

    def related_of(self, db: Any) -> dict[UUID, _Related]:
        return self.related.setdefault(db.tenant_id, {})

    def patient(self, db: Any, patient_id: UUID) -> _Patient:
        found = self.clinic(db).get(patient_id)
        if found is None:
            raise ResourceNotFound()
        return found


def _contacts(telecoms: Sequence[Telecom]) -> tuple[list[schemas.Phone], list[schemas.Email]]:
    phones = [schemas.Phone(number=t.value, use=t.use, text_messages=t.system == "sms")
              for t in telecoms if t.system in ("phone", "sms")]
    emails = [schemas.Email(address=t.value, use=t.use) for t in telecoms if t.system == "email"]
    return phones, emails


def _name(n: Name) -> schemas.HumanName:
    return schemas.HumanName(family=n.family or "", given=list(n.given),
                             prefix=n.prefix[0] if n.prefix else None,
                             suffix=n.suffix[0] if n.suffix else None)


def _identifier(i: IdentifierIn) -> schemas.PatientIdentifier:
    return schemas.PatientIdentifier(
        id=uuid.uuid4(), type=cast(schemas.IdentifierType, i.type_code or "PI"),
        system=i.system or None, value=i.value, assigner=i.assigner_display,
        document_id=i.supporting_document_id, use=cast(schemas.IdentifierUse | None, i.use),
        created_at=_NOW)


class FakeStore:
    def __init__(self, world: World) -> None:
        self.world = world

    async def create_patient(self, db: Any, data: PatientIn) -> Written:
        """Issues the MRN from the clinic's counter, as the real helper does (D41)."""
        if any(i.type_code == "MR" or i.system == MRN_SYSTEM for i in data.identifiers):
            raise InvalidInput("an MRN comes only from the practice's counter (D41)")
        counter = self.world.counters.setdefault(db.tenant_id, itertools.count(1))
        mrn = IdentifierIn(system=MRN_SYSTEM, value=f"TEST-{next(counter):06d}", type_code="MR",
                           use="usual")
        patient_id = uuid.uuid4()
        self.world.clinic(db)[patient_id] = _Patient(
            data, identifiers=[_identifier(i) for i in (mrn, *data.identifiers)])
        return Written(patient_id, 1, _NOW)

    async def add_patient_identifier(self, db: Any, patient_id: UUID, identifier: IdentifierIn,
                                     *, if_version: int | None = None) -> ChildWritten:
        patient = self.world.patient(db, patient_id)
        added = _identifier(identifier)
        patient.identifiers.append(added)
        patient.version += 1
        return ChildWritten(added.id, Written(patient_id, patient.version, _NOW))

    async def update_patient(self, db: Any, patient_id: UUID, changes: PatientChanges, *,
                             if_version: int) -> Written:
        patient = self.world.patient(db, patient_id)
        if patient.version != if_version:
            raise StaleVersion(patient.version)
        values = {k: v for k, v in vars(changes).items() if v is not UNSET}
        patient.data = replace(patient.data, **values)
        patient.version += 1
        return Written(patient_id, patient.version, _NOW)

    async def set_patient_security(self, db: Any, patient_id: UUID, labels: frozenset[str], *,
                                   if_version: int | None = None) -> Written:
        patient = self.world.patient(db, patient_id)
        patient.labels = set(labels)
        patient.version += 1
        return Written(patient_id, patient.version, _NOW)

    async def create_related_person(self, db: Any, data: RelatedPersonIn) -> Written:
        self.world.patient(db, data.patient_id)
        related_id = uuid.uuid4()
        self.world.related_of(db)[related_id] = _Related(data)
        return Written(related_id, 1, _NOW)

    async def update_related_person(self, db: Any, related_person_id: UUID,
                                    changes: RelatedPersonChanges, *, if_version: int) -> Written:
        found = self.world.related_of(db).get(related_person_id)
        if found is None:
            raise ResourceNotFound()
        if found.version != if_version:
            raise StaleVersion(found.version)
        values = {k: v for k, v in vars(changes).items() if v is not UNSET}
        found.data = replace(found.data, **values)
        found.version += 1
        return Written(related_person_id, found.version, _NOW)

    def __getattr__(self, name: str) -> Any:
        raise NotImplementedError(f"FakeStore.{name} is not needed by PR-1")


class FakeRepository:
    def __init__(self, world: World) -> None:
        self.world = world

    def _patient(self, db: Any, patient_id: UUID) -> Versioned[schemas.Patient]:
        found = self.world.clinic(db).get(patient_id)
        if found is None:
            raise NotFound()
        d = found.data
        phones, emails = _contacts(d.telecoms)
        official = next(n for n in d.names if n.use == "official")
        mrn = next(i.value for i in found.identifiers if i.type == "MR")
        return Versioned(schemas.Patient(
            id=patient_id, mrn=mrn, name=_name(official), birth_date=d.birth_date,
            gender=cast(schemas.Gender, d.gender),
            phones=phones, emails=emails, identifiers=list(found.identifiers),
            previous_names=[_name(n) for n in d.names if n.use in ("old", "maiden")],
            preferred_name=next((n.text for n in d.names if n.use == "nickname"), None),
            marital_status=cast(schemas.MaritalStatus | None, d.marital_status),
            restricted=bool(found.labels & {"R", "V"}), active=d.active,
            created_at=_NOW, updated_at=_NOW), found.version)

    async def get_patient(self, db: Any, patient_id: UUID) -> Versioned[schemas.Patient]:
        return self._patient(db, patient_id)

    async def search(self, db: Any, criteria: schemas.SearchCriteria, *, limit: int, offset: int
                     ) -> list[schemas.PatientSummary]:
        out = []
        for patient_id in self.world.clinic(db):
            p = self._patient(db, patient_id).value
            if criteria.family and not p.name.family.lower().startswith(criteria.family.lower()):
                continue
            if criteria.birth_date and p.birth_date != criteria.birth_date:
                continue
            if criteria.mrn and p.mrn != criteria.mrn:
                continue
            out.append(schemas.PatientSummary(
                id=p.id, name=p.name, birth_date=p.birth_date, gender=p.gender, mrn=p.mrn,
                phone_last4=p.phones[0].number[-4:] if p.phones else None,
                restricted=p.restricted, active=p.active))
        return out[offset:offset + limit]

    async def duplicate_pool(self, db: Any, birth_date: date, phones: Sequence[str]
                             ) -> dict[str, Person]:
        pool = {}
        for patient_id, found in self.world.clinic(db).items():
            numbers = frozenset(t.value for t in found.data.telecoms if t.system != "email")
            if found.data.birth_date == birth_date or numbers & set(phones):
                official = next(n for n in found.data.names if n.use == "official")
                pool[str(patient_id)] = Person(family=official.family or "",
                                               given=official.given,
                                               birth_date=found.data.birth_date, phones=numbers)
        return pool

    async def mrn_system(self, db: Any) -> str | None:
        return MRN_SYSTEM

    async def list_identifiers(self, db: Any, patient_id: UUID, *, limit: int, offset: int
                               ) -> list[schemas.PatientIdentifier]:
        found = self.world.clinic(db).get(patient_id)
        if found is None:
            raise NotFound()
        return found.identifiers[offset:offset + limit]

    def _related(self, related_id: UUID, r: _Related) -> Versioned[schemas.RelatedPerson]:
        phones, emails = _contacts(r.data.telecoms)
        return Versioned(schemas.RelatedPerson(
            id=related_id, patient_id=r.data.patient_id, name=_name(r.data.names[0]),
            relationships=[schemas.CodedValue(system=c.system, code=c.code, display=c.display,
                                              text=c.text) for c in r.data.relationships],
            gender=cast(schemas.Gender | None, r.data.gender),
            birth_date=r.data.birth_date, phones=phones, emails=emails, active=r.data.active,
            created_at=r.created_at, updated_at=_NOW), r.version)

    async def list_related(self, db: Any, patient_id: UUID, *, limit: int, offset: int
                           ) -> list[schemas.RelatedPerson]:
        mine = [self._related(i, r).value for i, r in self.world.related_of(db).items()
                if r.data.patient_id == patient_id]
        return mine[offset:offset + limit]

    async def get_related(self, db: Any, patient_id: UUID, related_person_id: UUID
                          ) -> Versioned[schemas.RelatedPerson]:
        found = self.world.related_of(db).get(related_person_id)
        if found is None or found.data.patient_id != patient_id:
            raise NotFound()
        return self._related(related_person_id, found)


def fake_chart_check(world: World) -> Any:
    async def check(db: Any, user: CurrentUser, patient_id: UUID) -> None:
        patient = world.patient(db, patient_id)
        if patient.labels & {"R", "V"} and (user.id, patient_id) not in world.grants:
            raise Forbidden(code="break-glass-required")
    return check


def recording_audit(world: World) -> Any:
    """Stands in for core's audit hooks (#79): records what the endpoint named."""
    from ..access import AuditHooks

    def patients(request: Any, patient_ids: Any) -> None:
        world.audited.append(list(patient_ids))

    def detail(request: Any, action: str, reason: str | None) -> None:
        world.details.append((action, reason))

    return AuditHooks(patients, detail)
