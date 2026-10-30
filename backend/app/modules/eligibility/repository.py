"""Eligibility rows, under the caller's session (forced row-level security keeps each clinic to its
own rows).

The check itself is this module's (``admin.eligibility_check``, ``eligibility_service_type``,
``eligibility_benefit``). The coverage, the patient and the appointment are Vimal's other modules'
(patients, scheduling), read here with plain SQL because scheduling already imports this module.
The payer's name and clearinghouse ID, the provider's NPI and the clinic's time zone are Anand's
practice setup, read directly as scheduling's ``reference.py`` does until his read services land
(IMPL_BATCH1_PLAN §0, "Rule I keep"). The contract's ``status`` and ``coverageStatus`` are one
column, mapped as ``backend/app/db/CLAUDE.md`` says.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MAPPERS
from app.db.models.systems import NPI

M = MAPPERS
CLEARINGHOUSE = "clearinghouse"  # the outbox partner (D25); the vendor is Q11


# ---------------------------------------------------------------------------------- rows
@dataclass(frozen=True)
class CoverageRef:
    id: UUID
    patient_id: UUID
    status: str
    period_start: date | None
    period_end: date | None


@dataclass(frozen=True)
class AppointmentRef:
    id: UUID
    patient_id: UUID
    facility_id: UUID | None
    local_day: date  # the appointment's day in the facility's time zone (D40)
    provider_npi: str | None


@dataclass(frozen=True)
class BenefitRow:
    benefit_type: str
    service_type_code: str | None
    coverage_level: str | None
    network: str | None
    time_period: str | None
    amount: Decimal | None
    percent: Decimal | None
    authorization_required: bool | None
    message: str | None


@dataclass(frozen=True)
class CheckRow:
    id: UUID
    patient_id: UUID
    coverage_id: UUID
    appointment_id: UUID | None
    facility_id: UUID | None  # the appointment's
    trigger: str
    status: str  # the database's one column (pending, active, inactive, not-found, error, timeout)
    requested_at: datetime
    responded_at: datetime | None
    plan_name: str | None
    coverage_start: date | None
    coverage_end: date | None
    error_code: str | None
    error_message: str | None
    expires_at: datetime | None
    updated_at: datetime
    benefits: tuple[BenefitRow, ...] = ()


@dataclass(frozen=True)
class Reply:
    """What a 271 changes on the check."""

    status: str  # active, inactive, not-found or error
    responded_at: datetime
    plan_name: str | None
    coverage_start: date | None
    coverage_end: date | None
    error_code: str | None
    error_message: str | None
    expires_at: datetime | None
    benefits: tuple[BenefitRow, ...]


@dataclass(frozen=True)
class Person:
    family: str | None
    given: tuple[str, ...]
    birth_date: date | None


@dataclass(frozen=True)
class RequestData:
    """Everything the 270 is built from (service.build_request)."""

    check_id: UUID
    status: str
    service_date: date
    service_type_codes: tuple[str, ...]
    provider_npi: str | None
    payer_name: str | None
    payer_clearinghouse_id: str | None
    relationship: str | None
    member_id: str | None
    subscriber_id: str | None
    group_number: str | None
    patient: Person
    subscriber: Person | None  # the related person who holds the policy, when not the patient


class EligibilityRepository(Protocol):
    """What the API reads and writes; the tests replace it with an in-memory fake."""

    async def coverage(self, db: AsyncSession, coverage_id: UUID) -> CoverageRef | None: ...

    async def appointment(self, db: AsyncSession, appointment_id: UUID
                          ) -> AppointmentRef | None: ...

    async def patient_merged(self, db: AsyncSession, patient_id: UUID) -> bool: ...

    async def practice_npi(self, db: AsyncSession) -> str | None: ...

    async def insert_pending(self, db: AsyncSession, *, coverage_id: UUID, patient_id: UUID,
                             appointment_id: UUID | None, encounter_id: UUID | None,
                             trigger: str, provider_npi: str | None = None,
                             service_type_codes: Sequence[str] = ()) -> UUID: ...

    async def link_message(self, db: AsyncSession, check_id: UUID, message_id: UUID) -> None: ...

    async def get(self, db: AsyncSession, check_id: UUID) -> CheckRow | None: ...

    async def for_appointment(self, db: AsyncSession, appointment_id: UUID, *, limit: int,
                              offset: int) -> list[CheckRow]: ...


# ----------------------------------------------------------------------------------- SQL
_PRIMARY = text("""
SELECT c.id FROM clinical.coverage c
WHERE c.beneficiary_patient_id = :patient AND c.status = 'active'
  AND (c.period_start IS NULL OR c.period_start <= :on)
  AND (c.period_end IS NULL OR c.period_end >= :on)
