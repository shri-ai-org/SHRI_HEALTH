"""The eligibility service: checks for the API, booking, check-in and the pre-visit batch
(IMPL_BATCH1_PLAN §2.3, D15), the 270 the clearinghouse adapter sends and the 271 it gets back.

- **Recording a check** (``record_check``): a ``pending`` row for a coverage, in the caller's
  transaction. Check-in uses it today; the row waits there until something sends it.
- **Running a check** (``queue_check``, ``POST /eligibility-checks``): the ``pending`` row, an
  operation of kind ``eligibility.check`` and the outbox message ``clearinghouse`` / ``270``, all
  in the caller's one transaction (D25, ADR-0011). The outbox row holds IDs only
  (``eligibilityCheckId``, ``operationId``).
- **The 270** (``build_request``): the clearinghouse adapter calls it at send time with the check
  ID from the outbox row, and sends the result (``contracts/partners/clearinghouse/
  eligibility-request.schema.json``). A check it can't build a request for raises
  ``RequestNotBuildable`` with a short code and no patient data, for the adapter's dead-letter.
- **The 271** (``record_response``): the ``/hooks/clearinghouse`` receiver calls it with the
  reply's body. It is checked against the reply's shape, filed against ``correlationId`` once
  (a second reply changes nothing), the benefit lines stored, ``eligibility.completed``
  published, and the operation finished when the caller names it.
- **No answer** (``mark_timed_out``): for the worker when a 270 is dead-lettered.

Payloads are never logged: they hold names, dates of birth and member IDs. Payer error text is
never stored either; the front desk sees a fixed message for each X12 AAA code (``AAA_MESSAGES``).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.access import require_facility
from app.core.deps import CurrentUser
from app.core.errors import (
    Conflict,
    InvalidCursor,
    NotFound,
    ValidationFailed,
    field_error,
)
from app.core.events import publish
from app.core.long_running import Operation, finish_operation, problem_body

from . import messages, repository, schemas
from .partner import Partner
from .repository import (
    CLEARINGHOUSE,
    BenefitRow,
    CheckRow,
    EligibilityRepository,
    Reply,
    RequestData,
)

TRIGGERS = ("booking", "pre-visit-batch", "check-in", "manual")  # D15
DEFAULT_SERVICE_TYPES = ("30",)  # health benefit plan coverage
RESULT_TYPE = "eligibility-check"
#: How long an answer is good for: after this the front desk checks again before relying on it.
VALID_FOR = timedelta(hours=24)
PAGE_MAX = 50  # EligibilityCheckList.items maxItems

#: X12 AAA03 reject reasons, as the front desk reads them. The payer's own text is never shown:
#: it may hold patient data. Unknown codes get the generic message.
AAA_MESSAGES: dict[str, str] = {
    "42": "The payer can't answer right now. Try again later.",
    "43": "The payer doesn't recognize the provider's NPI.",
    "44": "The payer reports the provider's name is missing or wrong.",
    "45": "The payer reports the provider's specialty is missing or wrong.",
    "47": "The payer reports the provider's state is missing or wrong.",
    "48": "The payer reports the referring provider's ID is missing or wrong.",
    "49": "The payer reports the provider is not the patient's primary care physician.",
    "51": "The payer has no record of this provider.",
    "52": "The service date is outside the provider's enrollment with the payer.",
    "56": "The payer reports an inappropriate date.",
    "57": "The payer reports the service date is missing or wrong.",
    "58": "The payer reports the date of birth is missing or wrong.",
    "60": "The payer reports the date of birth is after the service date.",
    "61": "The payer reports a date of death before the service date.",
    "62": "The service date is outside the period the payer allows inquiries for.",
    "63": "The payer does not answer for a service date in the future.",
    "64": "The payer reports the patient's ID is missing or wrong.",
    "65": "The payer reports the patient's name is missing or wrong.",
    "66": "The payer reports the patient's gender is missing or wrong.",
    "67": "The payer could not find the patient.",
    "68": "The payer reports a duplicate patient ID.",
    "71": "The date of birth does not match the payer's records.",
    "72": "The payer reports an invalid member ID.",
    "73": "The payer reports the subscriber's name is missing or wrong.",
    "75": "The payer could not find the subscriber.",
    "76": "The payer reports a duplicate member ID.",
    "79": "The clearinghouse could not identify our practice.",
    "80": "The payer did not answer; the request was ended.",
    "T4": "The payer's name or ID is missing.",
}
GENERIC_ERROR = "The payer could not verify the coverage."
TIMEOUT_MESSAGE = "The payer did not answer in time. Run the check again."

# Our status columns (backend/app/db/CLAUDE.md, "Eligibility").
_STATUS_BY_RESULT = {"active": "active", "inactive": "inactive",
                     "member-not-found": "not-found", "error": "error"}
_COVERAGE_STATUS = {"active": "active", "inactive": "inactive", "not-found": "unknown"}
_ANSWERED = frozenset({"active", "inactive", "not-found", "error"})


# ------------------------------------------------------------------------------- helpers
def business_rule(pointer: str, code: str) -> ValidationFailed:
    return ValidationFailed(code="business-rule-violation",
                            errors=[field_error("body", pointer, code)])


def encode_cursor(offset: int) -> str:
    """Opaque page cursor. Core's encrypted cursors (T22) replace this when they land."""
    return base64.urlsafe_b64encode(f"o:{offset}".encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        kind, _, number = raw.partition(":")
        offset = int(number)
    except (binascii.Error, UnicodeDecodeError, ValueError) as bad:
        raise InvalidCursor() from bad
    if kind != "o" or offset < 0:
        raise InvalidCursor()
    return offset


def etag(row: CheckRow) -> str:
    """A check has no version column; its status and last change identify the version."""
    stamp = f"{row.status}:{row.updated_at.isoformat()}".encode()
    return f'"{hashlib.sha256(stamp).hexdigest()[:16]}"'


def _money(amount: Decimal | None) -> schemas.Money | None:
    return None if amount is None else schemas.Money(value=f"{amount:.2f}")


def _pick(benefits: Iterable[BenefitRow], kind: str, periods: Sequence[str | None],
          service_types: Sequence[str | None]) -> BenefitRow | None:
    """The first line of this kind, for the individual, in network (or unstated), with an
    amount, by the preferred time periods and then service types."""
    lines = [b for b in benefits if b.benefit_type == kind and b.amount is not None
             and b.coverage_level in ("individual", None) and b.network in ("in", None)]

    def rank(b: BenefitRow) -> tuple[int, int]:
        period = periods.index(b.time_period) if b.time_period in periods else len(periods)
        service = (service_types.index(b.service_type_code)
                   if b.service_type_code in service_types else len(service_types))
        return period, service

    eligible = [b for b in lines if b.time_period in periods]
    return min(eligible, key=rank) if eligible else None


def summarize(benefits: Sequence[BenefitRow]
              ) -> tuple[Decimal | None, Decimal | None, Decimal | None]:
    """The front desk's copay (office visit, in network), the individual in-network deductible
    for the year and what remains of it, picked from the benefit lines (FR-RCM-01)."""
    copay = _pick(benefits, "copay", ("visit", None), ("98", "30", None))
    deductible = _pick(benefits, "deductible", ("calendar-year", "plan-year"), ("30", None))
    remaining = _pick(benefits, "deductible", ("remaining",), ("30", None))
    return (copay.amount if copay else None, deductible.amount if deductible else None,
            remaining.amount if remaining else None)


def to_contract(row: CheckRow) -> schemas.EligibilityCheck:
    """One status column to the contract's status and coverageStatus (db/CLAUDE.md)."""
    status = ("pending" if row.status == "pending"
              else "error" if row.status in ("error", "timeout") else "complete")
    copay, deductible, remaining = summarize(row.benefits)
    answered = status == "complete"
    return schemas.EligibilityCheck(
        id=row.id, patient_id=row.patient_id, coverage_id=row.coverage_id,
        appointment_id=row.appointment_id, trigger=row.trigger,
        status=status,
        coverage_status=_COVERAGE_STATUS.get(row.status),
        plan_name=row.plan_name if answered else None,
        coverage_start_date=row.coverage_start if answered else None,
        coverage_end_date=row.coverage_end if answered else None,
        copay=_money(copay), deductible=_money(deductible),
        deductible_remaining_amount=_money(remaining),
        benefits=[schemas.EligibilityBenefit(
            benefit_type=b.benefit_type,
            service_type_code=b.service_type_code,
            coverage_level=b.coverage_level,
            network=b.network, time_period=b.time_period,
            benefit_amount=_money(b.amount),
            percent=float(b.percent) if b.percent is not None else None,
            authorization_required=b.authorization_required, message=b.message)
            for b in row.benefits] or None,
        error_code=row.error_code if status == "error" else None,
        error_message=row.error_message if status == "error" else None,
        requested_at=row.requested_at, responded_at=row.responded_at,
        expires_at=row.expires_at if answered else None)


# ----------------------------------------------------------- used by booking and check-in
async def primary_coverage(db: AsyncSession, patient_id: UUID, on: date) -> UUID | None:
    """The patient's active coverage with the lowest order that covers the day; None when the
    patient has none (self-pay, or check-in refuses, DATA_OWNERSHIP §5.1)."""
    return await repository.primary_coverage(db, patient_id, on)


async def record_check(db: AsyncSession, *, coverage_id: UUID, patient_id: UUID,
                       appointment_id: UUID | None, encounter_id: UUID | None,
                       trigger: str) -> UUID:
    """A ``pending`` check in the caller's transaction, nothing sent (see the module docstring)."""
    if trigger not in TRIGGERS:
        raise ValueError(f"unknown eligibility trigger {trigger!r}")
    return await repository.insert_pending(db, coverage_id=coverage_id, patient_id=patient_id,
                                           appointment_id=appointment_id,
                                           encounter_id=encounter_id, trigger=trigger)


# ------------------------------------------------------------------- the API's operations
ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Any]


