"""The starter layer: two synthetic practices for core's dev users (CLINIC_A, CLINIC_B).

The NPIs are valid in format but not registered: each was checked against the public NPPES
registry (no result) before it was used. The LOINC codes of the note templates were checked
against the National Library of Medicine's LOINC tables.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, time
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

import app.db.session  # noqa: F401  (fills child rows' tenant_id)
from app.core.config import Settings
from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS, FACILITY_A, FACILITY_B
from app.db.models import MAPPERS, systems

M = MAPPERS


def sid(kind: int, n: int) -> uuid.UUID:
    """A fixed, UUIDv4-shaped ID for seed row ``n`` of kind ``kind`` (D29: v4 everywhere)."""
    return uuid.UUID(f"5eed{kind:04x}-0000-4000-8000-{n:012x}")


# Kinds of fixed ID.
ORG, SITE, ROOM, FACILITY, PRACTITIONER, ROLE, SCHEDULE, RULE, VISIT, PAYER, PRACTICE_PAYER, \
    TEMPLATE, SECTION, COUNTER, USER, NAME, IDENT, ROLE_LOCATION, ACTOR, ADDRESS = range(1, 21)

#: The MRN system of the starter practice (D41): the placeholder domain until onboarding's real
#: one is decided (Q3), in #96's shape. It freezes at the first MRN, so a database seeded with it
#: keeps it.
MRN_SYSTEM = "https://company-domain.invalid/sid/mrn/RFM"
#: The environments the seed may run in; anything else, unset included, is refused.
ALLOWED_ENVIRONMENTS = frozenset({"development", "test"})
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri")
EFFECTIVE_FROM = date(2026, 10, 1)


@dataclass(frozen=True)
class Practice:
    tenant_id: uuid.UUID
    slug: str
    name: str
    timezone: str
    mrn_prefix: str
    mrn_system: str
    #: (fixed facility ID or None, code, name, IANA time zone, (street, city, state, ZIP))
    facilities: tuple[tuple[uuid.UUID | None, str, str, str, tuple[str, str, str, str]], ...]


PRACTICES = (
    Practice(CLINIC_A, "riverbend", "Riverbend Family Medicine (synthetic)", "America/Chicago",
             "RFM", MRN_SYSTEM,
             ((FACILITY_A, "MAIN", "Riverbend main office (synthetic)", "America/Chicago",
               ("100 Sample Avenue", "Springfield", "IL", "62704")),
              (None, "NORTH", "Riverbend north office (synthetic)", "America/New_York",
               ("200 Sample Avenue", "Columbus", "OH", "43004")))),
    Practice(CLINIC_B, "northgate", "Northgate Clinic (synthetic)", "America/Denver",
             "NGC", "https://company-domain.invalid/sid/mrn/NGC",
             ((FACILITY_B, "MAIN", "Northgate office (synthetic)", "America/Denver",
               ("300 Sample Avenue", "Denver", "CO", "80202")),)),
)

#: (dev user who is this provider, family, given, prefix, suffix, NPI not in NPPES). Names with
#: digits, Synthea style, so they can never match a real clinician.
PROVIDERS = (
    ("md", "Lindqvist58", "Avery401", "Dr.", "MD", "1999999901"),
    ("app", "Okonkwo73", "Jordan552", None, "NP", "1999999919"),
)

#: (code, name, minutes, new patient, telehealth, note template code)
VISIT_TYPES = (
    ("NEW", "New patient visit", 40, True, False, "NEW-VISIT"),
    ("FU", "Follow-up visit", 20, False, False, "FOLLOW-UP"),
    ("ANNUAL", "Annual physical", 40, False, False, "ANNUAL"),
    ("TELE-FU", "Telehealth follow-up", 20, False, True, "FOLLOW-UP"),
)

_NEW_VISIT_SECTIONS = (
    ("10154-3", "Chief complaint", True), ("10164-2", "History of present illness", True),
    ("11348-0", "Past medical history", False), ("10157-6", "Family history", False),
    ("29762-2", "Social history", False), ("10187-3", "Review of systems", False),
    ("29545-1", "Physical exam", True), ("51847-2", "Assessment and plan", True),
    ("69730-0", "Patient instructions", False),
)
#: (code, name, note type LOINC, sections as (section LOINC, title, required))
NOTE_TEMPLATES: tuple[tuple[str, str, str, tuple[tuple[str, str, bool], ...]], ...] = (
    ("NEW-VISIT", "New patient visit", "34117-2", _NEW_VISIT_SECTIONS),
    ("FOLLOW-UP", "Follow-up visit", "11506-3", (
        ("10154-3", "Chief complaint", True), ("10164-2", "Interval history", True),
        ("29545-1", "Physical exam", True), ("51847-2", "Assessment and plan", True),
        ("69730-0", "Patient instructions", False))),
    ("ANNUAL", "Annual physical", "34117-2", _NEW_VISIT_SECTIONS + (
        ("11369-6", "Preventive care: immunizations", False),)),
)

PAYER_ID = sid(PAYER, 1)


def _set_clinic(db: Session, tenant_id: uuid.UUID | None) -> None:
    """The clinic for row-level security, and for the hook that fills child rows' tenant_id."""
    db.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
               {"t": str(tenant_id) if tenant_id else ""})
    if tenant_id is None:
        db.info.pop("tenant_id", None)
    else:
        db.info["tenant_id"] = tenant_id