ORDER BY c."order" NULLS LAST, c.created_at
LIMIT 1
""")
_COVERAGE = text("""
SELECT id, beneficiary_patient_id, status, period_start, period_end
FROM clinical.coverage WHERE id = :id
""")
# The provider asking: the NPI of the appointment's practitioner, otherwise its facility's.
_APPOINTMENT = text("""
SELECT a.id, a.subject_patient_id, a.ext_facility_id,
       (a.start AT TIME ZONE coalesce(f.timezone, t.timezone, 'UTC'))::date AS local_day,
       coalesce((SELECT i.value FROM clinical.appointment_participant p
                   JOIN clinical.identifier i ON i.practitioner_id = p.actor_practitioner_id
                  WHERE p.appointment_id = a.id AND i.system = :npi
                  ORDER BY p.created_at, i.created_at LIMIT 1), f.npi) AS provider_npi
FROM clinical.appointment a
LEFT JOIN admin.facility f ON f.id = a.ext_facility_id
LEFT JOIN admin.tenant t ON t.id = a.tenant_id
WHERE a.id = :id
""")
_MERGED = text("""
SELECT EXISTS (SELECT 1 FROM clinical.patient_link l
               WHERE l.patient_id = :id AND l.type = 'replaced-by')
""")
# The practice's own NPI (type-2), for a check that names no appointment: its provider
# organization's (Organization type `prov`).
_PRACTICE_NPI = text("""
SELECT i.value FROM clinical.identifier i
JOIN clinical.organization o ON o.id = i.organization_id
WHERE i.system = :npi AND o.type_code = 'prov'
ORDER BY o.created_at, i.created_at LIMIT 1
""")
_NOW_AND_USER = text(
    "SELECT now(), NULLIF(current_setting('app.current_user_id', true), '')")
_LINK = text("UPDATE admin.eligibility_check SET integration_message_id = :message "
             "WHERE id = :id")
_CHECKS = """
SELECT e.id, e.patient_id, e.coverage_id, e.appointment_id, a.ext_facility_id AS facility_id,
       e.trigger, e.status, e.requested_at, e.responded_at, e.plan_name, e.coverage_start,
       e.coverage_end, e.error_code, e.error_message, e.expires_at, e.updated_at
FROM admin.eligibility_check e
LEFT JOIN clinical.appointment a ON a.id = e.appointment_id
"""
_ONE = text(_CHECKS + "WHERE e.id = :id")
_FOR_APPOINTMENT = text(_CHECKS + """WHERE e.appointment_id = :appointment
ORDER BY e.requested_at DESC, e.id DESC LIMIT :limit OFFSET :offset""")
_BENEFITS = text("""
SELECT eligibility_check_id, benefit_type, service_type_code, coverage_level, network,
       time_period, amount, percent, authorization_required, message
FROM admin.eligibility_benefit WHERE eligibility_check_id = ANY(:ids)
ORDER BY created_at, id
""")
_LOCK = text("SELECT status FROM admin.eligibility_check WHERE id = :id FOR UPDATE")
_REPLY = text("""
UPDATE admin.eligibility_check SET status = :status, responded_at = :responded_at,
       plan_name = :plan_name, coverage_start = :coverage_start, coverage_end = :coverage_end,
       error_code = :error_code, error_message = :error_message, expires_at = :expires_at,
       updated_at = now(),
       updated_by_user_id = CAST(NULLIF(current_setting('app.current_user_id', true), '')
                                 AS uuid)