@dataclass(frozen=True)
class Queued:
    operation: Operation
    check_id: UUID
    patient_id: UUID


async def queue_check(db: AsyncSession, repo: EligibilityRepository, partner: Partner,
                      check: ChartCheck, user: CurrentUser,
                      body: schemas.EligibilityCheckCreate, *, today: date) -> Queued:
    """``POST /eligibility-checks`` (trigger ``manual``): the coverage and the appointment must be
    this clinic's (404), the appointment at one of the user's facilities (404), the chart open to
    the user (403 break-glass-required), the patient not merged (409), the coverage active on the
    service date and the appointment the coverage's patient's (422). Then the pending check, the
    operation and the 270 in the outbox, in the caller's transaction (no commit)."""
    coverage = await repo.coverage(db, body.coverage_id)
    if coverage is None:
        raise NotFound()
    appointment = None
    if body.appointment_id is not None:
        appointment = await repo.appointment(db, body.appointment_id)
        if appointment is None:
            raise NotFound()
        require_facility(user, appointment.facility_id)
    await check(db, user, coverage.patient_id)
    if await repo.patient_merged(db, coverage.patient_id):
        raise Conflict(code="patient-merged")
    if appointment is not None and appointment.patient_id != coverage.patient_id:
        raise business_rule("/appointmentId", "invalid-reference")
    on = appointment.local_day if appointment is not None else today
    if coverage.status != "active" or (
            coverage.period_end is not None and coverage.period_end < on) or (
            coverage.period_start is not None and coverage.period_start > on):
        raise business_rule("/coverageId", "not-allowed-value")  # not active on that day
    npi = appointment.provider_npi if appointment is not None else None
    check_id = await repo.insert_pending(
        db, coverage_id=coverage.id, patient_id=coverage.patient_id,
        appointment_id=body.appointment_id, encounter_id=None, trigger="manual",
        provider_npi=npi or await repo.practice_npi(db),
        service_type_codes=body.service_type_codes or DEFAULT_SERVICE_TYPES)
    operation = await partner.start(db)
    message_id = await partner.send_270(db, check_id, operation.id)
    await repo.link_message(db, check_id, message_id)
    return Queued(operation, check_id, coverage.patient_id)


