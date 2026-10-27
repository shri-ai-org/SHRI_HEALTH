"""Reads for the patients API, and the MRN counter.

Writes go through Anand's FHIR write helpers (``store.FhirStore``); this module only reads, under
the request's session, so forced row-level security limits every query to the caller's clinic:
another clinic's patient is simply not found (``NotFound``, 404).

``PatientRepository`` is what the service needs; ``SqlPatientRepository`` reads the FHIR-shaped
tables with plain SQL, column names as in the models and
``backend/app/db/docs/contract_mapping.yaml`` (#87). It reads columns that migration 0007 (#74)
adds, so it only runs once that has merged; until then the API tests use an in-memory repository
(tests/fakes.py).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound

from . import schemas
from .matching import Person

RESTRICTED_LABELS = frozenset({"R", "V"})  # SECURITY_MODEL §5.2


@dataclass(frozen=True)
class Versioned[T]:
    value: T
    version: int  # meta_version_id: the ETag source


class PatientRepository(Protocol):
    async def search(self, db: AsyncSession, criteria: schemas.SearchCriteria, *, limit: int,
                     offset: int) -> list[schemas.PatientSummary]: ...

    async def get_patient(self, db: AsyncSession, patient_id: UUID
                          ) -> Versioned[schemas.Patient]: ...

    async def duplicate_pool(self, db: AsyncSession, birth_date: date, phones: Sequence[str]
                             ) -> dict[str, Person]:
        """Patients sharing the birth date or a phone, keyed by ID: the candidates the duplicate
        rule (matching.py) then checks. Active patients only."""
        ...

    async def mrn_system(self, db: AsyncSession) -> str | None: ...

    async def next_mrn(self, db: AsyncSession) -> tuple[str, str]:
        """(system, value) from ``admin.next_mrn()`` (D41). Locks the counter until commit, so the
        service calls it last."""
        ...

    async def list_identifiers(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                               offset: int) -> list[schemas.PatientIdentifier]: ...

    async def list_related(self, db: AsyncSession, patient_id: UUID, *, limit: int, offset: int
                           ) -> list[schemas.RelatedPerson]: ...

    async def get_related(self, db: AsyncSession, patient_id: UUID, related_person_id: UUID
                          ) -> Versioned[schemas.RelatedPerson]: ...


# ----------------------------------------------------------------------------------- SQL reads
_PATIENT = text("""
SELECT p.id, p.active, p.gender, p.birth_date, p.meta_security, p.meta_version_id, p.created_at,
       p.meta_last_updated, p.ext_birthsex, p.ext_race_text, p.ext_ethnicity_text,
       p.marital_status_code,
       p.ext_gender_identity_system, p.ext_gender_identity_code, p.ext_gender_identity_display,
       p.ext_gender_identity_text,
       p.ext_sexual_orientation_system, p.ext_sexual_orientation_code,
       p.ext_sexual_orientation_display, p.ext_sexual_orientation_text,
       p.ext_occupation_system, p.ext_occupation_code, p.ext_occupation_display,
       p.ext_occupation_text,
       p.ext_industry_system, p.ext_industry_code, p.ext_industry_display, p.ext_industry_text,
       p.ext_tribal_affiliation_system, p.ext_tribal_affiliation_code,
       p.ext_tribal_affiliation_display, p.ext_tribal_affiliation_text,
       (SELECT l.other_patient_id FROM clinical.patient_link l
         WHERE l.patient_id = p.id AND l.type = 'replaced-by' LIMIT 1) AS merged_into_id
FROM clinical.patient p WHERE p.id = :id
""")
_NAMES = text("""
SELECT patient_id, related_person_id, use, family, given, prefix, suffix, text
FROM clinical.human_name WHERE patient_id = ANY(:ids) OR related_person_id = ANY(:ids)
ORDER BY created_at, id
""")
_TELECOMS = text("""
SELECT patient_id, related_person_id, system, value, use, rank
FROM clinical.contact_point WHERE patient_id = ANY(:ids) OR related_person_id = ANY(:ids)
ORDER BY rank NULLS LAST, created_at, id
""")
_ADDRESSES = text("""
SELECT patient_id, related_person_id, line, city, state, postal_code, country
FROM clinical.address WHERE patient_id = ANY(:ids) OR related_person_id = ANY(:ids)
ORDER BY created_at, id
""")
_EMPLOYERS = text("""
SELECT patient_id, related_person_id, name, phone, address_lines, address_city, address_state,
       address_postal_code, address_country