WHERE id = :id
""")
_TIMED_OUT = text("""
UPDATE admin.eligibility_check SET status = 'timeout', error_code = 'timeout',
       error_message = :message, updated_at = now(),
       updated_by_user_id = CAST(NULLIF(current_setting('app.current_user_id', true), '')
                                 AS uuid)
WHERE id = :id AND status = 'pending'
""")
# What the 270 needs, in one read. The service date is the appointment's day in the facility's
# time zone, otherwise the day the check was asked for in the clinic's. The NPI is the one stored
# with the check, else (a check recorded by check-in or booking) the appointment's practitioner's,
# its facility's, or the practice's.
_REQUEST = text("""
SELECT e.id, e.status, e.coverage_id, e.patient_id,
       coalesce(e.provider_npi,
                (SELECT i.value FROM clinical.appointment_participant p
                   JOIN clinical.identifier i ON i.practitioner_id = p.actor_practitioner_id
                  WHERE p.appointment_id = a.id AND i.system = :npi
                  ORDER BY p.created_at, i.created_at LIMIT 1),
                f.npi,
                (SELECT i.value FROM clinical.identifier i
                   JOIN clinical.organization o ON o.id = i.organization_id
                  WHERE i.system = :npi AND o.type_code = 'prov'
                  ORDER BY o.created_at, i.created_at LIMIT 1)) AS provider_npi,
       coalesce((a.start AT TIME ZONE coalesce(f.timezone, t.timezone, 'UTC'))::date,
                (e.requested_at AT TIME ZONE coalesce(t.timezone, 'UTC'))::date) AS service_date,
       c.relationship_code, c.subscriber_id, c.subscriber_related_person_id,
       py.name AS payer_name,
       (SELECT x.external_payer_id FROM admin.payer_clearinghouse_id x
         WHERE x.payer_id = py.id AND x.clearinghouse = :clearinghouse) AS payer_clearinghouse_id,
       (SELECT i.value FROM clinical.identifier i
         WHERE i.coverage_id = c.id AND i.type_code = 'MB'
         ORDER BY i.created_at, i.id LIMIT 1) AS member_id,
       (SELECT k.value FROM clinical.coverage_class k
         WHERE k.coverage_id = c.id AND k.type = 'group'
         ORDER BY k.created_at, k.id LIMIT 1) AS group_number
FROM admin.eligibility_check e
JOIN clinical.coverage c ON c.id = e.coverage_id
JOIN admin.tenant t ON t.id = e.tenant_id
LEFT JOIN clinical.coverage_payor cp ON cp.coverage_id = c.id
LEFT JOIN admin.payer py ON py.id = cp.payer_id
LEFT JOIN clinical.appointment a ON a.id = e.appointment_id
LEFT JOIN admin.facility f ON f.id = a.ext_facility_id
WHERE e.id = :id
""")
_SERVICE_TYPES = text("""
SELECT service_type_code FROM admin.eligibility_service_type
WHERE eligibility_check_id = :id ORDER BY service_type_code
""")
# The legal (official) name, else the first one recorded; never the nickname or an old name.
_PATIENT = text("""
SELECT p.birth_date, n.family, n.given FROM clinical.patient p
LEFT JOIN LATERAL (SELECT x.family, x.given FROM clinical.human_name x
                    WHERE x.patient_id = p.id AND coalesce(x.use, 'official') NOT IN
                          ('nickname', 'old', 'maiden', 'anonymous')
                    ORDER BY (x.use = 'official') DESC NULLS LAST, x.created_at, x.id
                    LIMIT 1) n ON true