def _ensure(db: Session, model: str, row_id: uuid.UUID, **values: Any) -> Any:
    """Inserts the row unless one with this ID exists; returns the row either way."""
    cls = M[model]
    row = db.get(cls, row_id)
    if row is None:
        row = cls(id=row_id, **values)
        db.add(row)
        db.flush()
    return row


def _practice(db: Session, p: Practice, number: int) -> dict[str, Any]:
    _set_clinic(db, p.tenant_id)
    _ensure(db, "tenant", p.tenant_id, slug=p.slug, name=p.name, timezone=p.timezone)
    org = _ensure(db, "organization", sid(ORG, number), tenant_id=p.tenant_id, name=p.name,
                  type_system=systems.ORGANIZATION_TYPE, type_code="prov")
    # As onboarding creates it, so registration never meets a practice without one (#74).
    _ensure(db, "mrn_counter", sid(COUNTER, number), tenant_id=p.tenant_id,
            prefix=p.mrn_prefix, system=p.mrn_system)
    sites = []
    for i, (fixed, code, name, tz, (street, city, state, zip_code)) in enumerate(
            p.facilities, start=1):
        n = number * 10 + i
        site = _ensure(db, "location", sid(SITE, n), tenant_id=p.tenant_id, name=name,
                       physical_type_system=systems.LOCATION_PHYSICAL_TYPE,
                       physical_type_code="si", managing_organization_id=org.id,
                       address=[M["address"](id=sid(ADDRESS, n), line=[street], city=city,
                                            state=state, postal_code=zip_code, country="US",
                                            use="work")])
        _ensure(db, "location", sid(ROOM, n), tenant_id=p.tenant_id, name=f"{name}, exam 1",
                physical_type_system=systems.LOCATION_PHYSICAL_TYPE, physical_type_code="ro",
                part_of_location_id=site.id)
        fac = _ensure(db, "facility", fixed or sid(FACILITY, n), tenant_id=p.tenant_id,
                      location_id=site.id, code=code, name=name, timezone=tz)
        sites.append((site, fac))
    return {"org": org, "sites": sites}


def _dev_users(db: Session, providers: dict[str, uuid.UUID]) -> None:
    """An app_user per core dev user, with the same ID, so writes made with X-Dev-User have an
    author (Provenance, created_by)."""
    for name, user in DEV_USERS.items():
        _set_clinic(db, user.organization_id)
        _ensure(db, "app_user", user.id, tenant_id=user.organization_id,
                keycloak_subject=f"dev:{name}", username=f"dev.{name}",
                display_name=user.display_name, practitioner_id=providers.get(name))


def _providers(db: Session, practice: dict[str, Any]) -> dict[str, uuid.UUID]:
    out = {}
    for i, (user, family, given, prefix, suffix, npi) in enumerate(PROVIDERS, start=1):
        pr = db.get(M["practitioner"], sid(PRACTITIONER, i))
        if pr is None:
            pr = M["practitioner"](id=sid(PRACTITIONER, i), tenant_id=CLINIC_A)
            pr.identifier = [M["identifier"](id=sid(IDENT, i), system=systems.NPI, value=npi,
                                             use="official")]
            pr.name = [M["human_name"](id=sid(NAME, i), family=family, given=[given],
                                       prefix=[prefix] if prefix else [],
                                       suffix=[suffix] if suffix else [], use="official")]
            db.add(pr)
            db.flush()
        # One PractitionerRole per provider and facility, as practice setup maps it.
        for j, (site, _) in enumerate(practice["sites"], start=1):
            n = i * 10 + j
            if db.get(M["practitioner_role"], sid(ROLE, n)) is None:
                role = M["practitioner_role"](id=sid(ROLE, n), tenant_id=CLINIC_A,
                                              practitioner_id=pr.id,
                                              organization_id=practice["org"].id)
                role.location = [M["practitioner_role_location"](id=sid(ROLE_LOCATION, n),
                                                                 location_id=site.id)]
                db.add(role)
                db.flush()
        out[user] = pr.id
    return out