async def readable_check(db: AsyncSession, repo: EligibilityRepository, check: ChartCheck,
                         user: CurrentUser, check_id: UUID) -> CheckRow:
    """404 for another clinic's check or one at a facility not the user's; 403 for a restricted
    chart without a grant or care-team membership."""
    row = await repo.get(db, check_id)
    if row is None:
        raise NotFound()
    if row.appointment_id is not None:
        require_facility(user, row.facility_id)
    await check(db, user, row.patient_id)
    return row


async def appointment_checks(db: AsyncSession, repo: EligibilityRepository, check: ChartCheck,
                             user: CurrentUser, appointment_id: UUID, *, limit: int,
                             cursor: str | None) -> tuple[schemas.EligibilityCheckList, UUID]:
    """Newest first. The appointment must be this clinic's and at one of the user's facilities,
    and its chart open to the user."""
    appointment = await repo.appointment(db, appointment_id)
    if appointment is None:
        raise NotFound()
    require_facility(user, appointment.facility_id)
    await check(db, user, appointment.patient_id)
    offset = decode_cursor(cursor)
    size = min(limit, PAGE_MAX)
    rows = await repo.for_appointment(db, appointment_id, limit=size + 1, offset=offset)
    next_cursor = encode_cursor(offset + size) if len(rows) > size else None
    return (schemas.EligibilityCheckList(items=[to_contract(r) for r in rows[:size]],
                                         next_cursor=next_cursor), appointment.patient_id)


