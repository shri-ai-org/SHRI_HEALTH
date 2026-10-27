"""Rules for patients, identifiers and related persons (patients.yaml; batch 1 plan §2.1).

The service owns the transaction: it reads through the repository, writes through the FHIR write
helpers (``store.FhirStore``), and commits once, so a request's writes land together or not at
all (DATA_OWNERSHIP §3.1). Core's middleware writes the audit rows inside the same commit (#79).
"""

from __future__ import annotations

import base64
import binascii
from datetime import date
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict, NotFound, ValidationFailed, field_error

from . import schemas
from .matching import Person, possible_duplicates
from .repository import PatientRepository, Versioned
from .store import (
    UNSET,
    EmployerIn,
    FhirStore,
    IdentifierIn,
    Name,
    PatientIn,
    PostalAddress,
    RaceOrEthnicity,
    RelatedPersonChanges,
    RelatedPersonIn,
    ResourceNotFound,
    StaleVersion,
    Telecom,
    Written,
)
from .store import Coded as StoreCoded

class InvalidCursor(AppError):
    """400 invalid-cursor (API_STANDARDS §9.3); core has no 400 class yet."""

    default_code = "invalid-cursor"


class PreconditionFailed(AppError):
    """412 precondition-failed, with the current ETag (API_STANDARDS §11)."""

    default_code = "precondition-failed"


class PreconditionRequired(AppError):
    default_code = "precondition-required"


def business_rule(location: str, where: str, code: str) -> ValidationFailed:
    return ValidationFailed(code="business-rule-violation",
                            errors=[field_error(location, where, code)])


# ------------------------------------------------------------------------ ETags, If-Match, cursors
def etag(version: int) -> str:
    """A strong ETag from the row version (API_STANDARDS §11)."""
    return f'"{version}"'


def if_match_version(header: str | None) -> int:
    if header is None:
        raise PreconditionRequired()
    value = header.strip()
    if value.startswith('"') and value.endswith('"') and value[1:-1].isdigit():
        return int(value[1:-1])
    raise PreconditionFailed()  # a weak or malformed tag never matches a strong one


def stale(error: StaleVersion) -> PreconditionFailed:
    return PreconditionFailed(headers={"ETag": etag(error.current_version)})


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


def page[T](items: list[T], limit: int, offset: int) -> tuple[list[T], str | None]:
    """The repository fetches limit + 1 rows; the extra one says whether there is a next page."""
    if len(items) > limit:
        return items[:limit], encode_cursor(offset + limit)
    return items, None


# --------------------------------------------------------------------------------- conversions
def _name(n: schemas.HumanName, use: str) -> Name:
    return Name(use=use, family=n.family, given=tuple(n.given),
                prefix=(n.prefix,) if n.prefix else (), suffix=(n.suffix,) if n.suffix else ())


def _coded(c: schemas.CodedValue | None) -> StoreCoded | None:
    return StoreCoded(system=c.system, code=c.code, display=c.display, text=c.text) if c else None


def _race(r: schemas.RaceEthnicity | None) -> RaceOrEthnicity | None:
    if r is None:
        return None
    return RaceOrEthnicity(omb_categories=tuple(r.omb_categories), detailed=tuple(r.detailed),
                           text=r.text)


def _address(a: schemas.Address | None) -> PostalAddress | None:
    if a is None:
        return None
    return PostalAddress(lines=tuple(a.lines), city=a.city, state=a.state,
                         postal_code=a.postal_code, country=a.country)


def _employer(e: schemas.Employer | None) -> EmployerIn | None:
    return EmployerIn(name=e.name, phone=e.phone, address=_address(e.address)) if e else None


def _telecoms(phones: list[schemas.Phone], emails: list[schemas.Email]) -> tuple[Telecom, ...]:
    """`textMessages: true` is stored as an `sms` contact point (contract_mapping.yaml, #87)."""
    return (*(Telecom(system="sms" if p.text_messages else "phone", value=p.number, use=p.use,
                      rank=i + 1) for i, p in enumerate(phones)),
            *(Telecom(system="email", value=e.address, use=e.use) for e in emails))


