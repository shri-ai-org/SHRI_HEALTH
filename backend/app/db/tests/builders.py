"""Small builders for test charts (synthetic data only)."""
from __future__ import annotations

import datetime as dt
import secrets
import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import MAPPERS, systems

M = MAPPERS
NOW = dt.datetime(2026, 10, 22, 14, 0, tzinfo=dt.UTC)


def npi() -> str:
    """A random NPI with a valid check digit."""
    base = "1" + "".join(secrets.choice("0123456789") for _ in range(8))
    total = 24
    for pos, ch in enumerate(base, start=1):
        d = int(ch)
        if pos % 2 == 1:
            d *= 2
            total += d // 10 + d % 10
        else:
            total += d
    return base + str((10 - total % 10) % 10)


def practice(db: Session) -> dict[str, Any]:
    """Organization, site Location + Facility, a practitioner with a linked user."""
    org = M["organization"](name="Lakeside Neurology", type_system=systems.ORGANIZATION_TYPE,
                            type_code="prov")
    site = M["location"](name="Lakeside main office",
                         physical_type_system=systems.LOCATION_PHYSICAL_TYPE,
                         physical_type_code="si", managing_organization_id=None)
    db.add_all([org, site])
    db.flush()
    site.managing_organization_id = org.id
    room = M["location"](name="Exam 1", physical_type_system=systems.LOCATION_PHYSICAL_TYPE,
                         physical_type_code="ro", part_of_location_id=site.id)
    fac = M["facility"](location_id=site.id, code="MAIN", name="Main office",
                        timezone="America/New_York")
    dr = practitioner(db, "Rivera", "Elena")
    db.add_all([room, fac])
    db.flush()
    return {"org": org, "site": site, "room": room, "facility": fac, **dr}


def practitioner(db: Session, family: str, given: str) -> dict[str, Any]:
    p = M["practitioner"]()
    p.identifier = [M["identifier"](system=systems.NPI, value=npi(), use="official")]
    p.name = [M["human_name"](family=family, given=[given], prefix=["Dr."], use="official")]
    db.add(p)
    db.flush()
    user = M["app_user"](tenant_id=db.info["tenant_id"], keycloak_subject=str(uuid.uuid4()),
                         username=f"{given.lower()}.{family.lower()}.{uuid.uuid4().hex[:6]}",
                         display_name=f"{given} {family}", practitioner_id=p.id)
    db.add(user)
    db.flush()
    return {"practitioner": p, "user": user}


def patient(db: Session, family: str = "Nguyen", given: str = "Mai", **kw: Any) -> Any:
    p = M["patient"](gender="female", birth_date=dt.date(1984, 3, 9), ext_birthsex="F", **kw)
    p.identifier = [M["identifier"](system="urn:oid:2.16.840.1.113883.3.0000.1",
                                    value=f"MRN-{uuid.uuid4().hex[:8]}",
                                        type_system=systems.V2_0203,
                                    type_code="MR", use="usual")]
    p.name = [M["human_name"](family=family, given=[given], use="official")]
    p.telecom = [M["contact_point"](system="phone", value="+1 (555) 010-2000", use="mobile",
                                    rank=1)]
    p.address = [M["address"](line=["12 Elm St"], city="Columbus", state="OH",
                              postal_code="43004", country="US", use="home")]
    p.race_ethnicity = [M["patient_race_ethnicity"](kind="race", level="ombCategory",
                                                    code="2106-3", display="White")]
    p.communication = [M["patient_communication"](language_system=systems.LANGUAGE,
                                                  language_code="en-US", preferred=True)]
    db.add(p)
    db.flush()
    return p


def encounter(db: Session, pt: Any, ctx: dict[str, Any], status: str = "in-progress") -> Any:
    e = M["encounter"](status=status, class_="AMB", subject_patient_id=pt.id,
                       period_start=NOW, period_end=NOW + dt.timedelta(minutes=20)
                       if status == "finished" else None,
                       service_provider_organization_id=ctx["org"].id)
    e.participant = [M["encounter_participant"](type_system=systems.V3_PARTICIPATION_TYPE,
                                                type_code="PPRF",
                                                individual_practitioner_id=ctx["practitioner"].id)]
    db.add(e)
    db.flush()
    return e


