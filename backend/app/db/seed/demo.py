"""The demo layer (issue #85; demo 20 Nov): the starter layer plus a pharmacy, more payers, the
consent requirements, and synthetic patients with their coverage, preferred pharmacy and
appointments on the demo day. The same rules as the starter layer: synthetic only, fixed IDs,
inserted only if missing, so a second run changes nothing; it runs as shri_migrator with the
clinic set, so forced RLS checks every row.

Each patient's MRN comes from ``admin.next_mrn()`` when the patient is first created, as
registration takes it.

The demo users are the accounts of Thulasi's realms (#152, IDs posted on #85), with fixed
Keycloak user IDs: four staff users (an ``app_user`` each, ``keycloak_subject`` = the Keycloak
user ID, and a ``user_role`` row at the main office for its role, against migration 0017's
platform roles) and the demo patient's active portal account (``keycloak_user_id``), linked to
the patient with the demo visit. No password is stored or seeded: they live in Keycloak.

Every demo provider is also bookable all day, every day (``_all_day_schedules``): each run sets
their all-day rules to start on each facility's own today and run for the next 7 days, so a
rehearsal or the demo itself always has free times. The seed's environment guard is unchanged.
"""
from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.deps import CLINIC_A, FACILITY_A
from app.db.models import MAPPERS, systems
from app.db.seed import starter
from app.db.seed.starter import PAYER, PRACTICE_PAYER, SCHEDULE, SITE, VISIT, _ensure, sid

M = MAPPERS

# Kinds of fixed ID, after the starter layer's.
PHARMACY, CONSENT_REQUIREMENT, PATIENT, P_NAME, P_TELECOM, P_ADDRESS, P_MRN, P_LANGUAGE, \
    COVERAGE, C_PAYOR, C_MEMBER, C_GROUP, APPOINTMENT, A_PATIENT, A_PROVIDER, \
    P_PHARMACY, A_LOCATION, DEMO_USER, DEMO_USER_ROLE, PORTAL_ACCOUNT, ALL_DAY_RULE = range(21, 42)

#: The demo day, Friday 20 November 2026, at the main office (America/Chicago, UTC-6 then).
DEMO_DAY = dt.date(2026, 11, 20)
CHICAGO = dt.timezone(dt.timedelta(hours=-6))
#: The pharmacy the prescription goes to (Thulasi's simulated pharmacy answers for it).
PHARMACY_ID = sid(PHARMACY, 1)

#: (n, name, payer type). Payer 1 is the starter layer's.
PAYERS = ((2, "Example Medicare Advantage Plan (synthetic)", "medicare-advantage"),
          (3, "Example State Medicaid (synthetic)", "medicaid"))

#: (kind, title, required). Policy version 2026-10, effective 1 Oct 2026.
CONSENTS = (
    ("treatment", "Consent to treatment", True),
    ("privacy-notice", "Notice of privacy practices", True),
    ("financial", "Financial responsibility and assignment of benefits", True),
    ("telehealth", "Telehealth consent", False),
    ("ambient-recording", "Recording of the visit for note drafting", False),
)


@dataclass(frozen=True)
class DemoPatient:
    n: int
    given: str
    family: str
    birth_date: dt.date
    gender: str
    phone: str                          # E.164, in the fictional 555-01xx range
    street: str
    payer: int | None                   # PAYER n, or self-pay
    #: (time at the main office, visit type, provider index), or None for no appointment
    visit: tuple[dt.time, str, int] | None