# ------------------------------------------------------------------- the 270, for the adapter
class RequestNotBuildable(Exception):
    """No 270 can be built for this check. ``code`` is short and holds no patient data, for the
    adapter's ``DeliveryError(code, permanent=True)``."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _present(**members: Any) -> dict[str, Any]:
    """The members that have a value: a message leaves an absent one out, never sends null."""
    return {k: v for k, v in members.items() if v is not None}


def _name(person: repository.Person) -> messages.PersonName:
    if not person.family:
        raise RequestNotBuildable("name-missing")
    return messages.PersonName(**_present(
        family=person.family[:100], given=[g[:100] for g in person.given if g][:5] or None))


def request_from(data: RequestData, now: datetime) -> messages.EligibilityRequest:
    """The 270 from what the check names (pure; see build_request)."""
    if not data.payer_name:
        raise RequestNotBuildable("payer-missing")
    if not data.provider_npi:
        raise RequestNotBuildable("provider-npi-missing")
    if not data.member_id:
        raise RequestNotBuildable("member-id-missing")
    dependent = None
    if data.relationship in (None, "self"):
        holder = data.patient
        member_id = data.subscriber_id or data.member_id
    else:
        if data.subscriber is None:
            raise RequestNotBuildable("subscriber-missing")
        holder = data.subscriber
        member_id = data.subscriber_id or data.member_id
        if data.patient.birth_date is None:
            raise RequestNotBuildable("birth-date-missing")
        dependent = messages.Dependent(**_present(
            name=_name(data.patient), birth_date=data.patient.birth_date.isoformat(),
            relationship_to_subscriber=data.relationship,
            member_id=data.member_id if data.member_id != member_id else None))
    if holder.birth_date is None:
        raise RequestNotBuildable("birth-date-missing")
    return messages.EligibilityRequest(**_present(
        message_type=messages.REQUEST_TYPE, schema_version=messages.SCHEMA_VERSION,
        correlation_id=str(data.check_id),
        created_at=now.astimezone(UTC).replace(microsecond=0, tzinfo=None).isoformat() + "Z",
        payer=messages.RequestPayer(**_present(name=data.payer_name,
                                               payer_id=data.payer_clearinghouse_id)),
        provider=messages.RequestProvider(npi=data.provider_npi),
        subscriber=messages.Subscriber(**_present(
            member_id=member_id, name=_name(holder), birth_date=holder.birth_date.isoformat(),
            group_number=data.group_number)),
        dependent=dependent, service_date=data.service_date.isoformat(),
        service_type_codes=list(data.service_type_codes or DEFAULT_SERVICE_TYPES)))


async def build_request(db: AsyncSession, check_id: UUID, *, now: datetime,
                        clearinghouse: str = CLEARINGHOUSE) -> messages.EligibilityRequest:
    """The 270 for a pending check, read in the check's clinic (the worker's clinic session).
    ``clearinghouse`` picks the payer's ID at that clearinghouse (admin.payer_clearinghouse_id).
    Send ``.as_json()``; never log it."""
    data = await repository.request_data(db, check_id, clearinghouse)
    if data is None:
        raise RequestNotBuildable("check-not-found")
    if data.status != "pending":
        raise RequestNotBuildable("check-not-pending")
    return request_from(data, now)


# ---------------------------------------------------------------- the 271, for the receiver
@dataclass(frozen=True)
class Filed:
    check_id: UUID
    status: str  # our status column: active, inactive, not-found or error
    duplicate: bool  # True: the check was already answered, and nothing changed


def _pointer(location: tuple[int | str, ...]) -> str:
    return "/" + "/".join(str(p) for p in location) if location else ""


def parse_response(payload: Mapping[str, Any]) -> messages.EligibilityResponse:
    """The reply checked against its shape; 422 naming only where it's wrong, never a value."""
    try:
        return messages.EligibilityResponse.model_validate(payload)
    except ValidationError as wrong:
        found = [field_error("body", _pointer(e["loc"]), "invalid-format")
                 for e in wrong.errors(include_url=False, include_input=False,
                                       include_context=False)][:20]
        raise ValidationFailed(errors=found) from None


