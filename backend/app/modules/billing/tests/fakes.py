"""In-memory stand-ins for the database session, the payment repository and the file store, so
the API tests need no database (test_payments_live.py covers the real ones).

They behave like the real pieces where the API depends on it: each clinic sees only its own
patients, appointments and encounters, as forced row-level security does; the session records
the ``binary_object`` rows ``store_generated`` inserts and counts commits; the store keeps bytes
by key and refuses a key twice. Synthetic data only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from app.core.db import TENANT_ID_INFO_KEY

from ..repository import EncounterLink, NewPayment, PatientForPayment, Practice


class FakeSession:
    """What tenant_db yields in these tests: the clinic it is scoped to, the statements it ran
    (the file rows) and its commits."""

    def __init__(self, tenant_id: UUID) -> None:
        self.tenant_id = tenant_id
        self.info: dict[str, Any] = {TENANT_ID_INFO_KEY: tenant_id}
        self.files: list[dict[str, Any]] = []
        self.commits = 0

    async def execute(self, statement: Any, params: dict[str, Any] | None = None) -> None:
        assert "admin.binary_object" in str(statement), "only the file insert runs on the session"
        self.files.append(dict(params or {}))

    async def commit(self) -> None:
        self.commits += 1


@dataclass
class World:
    """Everything the fakes share, per clinic."""

    patients: dict[UUID, dict[UUID, PatientForPayment]] = field(default_factory=dict)
    appointments: dict[UUID, dict[UUID, UUID]] = field(default_factory=dict)  # → patient
    encounters: dict[UUID, dict[UUID, EncounterLink]] = field(default_factory=dict)
    payments: list[NewPayment] = field(default_factory=list)
    sessions: list[FakeSession] = field(default_factory=list)
    practice: Practice = Practice(name="Lakeside Test Neurology", time_zone="America/Chicago")

    def add_patient(self, clinic: UUID, patient: PatientForPayment) -> None:
        self.patients.setdefault(clinic, {})[patient.id] = patient


class FakeRepository:
    def __init__(self, world: World) -> None:
        self.world = world

    @staticmethod
    def _clinic(db: Any) -> UUID:
        clinic: UUID = db.tenant_id
        return clinic

    async def patient(self, db: Any, patient_id: UUID) -> PatientForPayment | None:
        return self.world.patients.get(self._clinic(db), {}).get(patient_id)

    async def appointment_patient(self, db: Any, appointment_id: UUID) -> UUID | None:
        return self.world.appointments.get(self._clinic(db), {}).get(appointment_id)

    async def encounter(self, db: Any, encounter_id: UUID) -> EncounterLink | None:
        return self.world.encounters.get(self._clinic(db), {}).get(encounter_id)

    async def practice(self, db: Any) -> Practice:
        return self.world.practice

    async def insert_payment(self, db: Any, payment: NewPayment) -> None:
        self.world.payments.append(payment)


class MemoryFileStore:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        if key in self.objects:
            raise FileExistsError(key)
        self.objects[key] = (data, content_type)

    async def get(self, key: str) -> bytes:
        return self.objects[key][0]

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)