PATIENTS = (
    DemoPatient(1, "Kaia401", "Lindgren118", dt.date(1990, 3, 14), "female", "+12175550142",
                "42 Sample Avenue", 1, (dt.time(9, 0), "NEW", 3)),
    DemoPatient(2, "Marcus217", "Okafor904", dt.date(1958, 7, 2), "male", "+12175550117",
                "17 Sample Avenue", 2, (dt.time(9, 40), "FU", 3)),
    DemoPatient(3, "Elena88", "Vasquez512", dt.date(1976, 11, 23), "female", "+12175550163",
                "63 Sample Avenue", 3, (dt.time(10, 0), "FU", 2)),
    DemoPatient(4, "Theo343", "Brandt27", dt.date(2001, 1, 9), "male", "+12175550188",
                "88 Sample Avenue", None, (dt.time(10, 20), "ANNUAL", 3)),
    DemoPatient(5, "Priya765", "Raman431", dt.date(1983, 5, 30), "female", "+12175550129",
                "29 Sample Avenue", 1, None),
)


def _payers(db: Session) -> None:
    starter._set_clinic(db, None)
    _ensure(db, "pharmacy", PHARMACY_ID, ncpdp_id="9999991", name="Demo Pharmacy (synthetic)",
            phone="+12175550190", address_line="90 Sample Avenue", city="Springfield",
            state="IL", postal_code="62704", is_mail_order=False, is_active=True)
    for n, name, kind in PAYERS:
        _ensure(db, "payer", sid(PAYER, n), name=name, payer_type=kind)
    starter._set_clinic(db, CLINIC_A)
    for n, _, _ in PAYERS:
        _ensure(db, "practice_payer", sid(PRACTICE_PAYER, n), tenant_id=CLINIC_A,
                payer_id=sid(PAYER, n))


def _consent_requirements(db: Session) -> None:
    for i, (kind, title, required) in enumerate(CONSENTS, start=1):
        _ensure(db, "consent_requirement", sid(CONSENT_REQUIREMENT, i), tenant_id=CLINIC_A,
                kind=kind, title=title, policy_version="2026-10", is_required=required,
                effective_date=dt.date(2026, 10, 1))


def _patient(db: Session, p: DemoPatient) -> Any:
    row = db.get(M["patient"], sid(PATIENT, p.n))
    if row is not None:
        return row
    mrn = db.execute(text("SELECT system, value FROM admin.next_mrn()")).one()
    pt = M["patient"](id=sid(PATIENT, p.n), tenant_id=CLINIC_A, gender=p.gender,
                      birth_date=p.birth_date, ext_birthsex="F" if p.gender == "female" else "M")
    pt.identifier = [M["identifier"](id=sid(P_MRN, p.n), system=mrn.system, value=mrn.value,
                                     type_system=systems.V2_0203, type_code="MR", use="usual")]
    pt.name = [M["human_name"](id=sid(P_NAME, p.n), family=p.family, given=[p.given],
                               use="official")]
    pt.telecom = [M["contact_point"](id=sid(P_TELECOM, p.n), system="phone", value=p.phone,
                                     use="mobile", rank=1)]
    pt.address = [M["address"](id=sid(P_ADDRESS, p.n), line=[p.street], city="Springfield",
                               state="IL", postal_code="62704", country="US", use="home")]
    pt.communication = [M["patient_communication"](id=sid(P_LANGUAGE, p.n),
                                                   language_system=systems.LANGUAGE,
                                                   language_code="en-US", preferred=True)]
    db.add(pt)
    db.flush()
    return pt


def _coverage(db: Session, p: DemoPatient) -> None:
    if p.payer is None or db.get(M["coverage"], sid(COVERAGE, p.n)) is not None:
        return
    cov = M["coverage"](id=sid(COVERAGE, p.n), tenant_id=CLINIC_A, status="active",
                        beneficiary_patient_id=sid(PATIENT, p.n),
                        subscriber_patient_id=sid(PATIENT, p.n), relationship_code="self",
                        order=1, period_start=dt.date(2026, 1, 1))
    db.add(cov)
    db.flush()
    db.add_all([
        M["coverage_payor"](id=sid(C_PAYOR, p.n), coverage_id=cov.id,
                            payer_id=sid(PAYER, p.payer)),
        M["identifier"](id=sid(C_MEMBER, p.n), coverage_id=cov.id, type_system=systems.V2_0203,
                        type_code="MB", value=f"TEST-MEMBER-{p.n:03d}"),
        M["coverage_class"](id=sid(C_GROUP, p.n), coverage_id=cov.id, type="group",
                            value=f"TEST-GRP-{p.payer}", name="Demo employer group")])
    db.flush()


