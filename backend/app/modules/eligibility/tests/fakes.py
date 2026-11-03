"""In-memory stand-ins for the eligibility repository, the partner (core's operations and outbox),
the restricted-chart check and the audit hook, so the API tests need no database
(test_eligibility_live.py runs the real ones).

They behave like the real pieces where the API depends on it: each clinic sees only its own rows,
as forced row-level security does; a restricted chart raises ``break-glass-required`` unless the
user holds a grant; checks list newest first. Synthetic data only.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from fastapi import Request

from app.core.deps import CurrentUser
from app.core.errors import Forbidden, NotFound, ServiceUnavailable
from app.core.long_running import Operation

from ..repository import (
    NOT_SENT,
    AppointmentRef,
    AutoAppointment,
    BenefitRow,
    CheckRow,
    CoverageRef,
)

NOW = datetime(2026, 11, 3, 15, 0, tzinfo=UTC)


@dataclass
class FakeSession:
    """What tenant_db yields here: the clinic it is scoped to, and its commits."""

    tenant_id: UUID
    commits: int = 0

    async def commit(self) -> None:
        self.commits += 1


@dataclass
class World:
    coverages: dict[UUID, tuple[UUID, CoverageRef]] = field(default_factory=dict)  # clinic, row
    appointments: dict[UUID, tuple[UUID, AppointmentRef]] = field(default_factory=dict)
    checks: dict[UUID, tuple[UUID, CheckRow]] = field(default_factory=dict)
    service_types: dict[UUID, tuple[str, ...]] = field(default_factory=dict)
    patients: dict[UUID, UUID] = field(default_factory=dict)  # patient → clinic
    merged: set[UUID] = field(default_factory=set)
    restricted: set[UUID] = field(default_factory=set)
    grants: set[tuple[UUID, UUID]] = field(default_factory=set)  # (user, patient)
    practice_npi: str | None = "1234567893"
    sent: list[tuple[UUID, UUID | None]] = field(default_factory=list)  # (check, operation)
    operations: list[Operation] = field(default_factory=list)
    audited: list[list[UUID]] = field(default_factory=list)
    npis: dict[UUID, str | None] = field(default_factory=dict)  # check → provider NPI
    linked: dict[UUID, UUID] = field(default_factory=dict)  # check → outbox message
    connected: bool = True  # the clinic has a clearinghouse connection
    encounter_of: dict[UUID, UUID | None] = field(default_factory=dict)  # check → encounter
    not_required: set[UUID] = field(default_factory=set)  # appointments of a no-check type
    cancelled: set[UUID] = field(default_factory=set)  # appointments not booked
    locks: list[UUID] = field(default_factory=list)  # appointments locked for a check

    # ------------------------------------------------------------------- synthetic set-up
    def patient(self, clinic: UUID) -> UUID:
        patient_id = uuid4()
        self.patients[patient_id] = clinic
        return patient_id

    def coverage(self, clinic: UUID, patient_id: UUID, status: str = "active",
                 end: date | None = None) -> UUID:
        coverage_id = uuid4()
        self.coverages[coverage_id] = (clinic, CoverageRef(coverage_id, patient_id, status,
                                                           date(2026, 1, 1), end))
        return coverage_id

    def appointment(self, clinic: UUID, patient_id: UUID, facility_id: UUID,
                    npi: str | None = "1234567893", day: date = date(2026, 11, 3)) -> UUID:
        appointment_id = uuid4()
        self.appointments[appointment_id] = (clinic, AppointmentRef(
            appointment_id, patient_id, facility_id, day, npi))
        return appointment_id

    def check(self, clinic: UUID, coverage_id: UUID, appointment_id: UUID | None, *,
              status: str = "pending", minutes_ago: int = 0,
              benefits: Sequence[BenefitRow] = ()) -> UUID:
        _, coverage = self.coverages[coverage_id]
        facility = (self.appointments[appointment_id][1].facility_id
                    if appointment_id is not None else None)
        at = NOW - timedelta(minutes=minutes_ago)
        check_id = uuid4()
        answered = status != "pending"
        self.checks[check_id] = (clinic, CheckRow(
            id=check_id, patient_id=coverage.patient_id, coverage_id=coverage_id,
            appointment_id=appointment_id, facility_id=facility, trigger="check-in",
            status=status, requested_at=at,
            responded_at=at + timedelta(seconds=9) if answered and status != "timeout" else None,
            plan_name="Test PPO" if answered else None,
            coverage_start=date(2026, 1, 1) if answered else None, coverage_end=None,
            error_code={"error": "72", "timeout": "timeout"}.get(status),
            error_message={"error": "The payer reports an invalid member ID.",
                           "timeout": "The payer did not answer in time."}.get(status),
            expires_at=at + timedelta(hours=24) if answered else None,
            updated_at=at, benefits=tuple(benefits)))
        return check_id


class FakeRepository:
    def __init__(self, world: World) -> None:
        self.world = world

    async def coverage(self, db: Any, coverage_id: UUID) -> CoverageRef | None:
        found = self.world.coverages.get(coverage_id)
        return found[1] if found and found[0] == db.tenant_id else None

    async def appointment(self, db: Any, appointment_id: UUID) -> AppointmentRef | None:
        found = self.world.appointments.get(appointment_id)
        return found[1] if found and found[0] == db.tenant_id else None

    async def patient_merged(self, db: Any, patient_id: UUID) -> bool:
        return patient_id in self.world.merged

    async def practice_npi(self, db: Any) -> str | None:
        return self.world.practice_npi

    async def insert_pending(self, db: Any, *, coverage_id: UUID, patient_id: UUID,
                             appointment_id: UUID | None, encounter_id: UUID | None,
                             trigger: str, provider_npi: str | None = None,
                             service_type_codes: Sequence[str] = ()) -> UUID:
        check_id = self.world.check(db.tenant_id, coverage_id, appointment_id)
        clinic, row = self.world.checks[check_id]
        self.world.checks[check_id] = (clinic, replace(row, trigger=trigger))
        self.world.service_types[check_id] = tuple(service_type_codes)
        self.world.npis[check_id] = provider_npi
        self.world.encounter_of[check_id] = encounter_id
        return check_id

    async def link_message(self, db: Any, check_id: UUID, message_id: UUID) -> None:
        self.world.linked[check_id] = message_id

    async def get(self, db: Any, check_id: UUID) -> CheckRow | None:
        found = self.world.checks.get(check_id)
        return found[1] if found and found[0] == db.tenant_id else None

    async def for_appointment(self, db: Any, appointment_id: UUID, *, limit: int,
                              offset: int) -> list[CheckRow]:
        rows = sorted((r for c, r in self.world.checks.values()
                       if c == db.tenant_id and r.appointment_id == appointment_id),
                      key=lambda r: (r.requested_at, r.id), reverse=True)
        return rows[offset:offset + limit]


    # ----------------------------------------- automatic checks (AutoCheckRepository)
    async def auto_appointment(self, db: Any, appointment_id: UUID) -> AutoAppointment | None:
        found = await self.appointment(db, appointment_id)
        if found is None:
            return None
        return AutoAppointment(
            id=found.id, patient_id=found.patient_id,
            status="cancelled" if appointment_id in self.world.cancelled else "booked",
            local_day=found.local_day, provider_npi=found.provider_npi,
            required=appointment_id not in self.world.not_required)

    async def primary_coverage(self, db: Any, patient_id: UUID, on: date) -> UUID | None:
        found = [c for clinic, c in self.world.coverages.values()
                 if clinic == db.tenant_id and c.patient_id == patient_id and c.status == "active"
                 and (c.period_start is None or c.period_start <= on)
                 and (c.period_end is None or c.period_end >= on)]
        return found[0].id if found else None

    async def lock_appointment_checks(self, db: Any, appointment_id: UUID) -> None:
        self.world.locks.append(appointment_id)

    async def existing_check(self, db: Any, appointment_id: UUID, trigger: str,
                             encounter_id: UUID | None) -> UUID | None:
        for check_id, (clinic, row) in self.world.checks.items():
            if (clinic == db.tenant_id and row.appointment_id == appointment_id
                    and row.trigger == trigger and (
                        encounter_id is None
                        or self.world.encounter_of.get(check_id) == encounter_id)):
                return check_id
        return None

    async def fresh_check(self, db: Any, coverage_id: UUID, now: datetime,
                          since: datetime) -> bool:
        return any(clinic == db.tenant_id and row.coverage_id == coverage_id and (
            (row.status == "pending" and row.requested_at > since)
            or (row.status in ("active", "inactive", "not-found")
                and row.expires_at is not None and row.expires_at > now))
            for clinic, row in self.world.checks.values())

    async def mark_not_sent(self, db: Any, check_id: UUID, message: str) -> None:
        clinic, row = self.world.checks[check_id]
        if row.status == "pending":
            self.world.checks[check_id] = (clinic, replace(
                row, status="error", error_code=NOT_SENT, error_message=message,
                responded_at=row.requested_at))

    async def booked_on(self, db: Any, day: date) -> list[UUID]:
        return [a.id for clinic, a in self.world.appointments.values()
                if clinic == db.tenant_id and a.local_day == day
                and a.id not in self.world.cancelled]


class FakePartner:
    def __init__(self, world: World) -> None:
        self.world = world

    async def start(self, db: Any) -> Operation:
        operation = Operation(id=uuid4(), kind="eligibility.check", status="queued",
                              created_by_user_id=uuid4(), created_at=NOW, updated_at=NOW)
        self.world.operations.append(operation)
        return operation

    async def send_270(self, db: Any, check_id: UUID, operation_id: UUID | None) -> UUID:
        if not self.world.connected:  # as core's enqueue: refused before anything is written
            raise ServiceUnavailable("No clearinghouse connection is set up for this practice")
        self.world.sent.append((check_id, operation_id))
        return uuid4()


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