WHERE p.id = :id
""")
_RELATED = text("""
SELECT r.birth_date, n.family, n.given FROM clinical.related_person r
LEFT JOIN LATERAL (SELECT x.family, x.given FROM clinical.human_name x
                    WHERE x.related_person_id = r.id AND coalesce(x.use, 'official') NOT IN
                          ('nickname', 'old', 'maiden', 'anonymous')
                    ORDER BY (x.use = 'official') DESC NULLS LAST, x.created_at, x.id
                    LIMIT 1) n ON true
WHERE r.id = :id
""")


def _benefit(r: dict[str, object]) -> BenefitRow:
    return BenefitRow(**{k: r[k] for k in BenefitRow.__dataclass_fields__})  # type: ignore[arg-type]


def _person(row: object) -> Person:
    family, given, birth_date = (getattr(row, "family", None), getattr(row, "given", None),
                                 getattr(row, "birth_date", None))
    return Person(family=family, given=tuple(given or ()), birth_date=birth_date)


# ----------------------------------------------------------------------- module functions
async def primary_coverage(db: AsyncSession, patient_id: UUID, on: date) -> UUID | None:
    found: UUID | None = (await db.execute(_PRIMARY, {"patient": patient_id, "on": on})
                          ).scalar_one_or_none()
    return found


async def insert_pending(db: AsyncSession, *, coverage_id: UUID, patient_id: UUID,
                         appointment_id: UUID | None, encounter_id: UUID | None,
                         trigger: str, provider_npi: str | None = None,
                         service_type_codes: Sequence[str] = ()) -> UUID:
    now, user = (await db.execute(_NOW_AND_USER)).one()
    row = M["eligibility_check"](
        coverage_id=coverage_id, patient_id=patient_id, appointment_id=appointment_id,
        encounter_id=encounter_id, trigger=trigger, clearinghouse=CLEARINGHOUSE,
        status="pending", requested_at=now, provider_npi=provider_npi,
        requested_by_user_id=UUID(user) if user else None)
    db.add(row)
    await db.flush()
    check_id: UUID = row.id
    for code in dict.fromkeys(service_type_codes):
        db.add(M["eligibility_service_type"](eligibility_check_id=check_id,
                                             service_type_code=code))
    await db.flush()
    return check_id


async def lock_status(db: AsyncSession, check_id: UUID) -> str | None:
    """The check's status, its row locked until the transaction ends; None if not found."""
    found: str | None = (await db.execute(_LOCK, {"id": check_id})).scalar_one_or_none()
    return found


async def record_reply(db: AsyncSession, check_id: UUID, reply: Reply) -> None:
    await db.execute(_REPLY, {
        "id": check_id, "status": reply.status, "responded_at": reply.responded_at,
        "plan_name": reply.plan_name, "coverage_start": reply.coverage_start,
        "coverage_end": reply.coverage_end, "error_code": reply.error_code,
        "error_message": reply.error_message, "expires_at": reply.expires_at})
    for b in reply.benefits:
        db.add(M["eligibility_benefit"](
            eligibility_check_id=check_id, benefit_type=b.benefit_type,
            service_type_code=b.service_type_code, coverage_level=b.coverage_level,
            network=b.network, time_period=b.time_period, amount=b.amount, percent=b.percent,
            authorization_required=b.authorization_required, message=b.message))
    await db.flush()


async def mark_timed_out(db: AsyncSession, check_id: UUID, message: str) -> bool:
    """pending → timeout; False if the check wasn't pending (or isn't this clinic's)."""
    result = await db.execute(_TIMED_OUT, {"id": check_id, "message": message})
    return bool(getattr(result, "rowcount", 0))