def _identifier(i: schemas.PatientIdentifierCreate) -> IdentifierIn:
    return IdentifierIn(system=i.system or "", value=i.value, type_code=i.type, use="official",
                        assigner_display=i.assigner, supporting_document_id=i.document_id)


def patient_in(body: schemas.PatientCreate, mrn_system: str, mrn: str) -> PatientIn:
    names = (_name(body.name, "official"),
             *((Name(use="nickname", text=body.preferred_name),) if body.preferred_name else ()),
             *(_name(n, "old") for n in body.previous_names))
    return PatientIn(
        names=names, birth_date=body.birth_date, gender=body.gender or "unknown",
        birth_sex=body.birth_sex, gender_identity=_coded(body.gender_identity),
        sexual_orientation=_coded(body.sexual_orientation), occupation=_coded(body.occupation),
        industry=_coded(body.industry), tribal_affiliation=_coded(body.tribal_affiliation),
        race=_race(body.race), ethnicity=_race(body.ethnicity),
        preferred_language=body.preferred_language, marital_status=body.marital_status,
        telecoms=_telecoms(body.phones, body.emails),
        addresses=tuple(a for a in (_address(body.address),) if a is not None),
        identifiers=(IdentifierIn(system=mrn_system, value=mrn, type_code="MR", use="usual"),
                     *(_identifier(i) for i in body.identifiers)),
        employer=_employer(body.employer), entry_source="clinician")


def _relationships(codes: list[schemas.CodedValue]) -> tuple[StoreCoded, ...]:
    return tuple(c for c in (_coded(x) for x in codes) if c is not None)


def related_in(patient_id: UUID, body: schemas.RelatedPersonCreate) -> RelatedPersonIn:
    return RelatedPersonIn(
        patient_id=patient_id, relationships=_relationships(body.relationships),
        names=(_name(body.name, "official"),), gender=body.gender, birth_date=body.birth_date,
        telecoms=_telecoms(body.phones, body.emails),
        addresses=tuple(a for a in (_address(body.address),) if a is not None),
        employer=_employer(body.employer))


def related_changes(patch: schemas.RelatedPersonPatch) -> RelatedPersonChanges:
    """Merge patch: only the fields sent change; `null` clears; lists replace the stored list."""
    sent = patch.model_fields_set
    phones = patch.phones if "phones" in sent else None
    emails = patch.emails if "emails" in sent else None
    for required in ("name", "relationships", "active"):
        if required in sent and getattr(patch, required) is None:
            raise business_rule("body", f"/{required}", "required")
    return RelatedPersonChanges(
        names=(_name(patch.name, "official"),) if "name" in sent and patch.name else UNSET,
        relationships=_relationships(patch.relationships)
        if "relationships" in sent and patch.relationships else UNSET,
        active=patch.active if "active" in sent and patch.active is not None else UNSET,
        gender=patch.gender if "gender" in sent else UNSET,
        birth_date=patch.birth_date if "birth_date" in sent else UNSET,
        telecoms=_telecoms(phones or [], emails or [])
        if "phones" in sent or "emails" in sent else UNSET,
        addresses=tuple(a for a in (_address(patch.address),) if a is not None)
        if "address" in sent else UNSET,
        employer=_employer(patch.employer) if "employer" in sent else UNSET)


# ---------------------------------------------------------------------------------- operations
def check_search_criteria(c: schemas.SearchCriteria) -> None:
    """API_STANDARDS §14.3: an exact identifier (MRN, driver's license, member ID or the full
    phone), or at least two of family name, given name and date of birth."""
    if c.mrn or c.drivers_license_number or c.member_id or c.phone:
        return
    if sum(x is not None for x in (c.family, c.given, c.birth_date)) >= 2:
        return
    raise business_rule("body", "/criteria", "required")


