"""Online pre-registration rules (D96; the contract is #89, in portal.yaml and patients.yaml).

**The public form** answers the same ``204`` every time it takes a request, whether or not the
person is already a patient: nothing about any person is looked up, and the stored request and
its audit row are written by one database function that returns nothing. Only a refusal that
says nothing about the person answers differently: a wrong ``Origin`` (403), a rate limit (429),
a failed bot check or a malformed body (422), an unknown practice link (404). The order is
fixed: Origin, the per-IP limit, the bot check, the per-email limit, then the write.

**The staff queue** (FD, ADM) lists, reads, accepts and rejects. Accepting records the identity
check (the kind of ID) and either creates the patient through the registration rules of
``POST /patients`` (D44, D41, the duplicate check; entry source ``patient-reported``,
FR-PAT-02) or links an existing chart, which passes the restricted-chart check first (D37).
The patient and the decision commit together.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict, Forbidden, NotFound, ValidationFailed, field_error

from . import schemas, service
from .access import ChartCheck
from .pre_registration_repository import (
    IdempotencyKeyReused,
    PreRegistrationRepository,
    PreRegistrationRow,
    Submission,
    UnknownPracticeLink,
)
from .public_form import FieldCipher, PublicFormGuards, normalize_email
from .repository import PatientRepository
from .store import FhirStore

KEEP_FOR = timedelta(days=30)  # rejected or never reviewed: Anand's purge (shri_maintenance)


class RateLimited(AppError):
    """429 rate-limited (API_STANDARDS §9.3); core has no 429 class yet."""

    default_code = "rate-limited"


# --------------------------------------------------------------------------------- the public form
# Core's rate-limit scopes (core/public_form.py): per client IP, and per email's keyed hash.
IP_SCOPE = "ip"
EMAIL_SCOPE = "email"
MAX_BOT_CHECK = 4000  # PreRegistrationCreate.botCheck's maxLength


async def check_bot(guards: PublicFormGuards, payload: object, idempotency_key: str | None) -> None:
    """The ALTCHA answer, before the body's fields: missing, malformed, forged, expired or used by
    another request is 422 at /botCheck. A retry with the same Idempotency-Key may send it again."""
    key = None
    if idempotency_key:
        try:
            key = str(parse_idempotency_key(idempotency_key))
        except ValueError:
            key = None  # the header's own validation answers it
    if (not isinstance(payload, str) or not payload or len(payload) > MAX_BOT_CHECK
            or not await guards.bot_check_passes(payload, idempotency_key=key)):
        raise service.business_rule("body", "/botCheck", "not-allowed-value")


def check_origin(guards: PublicFormGuards, origin: str | None) -> None:
    if not guards.origin_allowed(origin):
        raise Forbidden(code="csrf-check-failed", detail="This form only accepts requests from "
                                                         "the patient portal.")


async def _limit(guards: PublicFormGuards, scope: str, key: str) -> None:
    wait = await guards.retry_after(scope, key)
    if wait is not None:
        raise RateLimited(headers={"Retry-After": str(max(1, wait))})


async def check_ip_limit(guards: PublicFormGuards, source_ip: str | None) -> None:
    await _limit(guards, IP_SCOPE, source_ip or "unknown")


def request_hash(body: schemas.PreRegistrationCreate) -> str:
    """SHA-256 of the canonical body, to tell a replay from a reused key. The bot check's answer
    is part of it and is single-use, so the hash can't be matched to a guessed person."""
    canonical = json.dumps(body.model_dump(mode="json", by_alias=True, exclude_none=True),
                           sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


async def seal(cipher: FieldCipher, details: schemas.PreRegistrationDetails) -> dict[str, str]:
    """Each top-level value encrypted on its own; the keys stay, for the table's shape check."""
    plain = details.model_dump(mode="json", by_alias=True, exclude_none=True)
    return {key: await cipher.encrypt(json.dumps(value).encode()) for key, value in plain.items()}


async def unseal(cipher: FieldCipher, sealed: dict[str, Any]) -> schemas.PreRegistrationDetails:
    plain = {key: json.loads(await cipher.decrypt(value)) for key, value in sealed.items()}
    return schemas.PreRegistrationDetails.model_validate(plain)


async def submit(db: AsyncSession, repo: PreRegistrationRepository, guards: PublicFormGuards,
                 cipher: FieldCipher, body: schemas.PreRegistrationCreate, *, practice_code: str,
                 idempotency_key: UUID, source_ip: str | None, user_agent: str | None,
                 correlation_id: str | None) -> None:
    """The Origin, the per-IP limit and the bot check run before the body is validated
    (pre_registration_api.py, the contract's order); this runs the rest."""
    if body.details.email:
        await _limit(guards, EMAIL_SCOPE,
                     guards.email_key(normalize_email(body.details.email)))
    submission = Submission(
        practice_code=practice_code, idempotency_key=idempotency_key,
        request_hash=request_hash(body), details=await seal(cipher, body.details),
        source_ip=source_ip, user_agent=(user_agent or "")[:300] or None,
        correlation_id=correlation_id)
    try:
        await repo.submit(db, submission)
    except UnknownPracticeLink as unknown:
        raise NotFound(detail="No practice takes requests with this link.") from unknown
    except IdempotencyKeyReused as reused:
        raise ValidationFailed(code="idempotency-key-reused") from reused


def parse_idempotency_key(value: str) -> UUID:
    """The header is a UUID, bare or quoted (the contract's pattern has already checked it)."""
    return UUID(value.strip('"'))


# --------------------------------------------------------------------------------- the staff queue
async def to_response(cipher: FieldCipher, row: PreRegistrationRow) -> schemas.PreRegistration:
    rejection = identity = None
    delete_after = None
    if row.status == "rejected" and row.rejection_reason_code:
        rejection = schemas.PreRegistrationRejection(reason_code=row.rejection_reason_code,
                                                     reason_text=row.rejection_reason_text)
        delete_after = row.decided_at + KEEP_FOR if row.decided_at else None
    elif row.status == "accepted" and row.id_document_type and row.decided_by and row.decided_at:
        identity = schemas.PreRegistrationIdentityCheck(
            id_document_type=row.id_document_type, verified_by=row.decided_by,
            verified_at=row.decided_at)
    else:
        delete_after = row.submitted_at + KEEP_FOR
    return schemas.PreRegistration(
        id=row.id, status=row.status, details=await unseal(cipher, row.details),
        submitted_at=row.submitted_at, decided_at=row.decided_at, decided_by=row.decided_by,
        patient_id=row.patient_id, rejection=rejection, identity_check=identity,
        delete_after=delete_after)


async def _pending(db: AsyncSession, repo: PreRegistrationRepository,
                   pre_registration_id: UUID) -> PreRegistrationRow:
    row = await repo.get(db, pre_registration_id, lock=True)
    if row.status != "pending":
        raise Conflict(detail="This request was already decided.", currentState=row.status)
    return row


def registration_from(details: schemas.PreRegistrationDetails, body: schemas.PreRegistrationAccept
                      ) -> schemas.PatientCreate:
    """The fields of the request that ``POST /patients`` takes. Insurance and the reason for
    the visit stay on the request for the front desk to enter (coverage is PR-2)."""
    return schemas.PatientCreate(
        name=details.name, birth_date=details.birth_date, gender=details.gender,
        phones=details.phones or [],
        emails=[schemas.Email(address=details.email)] if details.email else [],
        address=details.address, preferred_language=details.preferred_language,
        duplicate_check=body.duplicate_check,
        duplicate_override_reason=body.duplicate_override_reason)


async def accept(db: AsyncSession, repo: PreRegistrationRepository,
                 patients: PatientRepository, store: FhirStore, check: ChartCheck,
                 cipher: FieldCipher, user: Any, pre_registration_id: UUID,
                 body: schemas.PreRegistrationAccept, *, today: date) -> UUID:
    """Creates or links the patient and records the decision, without the commit (the API names
    the patient for the audit row first). Returns the patient's ID."""
    row = await _pending(db, repo, pre_registration_id)
    if body.patient_id is not None:
        try:
            linked = await service.readable_patient(db, patients, body.patient_id)
        except NotFound as gone:
            raise service.business_rule("body", "/patientId", "invalid-reference") from gone
        await check(db, user, body.patient_id)
        service.writable(linked.value)
        patient_id = body.patient_id
    else:
        reason = (body.duplicate_override_reason or "").strip()
        if body.duplicate_check == "override" and not reason:  # the contract's 422 for accept
            raise ValidationFailed(errors=[field_error("body", "/duplicateOverrideReason",
                                                       "required")])
        details = await unseal(cipher, row.details)
        patient_id = await service.create_registered(
            db, patients, store, registration_from(details, body), today=today,
            entry_source="patient-reported")
    await repo.accept(db, row.id, user_id=user.id, patient_id=patient_id,
                      id_document_type=body.id_document_type)
    return patient_id


async def reject(db: AsyncSession, repo: PreRegistrationRepository, user: Any,
                 pre_registration_id: UUID, body: schemas.PreRegistrationReject) -> None:
    if body.reason_code == "other" and not (body.reason_text or "").strip():
        raise ValidationFailed(errors=[field_error("body", "/reasonText", "required")])
    row = await _pending(db, repo, pre_registration_id)
    await repo.reject(db, row.id, user_id=user.id, reason_code=body.reason_code,
                      reason_text=(body.reason_text or "").strip() or None)
    await db.commit()


async def read(db: AsyncSession, repo: PreRegistrationRepository, cipher: FieldCipher,
               pre_registration_id: UUID) -> schemas.PreRegistration:
    return await to_response(cipher, await repo.get(db, pre_registration_id))


async def listing(db: AsyncSession, repo: PreRegistrationRepository, cipher: FieldCipher,
                  status: str, limit: int, cursor: str | None) -> schemas.PreRegistrationList:
    offset = service.decode_cursor(cursor)
    rows = await repo.list(db, status, limit=limit + 1, offset=offset)
    page, next_cursor = service.page(rows, limit, offset)
    return schemas.PreRegistrationList(items=[await to_response(cipher, r) for r in page],
                                       next_cursor=next_cursor)

