"""Encounter diagnoses (inventory #71-72; D14, D24, D73): a Condition with category
``encounter-diagnosis`` and its rank on the encounter, 1 to 12, written through Anand's helpers in
the request's transaction.

- **Add** is allowed until the encounter's first note is signed (then ``409 record-locked``), and
  only while the visit is open. The code must be a billable ICD-10-CM code in Anand's terminology
  table; a code already on the encounter, or a thirteenth diagnosis, is refused. A taken rank
  moves the others down.
- **Remove** (before signing) makes the Condition ``entered-in-error`` with the reason in its
  Provenance and deletes only its rank link, so the ranks after it close up (D24, D73). Nothing
  is deleted from the record.
- **Entered-in-error after signing** (#73) is not built: it keeps the rank link, and
  ``app.db.fhir_store`` has no helper for a Condition's entered-in-error yet (note for Anand).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import Conflict, NotFound, field_error
from app.db.fhir_store import (
    Coded,
    DiagnosisIn,
    FhirStore,
    InvalidInput,
    InvalidTransition,
    Reason,
    ResourceNotFound,
)
from app.db.models import systems

from . import diagnoses_schemas as dschemas
from . import schemas
from .diagnoses_repository import DiagnosisRepository
from .repository import EncounterRepository, Versioned
from .service import ChartCheck, business_rule, readable

#: The claim holds at most 12 diagnoses (837P).
MAX_RANK = 12
#: Diagnoses change only while the visit is open.
CLOSED = ("finished", "cancelled", "entered-in-error")

NamePatient = Callable[[UUID], None]


def _locked() -> Conflict:
    return Conflict("The encounter's note is signed: use entered-in-error and an addendum",
                    code="record-locked")


def _state(current: str) -> Conflict:
    return Conflict(code="invalid-state-transition", currentState=current)


def _onset(value: str | None) -> datetime | None:
    """``onsetDate`` as the helper stores it (``onset_date_time``). Only a full date fits: a
    year or a month alone would be stored as its first day, so it is refused (a helper that
    keeps a partial date is a note for Anand)."""
    if value is None:
        return None
    if len(value) != 10:
        raise business_rule([field_error("body", "/onsetDate", "not-allowed-value")])
    try:
        day = date.fromisoformat(value)
    except ValueError as bad:
        raise business_rule([field_error("body", "/onsetDate", "invalid-format")]) from bad
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


async def add(db: AsyncSession, repo: EncounterRepository, drepo: DiagnosisRepository,
              store: FhirStore, check: ChartCheck, user: CurrentUser, encounter_id: UUID,
              body: dschemas.DiagnosisCreate, name_patient: NamePatient
              ) -> Versioned[schemas.EncounterDiagnosis]:
    head = await readable(db, repo, check, user, encounter_id)
    errors = []
    if body.code.system != systems.ICD10CM:
        errors.append(field_error("body", "/code/system", "not-allowed-value"))
    if body.additional_codings:  # the Condition holds one coding (note for Anand)
        errors.append(field_error("body", "/additionalCodings", "not-allowed-value"))
    onset = _onset(body.onset_date)
    concept = None
    if not errors:
        concept = await drepo.icd10cm(db, body.code.code)
        if concept is None:
            errors.append(field_error("body", "/code/code", "invalid-reference"))
        elif not concept.billable:  # a header code
            errors.append(field_error("body", "/code/code", "not-allowed-value"))
    if errors or concept is None:
        raise business_rule(errors)
    locked = await repo.head(db, encounter_id, lock=True)  # no status change or rank race
    if locked.status in CLOSED:
        raise _state(locked.status)
    if await drepo.encounter_signed(db, encounter_id):
        raise _locked()
    live = await drepo.live(db, encounter_id)
    if any(d.system == systems.ICD10CM and d.code == concept.code for d in live):
        raise business_rule([field_error("body", "/code/code", "conflicting-fields")])
    if len(live) >= MAX_RANK:
        raise business_rule([field_error("body", "/rank", "out-of-range")])
    if body.rank is not None and body.rank > len(live) + 1:
        raise business_rule([field_error("body", "/rank", "out-of-range")])
    try:
        written = await store.add_encounter_diagnosis(db, encounter_id, DiagnosisIn(
            code=Coded(system=systems.ICD10CM, code=concept.code, display=concept.display),
            rank=body.rank, verification_status=body.verification_status,
            onset_date_time=onset))
    except InvalidInput as refused:
        raise business_rule([field_error("body", "/rank", "out-of-range")]) from refused
    name_patient(head.patient_id)
    await db.commit()
    found = await drepo.get(db, encounter_id, written.condition.id)
    if found is None:  # just written in this clinic
        raise NotFound()
    return found


async def remove(db: AsyncSession, repo: EncounterRepository, drepo: DiagnosisRepository,
                 store: FhirStore, check: ChartCheck, user: CurrentUser, encounter_id: UUID,
                 diagnosis_id: UUID, reason: str, name_patient: NamePatient
                 ) -> Versioned[schemas.EncounterDiagnosis]:
    head = await readable(db, repo, check, user, encounter_id)
    if not reason.strip():
        raise business_rule([field_error("body", "/reason", "required")])
    locked = await repo.head(db, encounter_id, lock=True)
    current = await drepo.get(db, encounter_id, diagnosis_id)
    if current is None:
        raise NotFound()
    if current.value.verification_status == "entered-in-error":
        raise _state("entered-in-error")
    if await drepo.encounter_signed(db, encounter_id):
        raise _locked()
    if locked.status in CLOSED:
        raise _state(locked.status)
    try:
        await store.remove_encounter_diagnosis(db, encounter_id, diagnosis_id,
                                               Reason(text=reason))
    except ResourceNotFound as gone:
        raise NotFound() from gone
    except InvalidTransition as done:
        raise _state(done.current_state) from done
    except InvalidInput as refused:
        raise business_rule([field_error("body", "/reason", "required")]) from refused
    name_patient(head.patient_id)
    await db.commit()
    found = await drepo.get(db, encounter_id, diagnosis_id)
    if found is None:
        raise NotFound()
    return found