async def register(db: AsyncSession, repo: PatientRepository, store: FhirStore,
                   body: schemas.PatientCreate, *, today: date) -> Versioned[schemas.Patient]:
    if body.birth_date > today:
        raise business_rule("body", "/birthDate", "out-of-range")
    if body.duplicate_check == "override" and not (body.duplicate_override_reason or "").strip():
        raise business_rule("body", "/duplicateOverrideReason", "required")
    mrn_system = await repo.mrn_system(db)
    for n, identifier in enumerate(body.identifiers):
        if mrn_system and identifier.system == mrn_system:
            # An MRN only ever comes from the practice's counter (D41).
            raise business_rule("body", f"/identifiers/{n}/system", "not-allowed-value")
    if body.duplicate_check == "default":
        new = Person(family=body.name.family, given=tuple(body.name.given),
                     birth_date=body.birth_date, phones=frozenset(p.number for p in body.phones),
                     previous_families=tuple(n.family for n in body.previous_names))
        pool = await repo.duplicate_pool(db, body.birth_date, [p.number for p in body.phones])
        matches = possible_duplicates(new, pool)
        if matches:
            raise Conflict(code="possible-duplicate",
                           detail="Matching patients exist. Review them, or resend with an "
                                  "override reason.",
                           candidateIds=[patient_id for patient_id, _ in matches])
    system, mrn = await repo.next_mrn(db)  # last: the counter stays locked until commit
    written = await store.create_patient(db, patient_in(body, system, mrn))
    await db.commit()
    return await repo.get_patient(db, written.id)


async def readable_patient(db: AsyncSession, repo: PatientRepository, patient_id: UUID
                           ) -> Versioned[schemas.Patient]:
    """The patient, or 404; used before any child read or write."""
    return await repo.get_patient(db, patient_id)


def writable(patient: schemas.Patient) -> None:
    if patient.merged_into_id is not None:
        raise Conflict(code="patient-merged")


async def add_identifier(db: AsyncSession, repo: PatientRepository, store: FhirStore,
                         patient: schemas.Patient, body: schemas.PatientIdentifierCreate
                         ) -> schemas.PatientIdentifier:
    writable(patient)
    mrn_system = await repo.mrn_system(db)
    if mrn_system and body.system == mrn_system:
        raise business_rule("body", "/system", "not-allowed-value")
    try:
        written = await store.add_patient_identifier(db, patient.id, _identifier(body))
    except ResourceNotFound as gone:
        raise NotFound() from gone
    await db.commit()
    found = await repo.list_identifiers(db, patient.id, limit=100, offset=0)
    return next(i for i in found if i.id == written.child_id)


async def add_related(db: AsyncSession, repo: PatientRepository, store: FhirStore,
                      patient: schemas.Patient, body: schemas.RelatedPersonCreate
                      ) -> Versioned[schemas.RelatedPerson]:
    writable(patient)
    written = await store.create_related_person(db, related_in(patient.id, body))
    await db.commit()
    return await repo.get_related(db, patient.id, written.id)


async def update_related(db: AsyncSession, repo: PatientRepository, store: FhirStore,
                         patient: schemas.Patient, related_person_id: UUID,
                         patch: schemas.RelatedPersonPatch, if_match: str | None
                         ) -> Versioned[schemas.RelatedPerson]:
    version = if_match_version(if_match)
    writable(patient)
    await repo.get_related(db, patient.id, related_person_id)  # 404 if not this patient's
    changes = related_changes(patch)
    try:
        written: Written = await store.update_related_person(db, related_person_id, changes,
                                                             if_version=version)
    except StaleVersion as changed:
        raise stale(changed) from changed
    except ResourceNotFound as gone:
        raise NotFound() from gone
    await db.commit()
    return await repo.get_related(db, patient.id, written.id)