def condition(db: Session, pt: Any, enc: Any = None, code: str = "G43.909",
              display: str = "Migraine") -> Any:
    c = M["condition"](clinical_status="active", verification_status="confirmed",
                       code_system=systems.ICD10CM, code_code=code, code_display=display,
                       subject_patient_id=pt.id, encounter_id=enc.id if enc else None,
                       onset_date_time=NOW - dt.timedelta(days=400), recorded_date=NOW)
    c.category = [M["condition_category"](category_system=systems.CONDITION_CATEGORY,
                                          category_code="problem-list-item")]
    db.add(c)
    db.flush()
    return c


def blood_pressure(db: Session, pt: Any, enc: Any, status: str = "final") -> Any:
    o = M["observation"](status=status, code_system=systems.LOINC, code_code="85354-9",
                         code_display="Blood pressure panel", subject_patient_id=pt.id,
                         encounter_id=enc.id, effective_date_time=NOW, issued=NOW)
    o.category = [M["observation_category"](category_system=systems.OBSERVATION_CATEGORY,
                                            category_code="vital-signs")]
    o.component = [
        M["observation_component"](sequence=1, code_system=systems.LOINC, code_code="8480-6",
                                   code_display="Systolic", value_quantity_value=128,
                                   value_quantity_unit="mmHg", value_quantity_system=systems.UCUM,
                                   value_quantity_code="mm[Hg]"),
        M["observation_component"](sequence=2, code_system=systems.LOINC, code_code="8462-4",
                                   code_display="Diastolic", value_quantity_value=82,
                                   value_quantity_unit="mmHg", value_quantity_system=systems.UCUM,
                                   value_quantity_code="mm[Hg]")]
    db.add(o)
    db.flush()
    return o


def prescription(db: Session, pt: Any, enc: Any, ctx: dict[str, Any], **kw: Any) -> Any:
    mr = M["medication_request"](
        status="draft", intent="order", subject_patient_id=pt.id, encounter_id=enc.id,
        medication_codeable_concept_system=systems.RXNORM,
            medication_codeable_concept_code="1049630",
        medication_codeable_concept_display="Sumatriptan 50 MG Oral Tablet",
        requester_practitioner_id=ctx["practitioner"].id, authored_on=NOW, category=["community"],
        dispense_request_number_of_repeats_allowed=2, dispense_request_quantity_value=9,
        dispense_request_quantity_unit="tablet", **kw)
    mr.dosage_instruction = [M["dosage"](sequence=1, text="Take 1 tablet at migraine onset",
                                         as_needed_boolean=True,
                                         dose_and_rate_dose_quantity_value=1,
                                         dose_and_rate_dose_quantity_unit="tablet")]
    db.add(mr)
    db.flush()
    return mr


def sign_prescription(db: Session, mr: Any, ctx: dict[str, Any]) -> None:
    practitioner_id, user_id = ctx["practitioner"].id, ctx["user"].id
    with db.no_autoflush:
        mr.status = "active"
        mr.ext_signed_at = NOW
        mr.ext_signed_by_practitioner_id = practitioner_id
        mr.ext_signed_by_user_id = user_id
    db.flush()


def note(db: Session, pt: Any, enc: Any, ctx: dict[str, Any]) -> Any:
    c = M["composition"](status="preliminary", type_system=systems.LOINC, type_code="11506-3",
                         type_display="Progress note", subject_patient_id=pt.id,
                         encounter_id=enc.id, date=NOW, title="Follow-up visit")
    c.author = [M["composition_author"](practitioner_id=ctx["practitioner"].id)]
    c.section = [M["composition_section"](sequence=1, title="Assessment and plan",
                                          code_system=systems.LOINC, code_code="51847-2",
                                          text_status="generated",
                                          text_div='<div xmlns="http://www.w3.org/1999/xhtml">'
                                                   "Migraine, improving.</div>")]
    db.add(c)
    db.flush()
    return c


def sign_note(db: Session, comp: Any, ctx: dict[str, Any], mode: str = "legal") -> None:
    practitioner_id, user_id, comp_id = ctx["practitioner"].id, ctx["user"].id, comp.id
    db.add(M["composition_attester"](composition_id=comp_id, mode=mode, time=NOW,
                                     party_practitioner_id=practitioner_id,
                                     ext_user_id=user_id, ext_content_sha256="0" * 64))
    db.flush()
    if comp.status == "preliminary":
        comp.status = "final"
        db.flush()