#: (n, username, Keycloak user ID, display name, role, provider index or None). The IDs and
#: names are #152's (infra/keycloak/reset-demo-users.sh): Keycloak's names are the source of
#: truth, so a person has one name on every screen and in sign-in (D112).
DEMO_USERS = (
    (1, "demo.frontdesk", "bfb3e893-5380-4260-b1b9-420ee3a9e6e4", "Marlo512 Ferreira77", "FD", None),
    (2, "demo.ma", "8474b553-c2bb-4a7b-a098-cc4bfdf5f4ac", "Tobias289 Lindqvist45", "MA", None),
    (3, "demo.doctor", "490ef6d1-2e36-40ed-88eb-132538695ad9", "Rowan318 Halvorsen64", "MD", 3),
    (4, "demo.admin", "9a805285-df36-4ce9-abcc-3844ab784dfa", "Sasha627 Brennan52", "ADM", None),
)
#: The patient realm's demo account, and the demo patient whose chart it opens (the visit).
DEMO_PATIENT_SUBJECT = "8e477695-3ea5-4082-8765-2b8edee9123c"
DEMO_PORTAL_PATIENT = 1


def _demo_users(db: Session) -> None:
    starter._set_clinic(db, CLINIC_A)
    roles = {r.code: r.id for r in db.execute(text(
        "SELECT code, id FROM admin.role WHERE tenant_id IS NULL AND is_system"))}
    for n, username, subject, name, role, provider in DEMO_USERS:
        practitioner = starter.sid(starter.PRACTITIONER, provider) if provider else None
        _ensure(db, "app_user", sid(DEMO_USER, n), tenant_id=CLINIC_A, keycloak_subject=subject,
                username=username, display_name=name, practitioner_id=practitioner)
        _ensure(db, "user_role", sid(DEMO_USER_ROLE, n), tenant_id=CLINIC_A,
                user_id=sid(DEMO_USER, n), role_id=roles[role], facility_id=FACILITY_A)
    _ensure(db, "portal_account", sid(PORTAL_ACCOUNT, 1), tenant_id=CLINIC_A,
            keycloak_user_id=DEMO_PATIENT_SUBJECT,
            patient_id=sid(PATIENT, DEMO_PORTAL_PATIENT), status="active",
            enrolled_at=dt.datetime(2026, 10, 29, tzinfo=dt.UTC))


def _appointment(db: Session, p: DemoPatient, visits: dict[str, uuid.UUID]) -> None:
    if p.visit is None or db.get(M["appointment"], sid(APPOINTMENT, p.n)) is not None:
        return
    at, code, provider = p.visit
    minutes = next(m for c, _, m, _, _, _ in starter.VISIT_TYPES if c == code)
    start = dt.datetime.combine(DEMO_DAY, at, CHICAGO).astimezone(dt.UTC)
    n = provider * 10 + 1                               # the provider's main-office schedule
    appt = M["appointment"](
        id=sid(APPOINTMENT, p.n), tenant_id=CLINIC_A, status="booked",
        subject_patient_id=sid(PATIENT, p.n), start=start,
        end=start + dt.timedelta(minutes=minutes), minutes_duration=minutes,
        created=dt.datetime(2026, 10, 27, tzinfo=dt.UTC), ext_appointment_type_id=visits[code],
        ext_schedule_id=sid(SCHEDULE, n), ext_facility_id=FACILITY_A)
    appt.participant = [
        M["appointment_participant"](id=sid(A_PATIENT, p.n), actor_patient_id=sid(PATIENT, p.n),
                                     required="required", status="accepted"),
        # One actor per participant (FHIR's choice): the provider, then the room's site.
        M["appointment_participant"](id=sid(A_PROVIDER, p.n),
                                     actor_practitioner_id=starter.sid(starter.PRACTITIONER,
                                                                       provider),
                                     required="required", status="accepted"),
        M["appointment_participant"](id=sid(A_LOCATION, p.n), actor_location_id=sid(SITE, 11),
                                     required="required", status="accepted")]
    db.add(appt)
    db.flush()


