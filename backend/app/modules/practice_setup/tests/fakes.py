"""An in-memory stand-in for the repository, so the API tests need no database
(test_practice_setup_live.py covers the real reads).

It behaves like the real one where the API depends on it:
- each clinic sees only its own rows, as forced row-level security does; payers are
  platform-wide, the same for every clinic;
- every list is keyset-paginated on the same sort key plus ID as the SQL, fetching one row more
  than the page to know whether another page exists.
Synthetic data only.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from .. import schemas
from ..cursor import Kind, Position
from ..repository import Page

T0 = datetime(2026, 10, 26, 13, 0, tzinfo=UTC)


@dataclass
class FakeSession:
    """What tenant_db yields in these tests: the clinic it is scoped to."""

    tenant_id: UUID


@dataclass
class Clinic:
    facilities: list[schemas.Facility] = field(default_factory=list)
    providers: list[schemas.Provider] = field(default_factory=list)
    appointment_types: list[schemas.AppointmentType] = field(default_factory=list)
    schedules: list[schemas.ProviderSchedule] = field(default_factory=list)
    practice_payers: list[schemas.PracticePayer] = field(default_factory=list)


@dataclass
class World:
    clinics: dict[UUID, Clinic] = field(default_factory=dict)
    payers: list[schemas.Payer] = field(default_factory=list)

    def clinic(self, tenant_id: UUID) -> Clinic:
        return self.clinics.setdefault(tenant_id, Clinic())


def _page[T](items: Iterable[T], keep: Callable[[T], bool], key: Callable[[T], Any], kind: Kind,
             after: Position | None, limit: int) -> Page[T]:
    def sort_key(item: T) -> tuple[Any, UUID]:
        return key(item), item.id  # type: ignore[attr-defined]

    rows = sorted((i for i in items if keep(i)), key=sort_key)
    if after is not None:
        rows = [i for i in rows if sort_key(i) > (after.key, after.id)]
    found = rows[:limit + 1]
    if len(found) <= limit:
        return Page(found, None)
    last = found[limit - 1]
    return Page(found[:limit], Position(kind=kind, key=key(last), id=last.id))  # type: ignore[attr-defined]


def _active(active: bool | None) -> Callable[[Any], bool]:
    return lambda item: active is None or item.active == active


class FakeRepository:
    def __init__(self, world: World) -> None:
        self.world = world

    def _clinic(self, db: AsyncSession) -> Clinic:
        session: FakeSession = db  # type: ignore[assignment]
        return self.world.clinic(session.tenant_id)

    async def list_facilities(self, db: AsyncSession, *, active: bool | None,
                              after: Position | None, limit: int) -> Page[schemas.Facility]:
        return _page(self._clinic(db).facilities, _active(active), lambda f: f.name,
                     "facilities", after, limit)

    async def list_providers(self, db: AsyncSession, *, facility_id: UUID | None,
                             active: bool | None, after: Position | None, limit: int
                             ) -> Page[schemas.Provider]:
        def keep(p: schemas.Provider) -> bool:
            return (_active(active)(p)
                    and (facility_id is None or facility_id in p.facility_ids))
        return _page(self._clinic(db).providers, keep, lambda p: p.created_at, "providers",
                     after, limit)

    async def list_appointment_types(self, db: AsyncSession, *, active: bool | None,
                                     after: Position | None, limit: int
                                     ) -> Page[schemas.AppointmentType]:
        return _page(self._clinic(db).appointment_types, _active(active), lambda t: t.name,
                     "appointment-types", after, limit)

    async def list_provider_schedules(self, db: AsyncSession, *, provider_id: UUID | None,
                                      facility_id: UUID | None, active: bool | None,
                                      after: Position | None, limit: int
                                      ) -> Page[schemas.ProviderSchedule]:
        def keep(s: schemas.ProviderSchedule) -> bool:
            return (_active(active)(s)
                    and (provider_id is None or s.provider_id == provider_id)
                    and (facility_id is None or s.facility_id == facility_id))
        return _page(self._clinic(db).schedules, keep, lambda s: s.created_at,
                     "provider-schedules", after, limit)

    async def list_payers(self, db: AsyncSession, *, payer_name: str | None,
                          external_payer_id: str | None, payer_type: str | None,
                          active: bool | None, after: Position | None, limit: int
                          ) -> Page[schemas.Payer]:
        def keep(p: schemas.Payer) -> bool:
            return (_active(active)(p)
                    and (payer_name is None or payer_name.lower() in p.name.lower())
                    and (external_payer_id is None
                         or any(c.external_payer_id == external_payer_id
                                for c in p.clearinghouse_ids))
                    and (payer_type is None or p.payer_type == payer_type))
        return _page(self.world.payers, keep, lambda p: p.name, "payers", after, limit)

    async def list_practice_payers(self, db: AsyncSession, *, active: bool | None,
                                   after: Position | None, limit: int
                                   ) -> Page[schemas.PracticePayer]:
        return _page(self._clinic(db).practice_payers, _active(active), lambda p: p.payer.name,
                     "practice-payers", after, limit)


# ----------------------------------------------------------------------------------- builders
def _at(n: int) -> datetime:
    return T0 + timedelta(minutes=n)


def facility(name: str, *, active: bool = True, n: int = 0) -> schemas.Facility:
    return schemas.Facility(
        id=uuid4(), code=name.split()[-1].upper(), name=name,
        time_zone="America/Chicago",
        address=schemas.Address(lines=["200 Test Avenue"], city="Springfield", state="IL",
                                postal_code="62702"),
        phone="+12175550110", npi="1234567893", place_of_service_code="11",
        billing_location=True, active=active, created_at=_at(n), updated_at=_at(n))


def provider(family: str, facility_ids: list[UUID], *, active: bool = True, n: int = 0
             ) -> schemas.Provider:
    return schemas.Provider(
        id=uuid4(), name=schemas.HumanName(family=family, given=["Test"], prefix="Dr."),
        npi="1245319599", gender="female",
        qualifications=[schemas.ProviderQualification(
            code=schemas.SetupCoding(system="http://terminology.hl7.org/CodeSystem/v2-0360",
                                     code="MD"),
            license_number="TEST-LIC-0042", state="IL", start_date=date(2015, 7, 1))],
        specialties=[schemas.SetupCoding(system="http://nucc.org/provider-taxonomy",
                                         code="207R00000X", display="Internal Medicine")],
        facility_ids=facility_ids, phone="+12175550120", email="test.provider@example.com",
        active=active, created_at=_at(n), updated_at=_at(n))


def appointment_type(name: str, *, active: bool = True, n: int = 0) -> schemas.AppointmentType:
    return schemas.AppointmentType(
        id=uuid4(), code=name[:10].upper().replace(" ", ""), name=name,
        default_duration_minutes=20, color="#2E7D32", allow_overlap=False, max_overbook=1,
        requires_eligibility_check=True, telehealth=False, new_patient=False, active=active,
        created_at=_at(n), updated_at=_at(n))


def schedule(provider_id: UUID, facility_id: UUID, *, active: bool = True, n: int = 0
             ) -> schemas.ProviderSchedule:
    return schemas.ProviderSchedule(
        id=uuid4(), provider_id=provider_id, facility_id=facility_id,
        availability_rules=[schemas.AvailabilityRule(
            id=uuid4(), day_of_week="tue", start_time="08:00", end_time="12:00",
            slot_minutes=20, appointment_type_ids=[], start_date=date(2026, 11, 1))],
        exceptions=[schemas.ScheduleException(
            id=uuid4(), start_at=datetime(2026, 11, 24, 14, tzinfo=UTC),
            end_at=datetime(2026, 11, 24, 18, tzinfo=UTC), available=False,
            reason="Conference")],
        active=active, created_at=_at(n), updated_at=_at(n))


def payer(name: str, *, payer_type: str = "commercial", external_id: str | None = None,
          active: bool = True) -> schemas.Payer:
    return schemas.Payer(
        id=uuid4(), name=name, payer_type=payer_type,
        clearinghouse_ids=[schemas.ClearinghouseId(clearinghouse="waystar",
                                                   external_payer_id=external_id)]
        if external_id else [],
        supports_eligibility=True, supports_claim_status=True, supports_era=True,
        active=active)


def practice_payer(of: schemas.Payer, *, active: bool = True, n: int = 0
                   ) -> schemas.PracticePayer:
    return schemas.PracticePayer(
        id=uuid4(), payer_id=of.id,
        payer=schemas.PayerSummary(id=of.id, name=of.name, payer_type=of.payer_type),
        enrollments=[
            schemas.PayerEnrollment(transaction="270", clearinghouse="waystar",
                                    status="not-required"),
            schemas.PayerEnrollment(transaction="837P", clearinghouse="waystar",
                                    status="approved", submitted_at=_at(1), approved_at=_at(2)),
        ],
        active=active, created_at=_at(n), updated_at=_at(n))