async def request_data(db: AsyncSession, check_id: UUID, clearinghouse: str
                       ) -> RequestData | None:
    row = (await db.execute(_REQUEST, {"id": check_id, "clearinghouse": clearinghouse,
                                       "npi": NPI})).one_or_none()
    if row is None:
        return None
    codes = tuple((await db.execute(_SERVICE_TYPES, {"id": check_id})).scalars())
    patient = _person((await db.execute(_PATIENT, {"id": row.patient_id})).one())
    subscriber = None
    if row.subscriber_related_person_id is not None:
        found = (await db.execute(_RELATED, {"id": row.subscriber_related_person_id})
                 ).one_or_none()
        subscriber = _person(found) if found is not None else None
    return RequestData(
        check_id=row.id, status=row.status, service_date=row.service_date,
        service_type_codes=codes, provider_npi=row.provider_npi, payer_name=row.payer_name,
        payer_clearinghouse_id=row.payer_clearinghouse_id, relationship=row.relationship_code,
        member_id=row.member_id, subscriber_id=row.subscriber_id,
        group_number=row.group_number, patient=patient, subscriber=subscriber)


class SqlEligibilityRepository:
    async def coverage(self, db: AsyncSession, coverage_id: UUID) -> CoverageRef | None:
        row = (await db.execute(_COVERAGE, {"id": coverage_id})).one_or_none()
        if row is None:
            return None
        return CoverageRef(id=row.id, patient_id=row.beneficiary_patient_id, status=row.status,
                           period_start=row.period_start, period_end=row.period_end)

    async def appointment(self, db: AsyncSession, appointment_id: UUID
                          ) -> AppointmentRef | None:
        row = (await db.execute(_APPOINTMENT, {"id": appointment_id, "npi": NPI})).one_or_none()
        if row is None:
            return None
        return AppointmentRef(id=row.id, patient_id=row.subject_patient_id,
                              facility_id=row.ext_facility_id, local_day=row.local_day,
                              provider_npi=row.provider_npi)

    async def patient_merged(self, db: AsyncSession, patient_id: UUID) -> bool:
        return bool((await db.execute(_MERGED, {"id": patient_id})).scalar_one())

    async def practice_npi(self, db: AsyncSession) -> str | None:
        found: str | None = (await db.execute(_PRACTICE_NPI, {"npi": NPI})).scalar_one_or_none()
        return found

    async def insert_pending(self, db: AsyncSession, *, coverage_id: UUID, patient_id: UUID,
                             appointment_id: UUID | None, encounter_id: UUID | None,
                             trigger: str, provider_npi: str | None = None,
                             service_type_codes: Sequence[str] = ()) -> UUID:
        return await insert_pending(db, coverage_id=coverage_id, patient_id=patient_id,
                                    appointment_id=appointment_id, encounter_id=encounter_id,
                                    trigger=trigger, provider_npi=provider_npi,
                                    service_type_codes=service_type_codes)

    async def link_message(self, db: AsyncSession, check_id: UUID, message_id: UUID) -> None:
        await db.execute(_LINK, {"id": check_id, "message": message_id})

    async def _with_benefits(self, db: AsyncSession, rows: Sequence[object]) -> list[CheckRow]:
        found = [dict(r._mapping) for r in rows]  # type: ignore[attr-defined]
        ids = [r["id"] for r in found]
        lines: dict[UUID, list[BenefitRow]] = {}
        if ids:
            for b in (await db.execute(_BENEFITS, {"ids": ids})).mappings():
                lines.setdefault(b["eligibility_check_id"], []).append(_benefit(dict(b)))
        return [CheckRow(**r, benefits=tuple(lines.get(r["id"], ()))) for r in found]

    async def get(self, db: AsyncSession, check_id: UUID) -> CheckRow | None:
        rows = (await db.execute(_ONE, {"id": check_id})).all()
        found = await self._with_benefits(db, rows)
        return found[0] if found else None

    async def for_appointment(self, db: AsyncSession, appointment_id: UUID, *, limit: int,
                              offset: int) -> list[CheckRow]:
        rows = (await db.execute(_FOR_APPOINTMENT, {"appointment": appointment_id,
                                                    "limit": limit, "offset": offset})).all()
        return await self._with_benefits(db, rows)
