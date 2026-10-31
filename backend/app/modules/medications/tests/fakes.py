"""In-memory stand-ins for the medications repository (with the write helpers' rules), the
partner (outbox and events), the restricted-chart check and the audit hook, so the API tests need
no database (test_medications_live.py runs the real ones).

They behave like the real pieces where the API depends on it: each clinic sees only its own rows,
as forced row-level security does; a restricted chart raises ``break-glass-required`` unless the
user holds a grant; a stale version raises ``StaleVersion``, a signed prescription
``InvalidTransition``; signing refuses as ``sign_prescription`` does. Synthetic data only.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from fastapi import Request

from app.core.deps import CurrentUser
from app.core.errors import Forbidden, NotFound
from app.db import fhir_store as fs
from app.db.models.systems import RXNORM

from .. import rules, service
from ..repository import (
    AlertRow,
    Drug,
    EncounterRef,
    MedicationRow,
    PatientRef,
    PrescriptionRow,
    SafetyFacts,
    TransmissionRow,
)

NOW = datetime(2026, 11, 20, 15, 20, tzinfo=UTC)
AMOXICILLIN = Drug(RXNORM, "308191", "amoxicillin 500 MG Oral Capsule", None)
LISINOPRIL = Drug(RXNORM, "314076", "lisinopril 10 MG Oral Tablet", None)
SEVERITY = {"info": "low", "warning": "moderate", "high": "high"}
CODE = {"allergy": "ALGY", "duplicate-medication": "DUPTHPY"}


@dataclass
class FakeSession:
    """What tenant_db yields here: the clinic it is scoped to, and its commits."""

    tenant_id: UUID
    commits: int = 0

    async def commit(self) -> None:
        self.commits += 1


@dataclass
class World:
    patients: dict[UUID, UUID] = field(default_factory=dict)  # patient → clinic
    merged: set[UUID] = field(default_factory=set)
    restricted: set[UUID] = field(default_factory=set)
    grants: set[tuple[UUID, UUID]] = field(default_factory=set)  # (user, patient)
    encounters: dict[UUID, tuple[UUID, EncounterRef]] = field(default_factory=dict)
    pharmacies: dict[UUID, bool] = field(default_factory=dict)  # platform-wide: active?
    practitioners: dict[UUID, UUID] = field(default_factory=dict)  # user → practitioner
    entries: dict[UUID, tuple[UUID, MedicationRow]] = field(default_factory=dict)
    prescriptions: dict[UUID, tuple[UUID, PrescriptionRow]] = field(default_factory=dict)
    allergies: dict[UUID, list[rules.Allergy]] = field(default_factory=dict)  # by patient
    ingredients: dict[str, frozenset[str]] = field(default_factory=dict)  # RxNorm code →
    schedules: dict[str, str] = field(default_factory=dict)  # RxNorm code → DEA schedule
    known: set[str] = field(default_factory=lambda: {"308191", "314076", "7980", "723"})
    sent: list[UUID] = field(default_factory=list)  # prescriptions whose NewRx was queued
    events: list[tuple[str, UUID, dict[str, Any]]] = field(default_factory=list)
    audited: list[list[UUID]] = field(default_factory=list)
    clock: datetime = NOW

    def tick(self) -> datetime:
        self.clock += timedelta(seconds=1)
        return self.clock

    # ------------------------------------------------------------------- synthetic set-up
    def patient(self, clinic: UUID) -> UUID:
        patient_id = uuid4()
        self.patients[patient_id] = clinic
        return patient_id

    def encounter(self, clinic: UUID, patient_id: UUID, facility_id: UUID,
                  status: str = "in-progress") -> UUID:
        encounter_id = uuid4()
        self.encounters[encounter_id] = (clinic, EncounterRef(encounter_id, patient_id, status,
                                                              facility_id))
        return encounter_id

    def pharmacy(self, active: bool = True) -> UUID:
        pharmacy_id = uuid4()
        self.pharmacies[pharmacy_id] = active
        return pharmacy_id

    def entry(self, clinic: UUID, patient_id: UUID, drug: Drug = LISINOPRIL,
              status: str = "active") -> UUID:
        entry_id = uuid4()
        self.entries[entry_id] = (clinic, MedicationRow(
            id=entry_id, patient_id=patient_id, intent="plan", status=status, drug=drug,
            dosage_text="1 tablet by mouth once daily", note=None, recorded_at=self.tick(),
            recorded_by=None))
        return entry_id

    def allergy(self, patient_id: UUID, code: str, name: str, *, status: str = "active",
                verification: str | None = "confirmed") -> UUID:
        allergy_id = uuid4()
        self.allergies.setdefault(patient_id, []).append(rules.Allergy(
            id=allergy_id, clinical_status=status, verification_status=verification, name=name,
            ingredients=self.ingredients.get(code, frozenset({code}))))
        return allergy_id

    def row(self, prescription_id: UUID) -> PrescriptionRow:
        return self.prescriptions[prescription_id][1]

    def put(self, row: PrescriptionRow) -> None:
        clinic, _ = self.prescriptions[row.id]
        self.prescriptions[row.id] = (clinic, row)


class FakeRepository:
    def __init__(self, world: World) -> None:
        self.world = world

    def _mine[T](self, db: Any, found: tuple[UUID, T] | None) -> T | None:
        return found[1] if found is not None and found[0] == db.tenant_id else None

    # ---------------------------------------------------------------------------- reads
    async def patient(self, db: Any, patient_id: UUID) -> PatientRef | None:
        if self.world.patients.get(patient_id) != db.tenant_id:
            return None
        return PatientRef(patient_id, patient_id in self.world.merged)

    async def encounter(self, db: Any, encounter_id: UUID) -> EncounterRef | None:
        return self._mine(db, self.world.encounters.get(encounter_id))

    async def pharmacy_active(self, db: Any, pharmacy_id: UUID) -> bool | None:
        return self.world.pharmacies.get(pharmacy_id)

    async def practitioner_of_user(self, db: Any, user_id: UUID) -> UUID | None:
        return self.world.practitioners.get(user_id)

    async def dea_schedule(self, db: Any, drug: Drug) -> str | None:
        return self.world.schedules.get(drug.code or "") if drug.system == RXNORM else None

    async def known_rxnorm(self, db: Any, code: str) -> bool:
        return code in self.world.known

    def _signed(self, db: Any) -> list[MedicationRow]:
        return [MedicationRow(id=r.id, patient_id=r.patient_id, intent="order", status=r.status,
                              drug=r.drug, dosage_text=r.dosage_text, note=None,
                              recorded_at=r.signed_at, recorded_by=r.signed_by)
                for c, r in self.world.prescriptions.values()
                if c == db.tenant_id and r.signed_at is not None]

    async def medications(self, db: Any, patient_id: UUID, statuses: Sequence[str], *,
                          limit: int, offset: int) -> list[MedicationRow]:
        rows = [r for c, r in self.world.entries.values() if c == db.tenant_id]
        rows += self._signed(db)
        rows = [r for r in rows if r.patient_id == patient_id and r.status in statuses]
        rows.sort(key=lambda r: r.id)
        rows.sort(key=lambda r: r.recorded_at, reverse=True)
        rows.sort(key=lambda r: r.status != "active")
        return rows[offset:offset + limit]

    async def medication(self, db: Any, medication_id: UUID) -> MedicationRow | None:
        found = self._mine(db, self.world.entries.get(medication_id))
        return found or next((r for r in self._signed(db) if r.id == medication_id), None)

    async def prescription(self, db: Any, prescription_id: UUID) -> PrescriptionRow | None:
        return self._mine(db, self.world.prescriptions.get(prescription_id))

    async def alert_prescription(self, db: Any, alert_id: UUID) -> UUID | None:
        for clinic, row in self.world.prescriptions.values():
            if clinic == db.tenant_id and any(a.id == alert_id for a in row.alerts):
                return row.id
        return None

    async def safety_facts(self, db: Any, row: PrescriptionRow) -> SafetyFacts:
        def ingredients(drug: Drug) -> frozenset[str]:
            if drug.system != RXNORM or not drug.code:
                return frozenset()
            return self.world.ingredients.get(drug.code, frozenset({drug.code}))

        others = [r for r in await self.medications(db, row.patient_id,
                                                    ("active", "completed", "stopped"),
                                                    limit=1000, offset=0) if r.id != row.id]
        return SafetyFacts(
            drug=rules.Drug(name=row.drug.display or row.drug.text or "this drug",
                            ingredients=ingredients(row.drug)),
            allergies=tuple(self.world.allergies.get(row.patient_id, [])),
            medications=tuple(rules.ListEntry(id=r.id, status=r.status,
                                              name=r.drug.display or "", ingredients=ingredients(
                                                  r.drug)) for r in others))

    # ---------------------------------------------------------------------------- writes
    def _locked(self, db: Any, prescription_id: UUID, if_version: int | None) -> PrescriptionRow:
        row = self._mine(db, self.world.prescriptions.get(prescription_id))
        if row is None:
            raise fs.ResourceNotFound
        if if_version is not None and row.version != if_version:
            raise fs.StaleVersion(row.version)
        return row

    async def record_medication(self, db: Any, data: fs.MedicationIn) -> UUID:
        entry_id = uuid4()
        m = data.medication
        self.world.entries[entry_id] = (db.tenant_id, MedicationRow(
            id=entry_id, patient_id=data.patient_id, intent="plan", status=data.status,
            drug=Drug(m.system, m.code, m.display, m.text), dosage_text=data.dosage_text,
            note=data.note, recorded_at=self.world.tick(), recorded_by=None))
        return entry_id

    async def create_prescription(self, db: Any, data: fs.PrescriptionIn) -> fs.Written:
        rid, now, m = uuid4(), self.world.tick(), data.medication
        encounter = self.world.encounters.get(data.encounter_id) if data.encounter_id else None
        q = data.quantity
        self.world.prescriptions[rid] = (db.tenant_id, PrescriptionRow(
            id=rid, patient_id=data.patient_id, encounter_id=data.encounter_id,
            facility_id=encounter[1].facility_id if encounter else None, status="draft",
            drug=Drug(m.system, m.code, m.display, m.text), dosage_text=data.dosage_text,
            quantity_value=q.value if q else None, quantity_unit=q.unit if q else None,
            days_supply=Decimal(data.days_supply) if data.days_supply is not None else None,
            refills=data.refills, substitution_allowed=data.substitution_allowed,
            pharmacy_id=data.pharmacy_id, note_to_pharmacy=data.note_to_pharmacy,
            dea_schedule=data.dea_schedule, signed_by=None, signed_at=None, version=1,
            safety_checked_at=None, created_at=now, updated_at=now, alerts=(),
            transmission=None))
        return fs.Written(rid, 1, now)

    async def update_prescription(self, db: Any, prescription_id: UUID,
                                  changes: fs.PrescriptionChanges, *, if_version: int
                                  ) -> fs.Written:
        row = self._locked(db, prescription_id, if_version)
        if row.status != "draft":
            raise fs.InvalidTransition(row.status)
        given: dict[str, Any] = {}
        if changes.medication is not fs.UNSET:
            m = changes.medication
            given["drug"] = Drug(m.system, m.code, m.display, m.text)
        if changes.quantity is not fs.UNSET:
            q = changes.quantity
            given |= {"quantity_value": q.value if q else None,
                      "quantity_unit": q.unit if q else None}
        if changes.days_supply is not fs.UNSET:
            d = changes.days_supply
            given["days_supply"] = Decimal(d) if d is not None else None
        for name, column in (("dosage_text", "dosage_text"), ("refills", "refills"),
                             ("substitution_allowed", "substitution_allowed"),
                             ("pharmacy_id", "pharmacy_id"),
                             ("note_to_pharmacy", "note_to_pharmacy"),
                             ("dea_schedule", "dea_schedule")):
            if getattr(changes, name) is not fs.UNSET:
                given[column] = getattr(changes, name)
        now = self.world.tick()
        self.world.put(replace(row, **given, version=row.version + 1, safety_checked_at=None,
                               updated_at=now))
        return fs.Written(row.id, row.version + 1, now)

    async def prescription_entered_in_error(self, db: Any, prescription_id: UUID, reason: str,
                                            *, if_version: int | None) -> fs.Written:
        row = self._locked(db, prescription_id, if_version)
        if row.status != "draft":
            raise fs.InvalidTransition(row.status)
        now = self.world.tick()
        self.world.put(replace(row, status="entered-in-error", version=row.version + 1,
                               safety_checked_at=None, alerts=(), updated_at=now))
        return fs.Written(row.id, row.version + 1, now)

    async def record_safety_check(self, db: Any, prescription_id: UUID,
                                  alerts: tuple[fs.AlertIn, ...], *, if_version: int
                                  ) -> fs.SafetyCheckWritten:
        row = self._locked(db, prescription_id, if_version)
        if row.status != "draft":
            raise fs.InvalidTransition(row.status)
        now = self.world.tick()
        stored = sorted((AlertRow(id=uuid4(), code=CODE[a.kind], severity=SEVERITY[a.severity],
                                  message=a.message, allergy_id=a.allergy_id,
                                  medication_id=a.medication_id, override_reason=None,
                                  overridden_by=None, overridden_at=None) for a in alerts),
                        key=lambda a: a.id)
        self.world.put(replace(row, alerts=tuple(stored), safety_checked_at=now))
        return fs.SafetyCheckWritten(row.id, now, row.version, tuple(a.id for a in stored))

    async def override_alert(self, db: Any, alert_id: UUID, reason: str) -> fs.Written:
        prescription_id = await self.alert_prescription(db, alert_id)
        if prescription_id is None:
            raise fs.ResourceNotFound
        row = self._locked(db, prescription_id, None)
        user = next(iter(self.world.practitioners))  # the fakes' one prescriber
        now = self.world.tick()
        self.world.put(replace(row, alerts=tuple(
            replace(a, override_reason=reason, overridden_by=user, overridden_at=now)
            if a.id == alert_id else a for a in row.alerts)))
        return fs.Written(alert_id, 2, now)

    async def sign_prescription(self, db: Any, prescription_id: UUID, *, if_version: int,
                                integration_message_id: UUID | None) -> fs.Written:
        row = self._locked(db, prescription_id, if_version)
        if row.status != "draft":
            raise fs.InvalidTransition(row.status)
        refusals = service.sign_refusals(row)
        if refusals:
            raise fs.SignRefused(tuple(refusals))
        now = self.world.tick()
        signer = next(iter(self.world.practitioners))
        self.world.put(replace(row, status="active", signed_at=now, signed_by=signer,
                               version=row.version + 1, updated_at=now,
                               transmission=TransmissionRow("queued", now, None)))
        return fs.Written(row.id, row.version + 1, now)


class FakePartner:
    def __init__(self, world: World) -> None:
        self.world = world

    async def send_new_rx(self, db: Any, prescription_id: UUID) -> UUID:
        self.world.sent.append(prescription_id)
        return uuid4()

    async def announce(self, db: Any, event: str, prescription_id: UUID, data: Any, *,
                       patient_id: UUID | None, facility_id: UUID | None) -> None:
        self.world.events.append((event, prescription_id, dict(data)))


def fake_chart_check(world: World) -> Any:
    async def check(db: Any, user: CurrentUser, patient_id: UUID) -> None:
        if world.patients.get(patient_id) != db.tenant_id:
            raise NotFound()
        if patient_id in world.restricted and (user.id, patient_id) not in world.grants:
            raise Forbidden("This chart is restricted", code="break-glass-required")
    return check


def recording_audit(world: World) -> Any:
    def audit(request: Request, patient_ids: Iterable[UUID]) -> None:
        world.audited.append(list(patient_ids))
    return audit