def _templates_and_visit_types(db: Session) -> dict[str, uuid.UUID]:
    templates = {}
    for i, (code, name, loinc, sections) in enumerate(NOTE_TEMPLATES, start=1):
        tpl = _ensure(db, "note_template", sid(TEMPLATE, i), tenant_id=CLINIC_A, code=code,
                      name=name, note_type_loinc=loinc)
        for seq, (section, title, required) in enumerate(sections, start=1):
            _ensure(db, "note_template_section", sid(SECTION, i * 100 + seq), tenant_id=CLINIC_A,
                    template_id=tpl.id, sequence=seq, section_code=section, title=title,
                    is_required=required)
        templates[code] = tpl.id
    visits = {}
    for i, (code, name, minutes, new, tele, template) in enumerate(VISIT_TYPES, start=1):
        visits[code] = _ensure(db, "appointment_type", sid(VISIT, i), tenant_id=CLINIC_A,
                               code=code, name=name, default_duration_minutes=minutes,
                               is_new_patient=new, is_telehealth=tele,
                               default_note_template_id=templates[template]).id
    return visits


def _schedules(db: Session, practice: dict[str, Any], visits: dict[str, uuid.UUID]) -> None:
    """One schedule per provider and facility, Monday to Friday, 9:00 to 17:00, every visit type,
    on a 20-minute grid that every visit length fits."""
    for i in range(1, len(PROVIDERS) + 1):
        for j, (site, fac) in enumerate(practice["sites"], start=1):
            n = i * 10 + j
            sch = db.get(M["schedule"], sid(SCHEDULE, n))
            if sch is None:
                sch = M["schedule"](id=sid(SCHEDULE, n), tenant_id=CLINIC_A, ext_facility_id=fac.id)
                sch.actor = [M["schedule_actor"](id=sid(ACTOR, n),
                                                 practitioner_role_id=sid(ROLE, n))]
                db.add(sch)
                db.flush()
            for d, day in enumerate(WEEKDAYS, start=1):
                rule = _ensure(db, "schedule_availability_rule", sid(RULE, n * 10 + d),
                               tenant_id=CLINIC_A, schedule_id=sch.id, day_of_week=day,
                               start_time=time(9), end_time=time(17), slot_minutes=20,
                               location_id=site.id, effective_from=EFFECTIVE_FROM)
                link = M["availability_rule_appointment_type"]
                have = set(db.execute(select(link.appointment_type_id)
                                      .where(link.rule_id == rule.id)).scalars())
                db.add_all(link(tenant_id=CLINIC_A, rule_id=rule.id, appointment_type_id=v)
                           for v in visits.values() if v not in have)
    db.flush()


def require_dev_environment() -> None:
    """Every way into the seed calls this first: core's ENVIRONMENT setting (unset is
    production) must be development or test."""
    environment = Settings().environment
    if environment not in ALLOWED_ENVIRONMENTS:
        raise RuntimeError(f"refusing to seed synthetic data with ENVIRONMENT={environment}")


def load_starter(db: Session) -> None:
    """Loads the starter layer in the session's transaction; the caller commits."""
    require_dev_environment()
    # The rule functions name tables without a schema, as the API role's search_path finds
    # them. shri_migrator has the same setting (sql/00_extensions.sql), but a role's settings
    # apply only at login, and the tests switch to it with SET ROLE. For this transaction only.
    db.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))
    _set_clinic(db, None)
    _ensure(db, "payer", PAYER_ID, name="Test Health Plan (synthetic)", payer_type="commercial")
    practice_a = _practice(db, PRACTICES[0], 1)
    _practice(db, PRACTICES[1], 2)
    _set_clinic(db, CLINIC_A)
    _ensure(db, "practice_payer", sid(PRACTICE_PAYER, 1), tenant_id=CLINIC_A, payer_id=PAYER_ID)
    providers = _providers(db, practice_a)
    visits = _templates_and_visit_types(db)
    _schedules(db, practice_a, visits)
    _dev_users(db, providers)