#: Every demo provider is bookable all day, every day, in each facility's own time zone (Vimal,
#: 2 Nov): one rule per weekday, 00:00 to 23:59 local, on top of the starter's office hours (free
#: times are keyed by start and provider, so the two never double up). The rules hold from the
#: facility's today for the next 7 days. Every seed run and reset moves them to that run's
#: today, so a demo or rehearsal on any day has free times; the same day again changes nothing.
ALL_DAY = (dt.time(0, 0), dt.time(23, 59))
ALL_DAY_SLOT_MINUTES = 20
ALL_DAY_AHEAD = 7
DAYS_OF_WEEK = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _all_day_schedules(db: Session, visits: dict[str, uuid.UUID], now: dt.datetime) -> None:
    starter._set_clinic(db, CLINIC_A)
    link = M["availability_rule_appointment_type"]
    for i in range(1, len(starter.PROVIDERS) + 1):
        for j in range(1, 3):                   # each provider's schedule at each facility
            n = i * 10 + j
            schedule = db.get_one(M["schedule"], sid(SCHEDULE, n))  # the starter layer's
            facility = db.get_one(M["facility"], schedule.ext_facility_id)
            today = now.astimezone(ZoneInfo(facility.timezone)).date()
            values = {"tenant_id": CLINIC_A, "schedule_id": schedule.id,
                      "start_time": ALL_DAY[0], "end_time": ALL_DAY[1],
                      "slot_minutes": ALL_DAY_SLOT_MINUTES, "location_id": facility.location_id,
                      "effective_from": today,
                      "effective_to": today + dt.timedelta(days=ALL_DAY_AHEAD)}
            for d, day in enumerate(DAYS_OF_WEEK, start=1):
                rule = db.get(M["schedule_availability_rule"], sid(ALL_DAY_RULE, n * 10 + d))
                if rule is None:
                    rule = M["schedule_availability_rule"](
                        id=sid(ALL_DAY_RULE, n * 10 + d), day_of_week=day, **values)
                    db.add(rule)
                else:                           # only what differs, so a same-day rerun is a no-op
                    for name, value in values.items():
                        if getattr(rule, name) != value:
                            setattr(rule, name, value)
                db.flush()
                have = set(db.execute(select(link.appointment_type_id)
                                      .where(link.rule_id == rule.id)).scalars())
                db.add_all(link(tenant_id=CLINIC_A, rule_id=rule.id, appointment_type_id=v)
                           for v in visits.values() if v not in have)
    db.flush()


def load_demo(db: Session, *, now: dt.datetime | None = None) -> None:
    """Loads the starter layer, then the demo layer, in the session's transaction. ``now`` (UTC,
    for tests) decides the all-day schedule's today; the real clock otherwise."""
    starter.load_starter(db)                    # checks the environment first
    _payers(db)
    _consent_requirements(db)
    visits = {code: sid(VISIT, i) for i, (code, *_) in enumerate(starter.VISIT_TYPES, start=1)}
    for p in PATIENTS:
        _patient(db, p)
        _coverage(db, p)
        _ensure(db, "patient_pharmacy", sid(P_PHARMACY, p.n), tenant_id=CLINIC_A,
                patient_id=sid(PATIENT, p.n), pharmacy_id=PHARMACY_ID, is_default=True)
        _appointment(db, p, visits)
    _demo_users(db)
    _all_day_schedules(db, visits, now or dt.datetime.now(dt.UTC))
    db.flush()