FROM admin.employer WHERE patient_id = ANY(:ids) OR related_person_id = ANY(:ids)
""")
_IDENTIFIERS = text("""
SELECT id, type_code, system, value, assigner_display, supporting_document_id, use, created_at
FROM clinical.identifier WHERE patient_id = :id AND type_code IN ('MR', 'DL', 'PI')
ORDER BY (type_code = 'MR') DESC, created_at, id LIMIT :limit OFFSET :offset
""")
_RACE_ETHNICITY = text("""
SELECT kind, level, code FROM clinical.patient_race_ethnicity WHERE patient_id = :id
ORDER BY kind, level, code
""")
_LANGUAGE = text("""
SELECT language_code FROM clinical.patient_communication WHERE patient_id = :id AND preferred
""")
_SEARCH = text("""
SELECT p.id
FROM clinical.patient p
WHERE (:include_inactive OR p.active)
  AND (CAST(:birth_date AS date) IS NULL OR p.birth_date = :birth_date)
  AND (CAST(:family AS text) IS NULL OR EXISTS (
        SELECT 1 FROM clinical.human_name n WHERE n.patient_id = p.id
          AND lower(n.family) LIKE lower(:family) || '%'
          AND (CAST(:given AS text) IS NULL OR EXISTS (
                SELECT 1 FROM unnest(n.given) g WHERE lower(g) LIKE lower(:given) || '%'))))
  AND (CAST(:given AS text) IS NULL OR CAST(:family AS text) IS NOT NULL OR EXISTS (
        SELECT 1 FROM clinical.human_name n, unnest(n.given) g
         WHERE n.patient_id = p.id AND lower(g) LIKE lower(:given) || '%'))
  AND (CAST(:phone AS text) IS NULL OR EXISTS (
        SELECT 1 FROM clinical.contact_point c WHERE c.patient_id = p.id
          AND c.system IN ('phone', 'sms') AND c.value = :phone))
  AND (CAST(:mrn AS text) IS NULL OR EXISTS (
        SELECT 1 FROM clinical.identifier i WHERE i.patient_id = p.id
          AND i.type_code = 'MR' AND i.value = :mrn))
  AND (CAST(:dl AS text) IS NULL OR EXISTS (
        SELECT 1 FROM clinical.identifier i WHERE i.patient_id = p.id
          AND i.type_code = 'DL' AND i.value = :dl))
  AND (CAST(:member_id AS text) IS NULL OR EXISTS (
        SELECT 1 FROM clinical.coverage cv JOIN clinical.identifier i ON i.coverage_id = cv.id
         WHERE cv.beneficiary_patient_id = p.id AND i.type_code = 'MB' AND i.value = :member_id))
ORDER BY p.id
LIMIT :limit OFFSET :offset
""")
_POOL = text("""
SELECT DISTINCT p.id FROM clinical.patient p
WHERE p.active AND (p.birth_date = :birth_date OR EXISTS (
  SELECT 1 FROM clinical.contact_point c WHERE c.patient_id = p.id
    AND c.system IN ('phone', 'sms') AND c.value = ANY(:phones)))
LIMIT 200
""")
_BIRTH_DATE = text("SELECT birth_date FROM clinical.patient WHERE id = :id")
_RELATED = text("""
SELECT r.id, r.patient_id, r.active, r.gender, r.birth_date, r.meta_version_id, r.created_at,
       r.meta_last_updated