def reply_from(response: messages.EligibilityResponse) -> Reply:
    """What the reply changes on the check (pure)."""
    status = _STATUS_BY_RESULT[response.result]
    responded_at = datetime.fromisoformat(response.responded_at)
    code = response.errors[0].code if status == "error" and response.errors else None
    plan = response.plan
    benefits = tuple(BenefitRow(
        benefit_type=b.benefit_type, service_type_code=b.service_type_code,
        coverage_level=b.coverage_level, network=b.network, time_period=b.time_period,
        amount=Decimal(b.amount.value) if b.amount else None,
        percent=Decimal(b.percent) if b.percent is not None else None,
        authorization_required=b.authorization_required, message=b.message)
        for b in response.benefits or ())
    return Reply(
        status=status, responded_at=responded_at,
        plan_name=plan.name if plan else None,
        coverage_start=date.fromisoformat(plan.coverage_start_date)
        if plan and plan.coverage_start_date else None,
        coverage_end=date.fromisoformat(plan.coverage_end_date)
        if plan and plan.coverage_end_date else None,
        error_code=code, error_message=AAA_MESSAGES.get(code, GENERIC_ERROR) if code else None,
        expires_at=responded_at + VALID_FOR if status != "error" else None,
        benefits=benefits)


async def record_response(db: AsyncSession, payload: Mapping[str, Any], *,
                          operation_id: UUID | None = None) -> Filed:
    """Files a 271 in the caller's transaction (no commit); the session must be the check's
    clinic. 422 for a reply that breaks its shape, 404 for an unknown ``correlationId`` (or
    another clinic's). A check already answered is left as it is (``duplicate``); a late answer
    after a timeout is filed. Publishes ``eligibility.completed`` and, with ``operation_id``,
    finishes that ``eligibility.check`` operation with the check as its result."""
    response = parse_response(payload)
    check_id = UUID(response.correlation_id)
    current = await repository.lock_status(db, check_id)
    if current is None:
        raise NotFound()
    if current in _ANSWERED:
        return Filed(check_id, current, duplicate=True)
    reply = reply_from(response)
    await repository.record_reply(db, check_id, reply)
    row = await repository.SqlEligibilityRepository().get(db, check_id)
    if row is not None:
        data: dict[str, Any] = {}  # EVENTS.md: appointmentId, coverageStatus once complete
        if reply.status in _COVERAGE_STATUS:
            data["coverageStatus"] = _COVERAGE_STATUS[reply.status]
        if row.appointment_id is not None:
            data["appointmentId"] = str(row.appointment_id)
        await publish(db, "eligibility.completed", f"eligibility-check/{check_id}", data,
                      facility_id=row.facility_id, patient_id=row.patient_id)
    if operation_id is not None:
        await finish_operation(db, operation_id, "succeeded", result=(RESULT_TYPE, check_id))
    return Filed(check_id, reply.status, duplicate=False)


async def mark_timed_out(db: AsyncSession, check_id: UUID, *,
                         operation_id: UUID | None = None) -> bool:
    """For the worker when the 270 is dead-lettered: a pending check becomes ``timeout``
    (the contract's ``error`` with ``errorCode: timeout``) and the operation, if named, fails
    with ``upstream-timeout``. False when the check was no longer pending."""
    changed = await repository.mark_timed_out(db, check_id, TIMEOUT_MESSAGE)
    if changed and operation_id is not None:
        await finish_operation(db, operation_id, "failed", error=problem_body(
            "upstream-timeout", "The payer did not answer in time"))
    return changed
