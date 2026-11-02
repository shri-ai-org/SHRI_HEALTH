"""Allergy rules (history.yaml; inventory #94-97, #250; FRS FR-PAT-03). MA and RN record allergies
while rooming (FRS FR-SCH-02); the prescriptions safety check reads them (D97).

Writes go through Anand's FHIR write helpers (``app.db.fhir_store``), commit once, then read
back. The helpers' exceptions come back as core's errors. Rules the contract names:
- the substance is RxNorm, SNOMED CT, NDC or UNII, or text; a reaction's manifestation SNOMED CT
  or text (`business-rule-violation`, `not-allowed-value`);
- a date in the future is `out-of-range`;
- a new allergy on a merged chart is `409 patient-merged` (D103);
- RN marks only their own entries entered-in-error.

The helpers store one coding per concept and onset as a date-time, so a second coding and a
partial `onsetDate` (`YYYY`, `YYYY-MM`) are refused, never dropped (a note for Anand and the
contract, in the PR).
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, date, datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import (
    Conflict,
    Forbidden,
    InvalidCursor,
    NotFound,
    PreconditionFailed,
    PreconditionRequired,
    ValidationFailed,
    field_error,
)
from app.core.permissions import roles_allow
from app.db.fhir_store import (
    UNSET,
    AllergyChanges,
    AllergyIn,
    Coded,
    FhirStore,
    InvalidInput,
    InvalidTransition,
    ReactionIn,
    Reason,
    ResourceNotFound,
    StaleVersion,
)
from app.db.models import systems

from ..encounters.schemas import CodeableConcept
from . import schemas
from .repository import AllergyRepository, AllergyRow

ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[object]]
WritablePatient = Callable[[AsyncSession, UUID], Awaitable[None]]

SUBSTANCE_SYSTEMS = frozenset({systems.RXNORM, systems.SNOMED, systems.NDC, systems.UNII})
MANIFESTATION_SYSTEMS = frozenset({systems.SNOMED})
OPEN_VISIT = ("arrived", "triaged", "in-progress")
ENTERED_IN_ERROR = "allergies:entered-in-error"


# ------------------------------------------------------------------------------------ helpers
def etag(version: int) -> str:
    return f'"{version}"'


def if_match_version(header: str | None) -> int:
    if header is None:
        raise PreconditionRequired()
    value = header.strip()
    if value.startswith('"') and value.endswith('"') and value[1:-1].isdigit():
        return int(value[1:-1])
    raise PreconditionFailed()  # a weak or malformed tag never matches a strong one


def encode_cursor(offset: int) -> str:
    """Opaque page cursor. Core's encrypted cursors (T22) replace this when they land."""
    return base64.urlsafe_b64encode(f"o:{offset}".encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
    except (binascii.Error, UnicodeDecodeError) as bad:
        raise InvalidCursor() from bad
    kind, _, number = raw.partition(":")
    if kind != "o" or not number.isdigit():
        raise InvalidCursor()
    return int(number)


def _rule(errors: list[dict[str, str]]) -> ValidationFailed:
    return ValidationFailed(code="business-rule-violation", errors=errors)


def _coded(concept: CodeableConcept, at: str, allowed: frozenset[str],
           errors: list[dict[str, str]]) -> Coded:
    """One coding (or text) from a CodeableConcept; problems go into ``errors``."""
    if len(concept.codings) > 1:
        errors.append(field_error("body", f"{at}/codings/1", "out-of-range"))
    if not concept.codings and not (concept.text and concept.text.strip()):
        errors.append(field_error("body", at, "required"))
    coding = concept.codings[0] if concept.codings else None
    if coding is not None and coding.system not in allowed:
        errors.append(field_error("body", f"{at}/codings/0/system", "not-allowed-value"))
    return Coded(system=coding.system if coding else None, code=coding.code if coding else None,
                 display=coding.display if coding else None, text=concept.text)


def _onset(value: str | None, at: str, today: date, errors: list[dict[str, str]]
           ) -> datetime | None:
    """A full date as the start of that day (UTC); a partial date can't be stored yet."""
    if value is None:
        return None
    if len(value) != 10:
        errors.append(field_error("body", at, "not-allowed-value"))
        return None
    day = date.fromisoformat(value)
    if day > today:
        errors.append(field_error("body", at, "out-of-range"))
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def _reactions(reactions: Sequence[schemas.AllergyReaction], today: date,
               errors: list[dict[str, str]]) -> tuple[ReactionIn, ...]:
    out = []
    for i, r in enumerate(reactions):
        at = f"/reactions/{i}"
        if not r.manifestations:
            errors.append(field_error("body", f"{at}/manifestations", "required"))
        manifestations = tuple(_coded(m, f"{at}/manifestations/{j}", MANIFESTATION_SYSTEMS,
                                      errors) for j, m in enumerate(r.manifestations))
        out.append(ReactionIn(manifestations=manifestations, severity=r.severity,
                              description=r.description,
                              onset=_onset(r.onset_date, f"{at}/onsetDate", today, errors)))
    return tuple(out)


def _invalid(refused: InvalidInput) -> ValidationFailed:
    return _rule([field_error("body", f"/{refused.field}" if refused.field else "",
                              "not-allowed-value")])


# -------------------------------------------------------------------------------------- reads
async def list_allergies(db: AsyncSession, repo: AllergyRepository, check: ChartCheck,
                         user: CurrentUser, patient_id: UUID, *, include_entered_in_error: bool,
                         limit: int, cursor: str | None
                         ) -> tuple[list[schemas.Allergy], str | None]:
    offset = decode_cursor(cursor)
    await check(db, user, patient_id)  # 404 unknown patient, 403 restricted (D37)
    found = await repo.list(db, patient_id, include_entered_in_error=include_entered_in_error,
                            limit=limit + 1, offset=offset)
    if len(found) > limit:
        return found[:limit], encode_cursor(offset + limit)
    return found, None


async def get_allergy(db: AsyncSession, repo: AllergyRepository, check: ChartCheck,
                      user: CurrentUser, patient_id: UUID, allergy_id: UUID) -> AllergyRow:
    await check(db, user, patient_id)
    return await repo.get(db, patient_id, allergy_id)


# ------------------------------------------------------------------------------------- writes
async def add_allergy(db: AsyncSession, repo: AllergyRepository, store: FhirStore,
                      check: ChartCheck, writable: WritablePatient, user: CurrentUser,
                      patient_id: UUID, body: schemas.AllergyCreate, today: date) -> AllergyRow:
    await check(db, user, patient_id)
    await writable(db, patient_id)  # 409 patient-merged (D103)
    errors: list[dict[str, str]] = []
    code = _coded(body.code, "/code", SUBSTANCE_SYSTEMS, errors)
    onset = _onset(body.onset_date, "/onsetDate", today, errors)
    reactions = _reactions(body.reactions, today, errors)
    if body.encounter_id is not None:
        visit = await repo.visit_of(db, body.encounter_id)
        if visit is None or visit[0] != patient_id or visit[1] not in OPEN_VISIT:
            errors.append(field_error("body", "/encounterId", "invalid-reference"))
    if errors:
        raise _rule(errors)
    try:
        written = await store.create_allergy(db, AllergyIn(
            patient_id=patient_id, code=code, clinical_status=body.clinical_status,
            verification_status=body.verification_status, encounter_id=body.encounter_id,
            type=body.type, categories=tuple(body.categories), criticality=body.criticality,
            onset_date_time=onset, reactions=reactions, note=body.note))
    except InvalidInput as refused:
        raise _invalid(refused) from refused
    await db.commit()
    return await repo.get(db, patient_id, written.id)


async def update_allergy(db: AsyncSession, repo: AllergyRepository, store: FhirStore,
                         check: ChartCheck, user: CurrentUser, patient_id: UUID,
                         allergy_id: UUID, patch: schemas.AllergyPatch, if_match: str | None,
                         today: date) -> AllergyRow:
    """Status, criticality, reactions and note (AllergyPatch); the substance never changes."""
    version = if_match_version(if_match)
    await check(db, user, patient_id)
    await repo.get(db, patient_id, allergy_id)  # 404 unless it is this patient's
    sent = patch.model_fields_set
    errors = [field_error("body", f"/{name}", "invalid-type")
              for name, field in (("clinicalStatus", "clinical_status"),
                                  ("verificationStatus", "verification_status"),
                                  ("reactions", "reactions"))
              if field in sent and getattr(patch, field) is None]
    if errors:
        raise ValidationFailed(errors=errors)  # null where the contract allows none
    reactions = _reactions(patch.reactions or [], today, errors)
    if errors:
        raise _rule(errors)
    changes = AllergyChanges(
        clinical_status=patch.clinical_status or UNSET if "clinical_status" in sent else UNSET,
        verification_status=(patch.verification_status or UNSET
                              if "verification_status" in sent else UNSET),
        criticality=patch.criticality if "criticality" in sent else UNSET,
        reactions=reactions if "reactions" in sent else UNSET,
        note=patch.note if "note" in sent else UNSET)
    try:
        await store.update_allergy(db, allergy_id, changes, if_version=version)
    except StaleVersion as changed:
        raise PreconditionFailed(headers={"ETag": etag(changed.current_version)}) from changed
    except ResourceNotFound as gone:
        raise NotFound() from gone
    except InvalidTransition as done:
        raise Conflict(code="invalid-state-transition",
                       currentState=done.current_state) from done
    except InvalidInput as refused:
        raise _invalid(refused) from refused
    await db.commit()
    return await repo.get(db, patient_id, allergy_id)


def may_mark_others(user: CurrentUser) -> bool:
    """RN marks only their own entries entered-in-error (the contract); a user with another
    role that grants it (MD, APP) may mark anyone's."""
    return any(roles_allow({role}, ENTERED_IN_ERROR) for role in user.roles if role != "RN")


async def mark_entered_in_error(db: AsyncSession, repo: AllergyRepository, store: FhirStore,
                                check: ChartCheck, user: CurrentUser, patient_id: UUID,
                                allergy_id: UUID, reason: str) -> AllergyRow:
    """D14: kept for audit and left out of the chart, with its Provenance (the reason)."""
    await check(db, user, patient_id)
    current = await repo.get(db, patient_id, allergy_id)
    if not may_mark_others(user) and current.created_by_user_id != user.id:
        raise Forbidden("A nurse marks only their own entries entered in error",
                        code="permission-denied")
    try:
        await store.allergy_entered_in_error(db, allergy_id, Reason(text=reason))
    except ResourceNotFound as gone:
        raise NotFound() from gone
    except InvalidTransition as done:
        raise Conflict(code="invalid-state-transition",
                       currentState=done.current_state) from done
    except InvalidInput as refused:  # a blank reason after trimming
        raise ValidationFailed(errors=[field_error("body", "/reason", "too-short")]) from refused
    await db.commit()
    return await repo.get(db, patient_id, allergy_id)