FROM clinical.related_person r
WHERE r.patient_id = :patient_id AND (CAST(:id AS uuid) IS NULL OR r.id = :id)
ORDER BY r.created_at, r.id LIMIT :limit OFFSET :offset
""")
_RELATIONSHIPS = text("""
SELECT related_person_id, code_system, code_code, code_display, code_text
FROM clinical.related_person_relationship WHERE related_person_id = ANY(:ids)
ORDER BY created_at, id
""")


def _coded(row: Mapping[str, Any], prefix: str) -> schemas.CodedValue | None:
    values = {k: row[f"{prefix}_{k}"] for k in ("system", "code", "display", "text")}
    return schemas.CodedValue(**values) if any(values.values()) else None


def _name(row: Mapping[str, Any]) -> schemas.HumanName:
    prefix, suffix = row["prefix"] or [None], row["suffix"] or [None]
    return schemas.HumanName(family=row["family"] or "", given=list(row["given"] or []),
                             prefix=prefix[0], suffix=suffix[0])


def _address(row: Mapping[str, Any]) -> schemas.Address:
    return schemas.Address(lines=list(row["line"] or []), city=row["city"], state=row["state"],
                           postal_code=row["postal_code"], country=row["country"] or "US")


def _employer(row: Mapping[str, Any]) -> schemas.Employer:
    address = None
    if row["address_lines"]:
        address = schemas.Address(
            lines=list(row["address_lines"]), city=row["address_city"], state=row["address_state"],
            postal_code=row["address_postal_code"], country=row["address_country"] or "US")
    return schemas.Employer(name=row["name"], phone=row["phone"], address=address)


def _contacts(rows: Iterable[Mapping[str, Any]]) -> tuple[list[schemas.Phone], list[schemas.Email]]:
    phones: list[schemas.Phone] = []
    emails: list[schemas.Email] = []
    for r in rows:
        if r["system"] == "email":
            emails.append(schemas.Email(address=r["value"], use=r["use"]))
        else:
            phones.append(schemas.Phone(number=r["value"], use=r["use"],
                                        text_messages=r["system"] == "sms"))
    return phones, emails


def _race(rows: Sequence[Mapping[str, Any]], kind: str, text_value: str | None
          ) -> schemas.RaceEthnicity | None:
    mine = [r for r in rows if r["kind"] == kind]
    if not mine and not text_value:
        return None
    return schemas.RaceEthnicity(
        omb_categories=[r["code"] for r in mine if r["level"] == "ombCategory"],
        detailed=[r["code"] for r in mine if r["level"] != "ombCategory"], text=text_value)


class SqlPatientRepository:
    async def _children(self, db: AsyncSession, query: Any, ids: Sequence[UUID]
                        ) -> list[Mapping[str, Any]]:
        result = await db.execute(query, {"ids": list(ids)})
        return [dict(r) for r in result.mappings()]

    async def get_patient(self, db: AsyncSession, patient_id: UUID
                          ) -> Versioned[schemas.Patient]:
        found = (await db.execute(_PATIENT, {"id": patient_id})).mappings().first()
        if found is None:
            raise NotFound()
        row: dict[str, Any] = dict(found)
        names = await self._children(db, _NAMES, [patient_id])
        official = next((n for n in names if n["use"] == "official"), names[0] if names else None)
        phones, emails = _contacts(await self._children(db, _TELECOMS, [patient_id]))
        addresses = await self._children(db, _ADDRESSES, [patient_id])
        employers = await self._children(db, _EMPLOYERS, [patient_id])
        identifiers = await self.list_identifiers(db, patient_id, limit=20, offset=0)
        race_rows = [dict(r) for r in (await db.execute(_RACE_ETHNICITY, {"id": patient_id})
                                       ).mappings()]
        language = (await db.execute(_LANGUAGE, {"id": patient_id})).scalar_one_or_none()
        mrn = next((i.value for i in identifiers if i.type == "MR"), "")
        patient = schemas.Patient(
            id=row["id"], mrn=mrn,
            name=_name(official) if official else schemas.HumanName(family=""),
            preferred_name=next((n["text"] for n in names if n["use"] == "nickname"), None),
            previous_names=[_name(n) for n in names if n["use"] in ("old", "maiden")],
            birth_date=row["birth_date"], gender=row["gender"], birth_sex=row["ext_birthsex"],
            gender_identity=_coded(row, "ext_gender_identity"),
            sexual_orientation=_coded(row, "ext_sexual_orientation"),
            race=_race(race_rows, "race", row["ext_race_text"]),
            ethnicity=_race(race_rows, "ethnicity", row["ext_ethnicity_text"]),
            preferred_language=language, marital_status=row["marital_status_code"],
            occupation=_coded(row, "ext_occupation"), industry=_coded(row, "ext_industry"),
            tribal_affiliation=_coded(row, "ext_tribal_affiliation"),
            phones=phones, emails=emails,
            address=_address(addresses[0]) if addresses else None,
            employer=_employer(employers[0]) if employers else None,
            identifiers=identifiers,
            restricted=bool(RESTRICTED_LABELS & set(row["meta_security"] or [])),
            active=row["active"], merged_into_id=row["merged_into_id"],
            created_at=row["created_at"], updated_at=row["meta_last_updated"])
        return Versioned(patient, row["meta_version_id"])

    async def search(self, db: AsyncSession, criteria: schemas.SearchCriteria, *, limit: int,
                     offset: int) -> list[schemas.PatientSummary]:
        ids = list((await db.execute(_SEARCH, {
            "include_inactive": criteria.include_inactive, "birth_date": criteria.birth_date,
            "family": criteria.family, "given": criteria.given, "phone": criteria.phone,
            "mrn": criteria.mrn, "dl": criteria.drivers_license_number,
            "member_id": criteria.member_id, "limit": limit, "offset": offset,
        })).scalars())
        summaries = []
        for patient_id in ids:
            found = (await self.get_patient(db, patient_id)).value
            last4 = found.phones[0].number[-4:] if found.phones else None
            summaries.append(schemas.PatientSummary(
                id=found.id, name=found.name, birth_date=found.birth_date, gender=found.gender,
                mrn=found.mrn, phone_last4=last4, restricted=found.restricted,
                active=found.active))
        return summaries

    async def duplicate_pool(self, db: AsyncSession, birth_date: date, phones: Sequence[str]
                             ) -> dict[str, Person]:
        ids = list((await db.execute(_POOL, {"birth_date": birth_date, "phones": list(phones)})
                    ).scalars())
        pool: dict[str, Person] = {}
        for patient_id in ids:
            names = await self._children(db, _NAMES, [patient_id])
            official = next((n for n in names if n["use"] == "official"), None)
            if official is None:
                continue
            numbers = await self._children(db, _TELECOMS, [patient_id])
            birth = (await db.execute(_BIRTH_DATE, {"id": patient_id})).scalar_one()
            pool[str(patient_id)] = Person(
                family=official["family"] or "", given=tuple(official["given"] or ()),
                birth_date=birth,
                phones=frozenset(n["value"] for n in numbers if n["system"] in ("phone", "sms")),
                previous_families=tuple(n["family"] for n in names
                                        if n["use"] in ("old", "maiden") and n["family"]))
        return pool

    async def mrn_system(self, db: AsyncSession) -> str | None:
        found = await db.execute(text("SELECT system FROM admin.mrn_counter"))
        system: str | None = found.scalar_one_or_none()
        return system

    async def next_mrn(self, db: AsyncSession) -> tuple[str, str]:
        row = (await db.execute(text("SELECT system, value FROM admin.next_mrn()"))).one()
        return str(row.system), str(row.value)

    async def list_identifiers(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                               offset: int) -> list[schemas.PatientIdentifier]:
        rows = (await db.execute(_IDENTIFIERS, {"id": patient_id, "limit": limit,
                                                "offset": offset})).mappings()
        return [schemas.PatientIdentifier(
            id=r["id"], type=r["type_code"], system=r["system"], value=r["value"],
            assigner=r["assigner_display"], document_id=r["supporting_document_id"],
            use=r["use"], created_at=r["created_at"]) for r in rows]

    async def _related(self, db: AsyncSession, patient_id: UUID, related_id: UUID | None, *,
                       limit: int, offset: int) -> list[Versioned[schemas.RelatedPerson]]:
        rows = [dict(r) for r in (await db.execute(_RELATED, {
            "patient_id": patient_id, "id": related_id, "limit": limit, "offset": offset,
        })).mappings()]
        ids = [r["id"] for r in rows]
        names = await self._children(db, _NAMES, ids)
        telecoms = await self._children(db, _TELECOMS, ids)
        addresses = await self._children(db, _ADDRESSES, ids)
        employers = await self._children(db, _EMPLOYERS, ids)
        relationships = await self._children(db, _RELATIONSHIPS, ids)
        out = []
        for r in rows:
            mine = r["id"]
            name = next((n for n in names if n["related_person_id"] == mine), None)
            phones, emails = _contacts(t for t in telecoms if t["related_person_id"] == mine)
            address = next((a for a in addresses if a["related_person_id"] == mine), None)
            employer = next((e for e in employers if e["related_person_id"] == mine), None)
            out.append(Versioned(schemas.RelatedPerson(
                id=mine, patient_id=r["patient_id"],
                name=_name(name) if name else schemas.HumanName(family=""),
                relationships=[schemas.CodedValue(system=x["code_system"], code=x["code_code"],
                                                  display=x["code_display"], text=x["code_text"])
                               for x in relationships if x["related_person_id"] == mine],
                gender=r["gender"], birth_date=r["birth_date"], phones=phones, emails=emails,
                address=_address(address) if address else None,
                employer=_employer(employer) if employer else None,
                active=r["active"], created_at=r["created_at"],
                updated_at=r["meta_last_updated"]), r["meta_version_id"]))
        return out

    async def list_related(self, db: AsyncSession, patient_id: UUID, *, limit: int, offset: int
                           ) -> list[schemas.RelatedPerson]:
        found = await self._related(db, patient_id, None, limit=limit, offset=offset)
        return [v.value for v in found]

    async def get_related(self, db: AsyncSession, patient_id: UUID, related_person_id: UUID
                          ) -> Versioned[schemas.RelatedPerson]:
        found = await self._related(db, patient_id, related_person_id, limit=1, offset=0)
        if not found:
            raise NotFound()
        return found[0]
