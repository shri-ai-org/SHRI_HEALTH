"""The demo layer (issue #85; demo 20 Nov): the starter layer plus a pharmacy and the main
practice's connection to the simulated pharmacy, more payers, the consent requirements, and
synthetic patients with their coverage, preferred pharmacy and appointments on the demo day, plus
500 more synthetic patients without appointments (``population()``).
The same rules as the starter layer: synthetic only, fixed IDs, inserted only if missing, so a
second run changes nothing; it runs as shri_migrator with the clinic set, so forced RLS checks
every row.

Each patient's MRN comes from ``admin.next_mrn()`` when the patient is first created, as
registration takes it.

The demo users are the accounts of Thulasi's realms (#152, IDs posted on #85), with fixed
Keycloak user IDs: four staff users (an ``app_user`` each, ``keycloak_subject`` = the Keycloak
user ID, and a ``user_role`` row at the main office for its role, against migration 0017's
platform roles) and the demo patient's active portal account (``keycloak_user_id``), linked to
the patient with the demo visit. No password is stored or seeded: they live in Keycloak.

Every demo provider is also bookable all day, every day (``_all_day_schedules``): weekly
recurring rules with no end date, so a rehearsal, the demo or a revisit weeks ahead always has
free times. The seed's environment guard is unchanged.
"""
from __future__ import annotations

import datetime as dt
import random
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

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
    P_PHARMACY, A_LOCATION, DEMO_USER, DEMO_USER_ROLE, PORTAL_ACCOUNT, ALL_DAY_RULE, \
    ERX_ENDPOINT = range(21, 43)
P_EMAIL, P_RACE, P_ETHNICITY, P_EMPLOYER, P_PCP, C_PLAN, C_COPAY, BOOKING_SETTING, \
    BOOKABLE_TYPE = range(43, 52)
#: The history's past visits (app.db.seed.history), n = patient n * 10 + the visit's number.
PAST_APPOINTMENT, PA_PATIENT, PA_PROVIDER, PA_LOCATION, PA_STEP, PA_ROOM, PA_FOLLOW_UP, \
    PA_REASON, A_REASON = range(52, 61)

#: The demo day, Friday 20 November 2026, at the main office (America/Chicago, UTC-6 then).
DEMO_DAY = dt.date(2026, 11, 20)
CHICAGO = dt.timezone(dt.timedelta(hours=-6))
#: The pharmacy the prescription goes to (Thulasi's simulated pharmacy answers for it).
PHARMACY_ID = sid(PHARMACY, 1)

#: (n, name, payer type). Payer 1 is the starter layer's.
PAYERS = ((2, "Example Medicare Advantage Plan (synthetic)", "medicare-advantage"),
          (3, "Example State Medicaid (synthetic)", "medicaid"))
#: Each payer's plan on the card, and its office-visit copay in USD (D40): the plan copay
#: (Coverage.costToBeneficiary). The front desk's copay on screen is the eligibility answer's.
PLANS = {1: ("Test Health Plan PPO Gold (synthetic)", Decimal("30.00")),
         2: ("Example Medicare Advantage HMO (synthetic)", Decimal("20.00")),
         3: ("Example Medicaid Managed Care (synthetic)", Decimal("4.00"))}

#: (kind, title, required). Policy version 2026-10, effective 1 Oct 2026.
CONSENTS = (
    ("treatment", "Consent to treatment", True),
    ("privacy-notice", "Notice of privacy practices", True),
    ("financial", "Financial responsibility and assignment of benefits", True),
    ("telehealth", "Telehealth consent", False),
    ("ambient-recording", "Recording of the visit for note drafting", False),
)


@dataclass(frozen=True)
class EmergencyContact:
    given: str
    family: str
    relationship: str                   # v3 RoleCode of the family relationship (WIFE, DAU, ...)
    relationship_display: str
    phone: str
    gender: str
    birth_date: dt.date
    street: str | None = None           # None: lives with the patient

    @property
    def email(self) -> str:
        return f"{self.given}.{self.family}@example.com".lower()


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
    # The registration fields the demo screens show (Vimal's order, 11 Nov). Empty for the
    # demo visit's new patient and the 500, whom the front desk completes live.
    email: str | None = None
    marital_status: str | None = None   # v3 MaritalStatus
    race: tuple[str, str] | None = None         # (OMB category code, text)
    ethnicity: tuple[str, str] | None = None    # (OMB category code, text)
    occupation: str | None = None
    industry: str | None = None
    employer: str | None = None
    pcp: int | None = None              # the primary care provider's index
    emergency: EmergencyContact | None = None
    history: bool = False               # past visits and history (app.db.seed.history)
    restricted: bool = False            # a restricted chart (D37), with its Provenance


WHITE, BLACK, ASIAN = ("2106-3", "White"), ("2054-5", "Black or African American"), \
    ("2028-9", "Asian")
HISPANIC, NOT_HISPANIC = ("2135-2", "Hispanic or Latino"), ("2186-5", "Not Hispanic or Latino")


def _shown(n: int, given: str, family: str, born: dt.date, gender: str, payer: int,
           visit: tuple[dt.time, str, int] | None, marital: str, race: tuple[str, str],
           ethnicity: tuple[str, str], occupation: str, industry: str, employer: str,
           emergency: EmergencyContact, *, history: bool = False,
           restricted: bool = False) -> DemoPatient:
    return DemoPatient(
        n, given, family, born, gender, f"+1217555{100 + n:04d}", f"{n}{n} Sample Avenue",
        payer, visit, f"{given}.{family}@example.com".lower(), marital, race, ethnicity,
        occupation, industry, employer, 3, emergency, history, restricted)


#: The demo patients (Vimal's direct messages, 11 Nov: realistic names; D112's amendment is
#: his). Patient 1 is the demo visit's new patient, named as Keycloak's demo.patient. Patients 2
#: to 7 have a year of history; 6 is restricted. Patients 8 to 12 have complete registration and
#: insurance and no clinical history, by design. Every person, address, phone and employer is
#: fictional; the birth dates give the ages Vimal asked for on the demo day.
PATIENTS = (
    DemoPatient(1, "Kaia401", "Lindgren118", dt.date(1990, 3, 14), "female", "+12175550142",
                "42 Sample Avenue", 1, (dt.time(9, 0), "NEW", 3)),
    _shown(2, "Robert", "Miller", dt.date(1958, 7, 2), "male", 2, (dt.time(9, 40), "FU", 3),
           "M", WHITE, NOT_HISPANIC, "Hardware store sales associate (part time)",
           "Retail trade", "Example Hardware Co. (synthetic)",
           EmergencyContact("Susan", "Miller", "WIFE", "wife", "+12175550152", "female",
                            dt.date(1960, 2, 19)), history=True),
    _shown(3, "Linda", "Thompson", dt.date(1969, 3, 18), "female", 1,
           (dt.time(10, 0), "FU", 2), "D", BLACK, NOT_HISPANIC, "Warehouse supervisor",
           "Transportation and warehousing", "Example Logistics Inc. (synthetic)",
           EmergencyContact("Karen", "Thompson", "SIS", "sister", "+12175550153", "female",
                            dt.date(1972, 8, 4), "53 Example Court"),
           history=True),
    _shown(4, "James", "Wilson", dt.date(1981, 8, 9), "male", 1,
           (dt.time(10, 20), "ANNUAL", 3), "M", WHITE, NOT_HISPANIC, "High school teacher",
           "Educational services", "Example Unified School District (synthetic)",
           EmergencyContact("Megan", "Wilson", "WIFE", "wife", "+12175550154", "female",
                            dt.date(1983, 1, 27)), history=True),
    _shown(5, "Patricia", "Davis", dt.date(1965, 2, 11), "female", 1, None, "W", WHITE,
           NOT_HISPANIC, "Accountant", "Finance and insurance",
           "Example Accounting Partners (synthetic)",
           EmergencyContact("Emily", "Davis", "DAU", "daughter", "+12175550155", "female",
                            dt.date(1991, 5, 6), "55 Example Court"), history=True),
    _shown(6, "David", "Nguyen", dt.date(1987, 5, 27), "male", 3, None, "S", ASIAN,
           NOT_HISPANIC, "Software developer", "Information",
           "Example Software Studio (synthetic)",
           EmergencyContact("Linh", "Nguyen", "MTH", "mother", "+12175550156", "female",
                            dt.date(1962, 11, 12), "56 Example Court"), history=True,
           restricted=True),
    _shown(7, "Maria", "Gonzalez", dt.date(1954, 10, 3), "female", 2, None, "W", WHITE,
           HISPANIC, "Library aide (part time, retired teacher)", "Information",
           "Example Community Library (synthetic)",
           EmergencyContact("Carlos", "Gonzalez", "SON", "son", "+12175550157", "male",
                            dt.date(1979, 7, 15), "57 Example Court"), history=True),
    _shown(8, "Emily", "Carter", dt.date(1992, 6, 14), "female", 1, None, "M", WHITE,
           NOT_HISPANIC, "Registered nurse", "Health care and social assistance",
           "Example Regional Hospital (synthetic)",
           EmergencyContact("Ryan", "Carter", "HUSB", "husband", "+12175550158", "male",
                            dt.date(1990, 10, 2))),
    _shown(9, "Daniel", "Brooks", dt.date(1974, 1, 22), "male", 1, None, "M", BLACK,
           NOT_HISPANIC, "Electrician", "Construction", "Example Electric LLC (synthetic)",
           EmergencyContact("Angela", "Brooks", "WIFE", "wife", "+12175550159", "female",
                            dt.date(1976, 4, 23))),
    _shown(10, "Sofia", "Ramirez", dt.date(1985, 9, 30), "female", 3, None, "S", WHITE,
           HISPANIC, "Restaurant manager", "Accommodation and food services",
           "Example Family Restaurant (synthetic)",
           EmergencyContact("Rosa", "Ramirez", "MTH", "mother", "+12175550160", "female",
                            dt.date(1961, 3, 8), "60 Example Court")),
    _shown(11, "Michael", "Chen", dt.date(1963, 4, 5), "male", 1, None, "M", ASIAN,
           NOT_HISPANIC, "Civil engineer", "Professional, scientific and technical services",
           "Example Engineering Group (synthetic)",
           EmergencyContact("Grace", "Chen", "WIFE", "wife", "+12175550161", "female",
                            dt.date(1965, 9, 14))),
    _shown(12, "Aisha", "Johnson", dt.date(1997, 3, 19), "female", 3, None, "S", BLACK,
           NOT_HISPANIC, "Graduate student", "Educational services",
           "Example State University (synthetic)",
           EmergencyContact("Denise", "Johnson", "MTH", "mother", "+12175550162", "female",
                            dt.date(1970, 12, 1), "62 Example Court")),
)
#: The reason for visit on the demo day's bookings of the history patients (the booking's note,
#: which rooming shows and the MA can change).
DEMO_DAY_REASONS = {2: "Diabetes and blood pressure follow-up",
                    3: "Back pain follow-up",
                    4: "Annual physical; asthma check"}
#: The patients the demo screens show (the completeness check's list): every patient above but
#: the demo visit's new patient, whom the front desk and rooming complete live.
SHOWN_PATIENTS = tuple(p for p in PATIENTS if p.emergency is not None)


#: The rest of the practice's synthetic patients (Vimal's order, 10 Nov): enough for a realistic
#: patient search and schedule, with no appointments, so the demo day above is unchanged. They
#: come from a fixed seed, so every run makes the same people with the same IDs (n 1001 to
#: 1500), and the names are obviously fictional, Synthea-style with digits (D112).
POPULATION_SIZE = 500
POPULATION_FIRST = 1001
_GIVEN = ("Avery", "Jordan", "Riley", "Morgan", "Casey", "Quinn", "Rowan", "Sage", "Emery",
          "Harper", "Reese", "Dakota", "Skyler", "Finley", "Hayden", "Kendall", "Marlowe",
          "Oakley", "Peyton", "Tatum")
_FAMILY = ("Abernathy", "Brightwater", "Castellan", "Dunmore", "Elsworth", "Fairbanks",
           "Greystone", "Halloway", "Ironwood", "Juniper", "Kingsley", "Lockridge", "Merriweather",
           "Northcott", "Oakhurst", "Pemberton", "Quillfeather", "Ravensworth", "Stonebridge",
           "Thistlewood")


def population() -> tuple[DemoPatient, ...]:
    """The 500 patients, the same on every run: a fixed seed, never the clock or chance."""
    rng = random.Random(20261120)  # noqa: S311 (the same people every run, not a secret)
    out = []
    for n in range(POPULATION_FIRST, POPULATION_FIRST + POPULATION_SIZE):
        gender = rng.choice(("female", "male"))
        born = dt.date(1940, 1, 1) + dt.timedelta(days=rng.randrange(80 * 365))
        out.append(DemoPatient(
            n, f"{rng.choice(_GIVEN)}{rng.randrange(100, 1000)}",
            f"{rng.choice(_FAMILY)}{rng.randrange(10, 1000)}", born, gender,
            f"+1217555{rng.randrange(100, 200):04d}",     # the fictional 555-01xx range
            f"{rng.randrange(1, 999)} Sample Avenue", rng.choice((1, 2, 3, None)), None))
    return tuple(out)


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
    # The connection a signed prescription is sent through (D97, D99): Thulasi's simulated
    # pharmacy, which answers only where SIMULATED_PARTNERS is on (never in production). No
    # secret: the simulated adapter needs none.
    _ensure(db, "integration_endpoint", sid(ERX_ENDPOINT, 1), tenant_id=CLINIC_A, kind="erx",
            adapter="simulated-erx", name="Simulated pharmacy (demo)", environment="test",
            baa_on_file=False, is_active=True)


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
    if p.email:
        pt.telecom.append(M["contact_point"](id=sid(P_EMAIL, p.n), system="email",
                                             value=p.email, use="home", rank=2))
    if p.marital_status:
        pt.marital_status_system, pt.marital_status_code = systems.MARITAL_STATUS, \
            p.marital_status
    pt.ext_race_text = p.race[1] if p.race else None
    pt.ext_ethnicity_text = p.ethnicity[1] if p.ethnicity else None
    pt.ext_occupation_text, pt.ext_industry_text = p.occupation, p.industry
    pt.address = [M["address"](id=sid(P_ADDRESS, p.n), line=[p.street], city="Springfield",
                               state="IL", postal_code="62704", country="US", use="home")]
    pt.communication = [M["patient_communication"](id=sid(P_LANGUAGE, p.n),
                                                   language_system=systems.LANGUAGE,
                                                   language_code="en-US", preferred=True)]
    db.add(pt)
    db.flush()
    for kind, value, n in (("race", p.race, P_RACE), ("ethnicity", p.ethnicity, P_ETHNICITY)):
        if value:
            db.add(M["patient_race_ethnicity"](id=sid(n, p.n), patient_id=pt.id, kind=kind,
                                               level="ombCategory", code=value[0]))
    if p.employer:
        db.add(M["employer"](id=sid(P_EMPLOYER, p.n), patient_id=pt.id, name=p.employer,
                             phone=f"+1217555{170 + p.n:04d}",
                             address_lines=[f"{p.n * 100} Example Business Park"],
                             address_city="Springfield", address_state="IL",
                             address_postal_code="62703", address_country="US"))
    if p.pcp:
        db.add(M["patient_general_practitioner"](
            id=sid(P_PCP, p.n), patient_id=pt.id,
            practitioner_id=starter.sid(starter.PRACTITIONER, p.pcp)))
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
    if p.emergency is not None:         # a shown patient: the card's plan, and its copay
        plan, copay = PLANS[p.payer]
        cov.subscriber_id = f"TEST-MEMBER-{p.n:03d}"   # the patient is the subscriber
        db.add_all([
            M["coverage_class"](id=sid(C_PLAN, p.n), coverage_id=cov.id, type="plan",
                                value=plan, name=plan),
            M["coverage_cost_to_beneficiary"](
                id=sid(C_COPAY, p.n), coverage_id=cov.id,
                type_system=systems.COVERAGE_COPAY_TYPE, type_code="gpvisit",
                type_display="GP Office Visit", value_money_value=copay,
                value_money_currency="USD")])
    db.flush()


#: (n, username, Keycloak user ID, display name, role, provider index or None). The IDs and
#: names are #152's (infra/keycloak/reset-demo-users.sh): Keycloak's names are the source of
#: truth, so a person has one name on every screen and in sign-in (D112).
DEMO_USERS = (
    (1, "demo.frontdesk", "bfb3e893-5380-4260-b1b9-420ee3a9e6e4", "Marlo512 Ferreira77", "FD",
     None),
    (2, "demo.ma", "8474b553-c2bb-4a7b-a098-cc4bfdf5f4ac", "Tobias289 Lindqvist45", "MA", None),
    (3, "demo.doctor", "490ef6d1-2e36-40ed-88eb-132538695ad9", "Rowan318 Halvorsen64", "MD", 3),
    (4, "demo.admin", "9a805285-df36-4ce9-abcc-3844ab784dfa", "Sasha627 Brennan52", "ADM", None),
)
#: The patient realm's demo account, and the demo patient whose chart it opens (the visit).
DEMO_PATIENT_SUBJECT = "8e477695-3ea5-4082-8765-2b8edee9123c"
DEMO_PORTAL_PATIENT = 1
#: Three more portal accounts, active with no invitation (Vimal, 11 Nov): (account n, patient n,
#: patient realm username, Keycloak user ID). The IDs are fixed and fictional, UUIDv5 of the
#: username under PORTAL_NAMESPACE, posted on #85 for the realm script.
PORTAL_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL,
                              "https://company-domain.invalid/shri-health/demo/portal")
PORTAL_USERS = ((2, 3, "linda.thompson", "0c68d15e-31b0-5304-a9cd-45249750cd9f"),
                (3, 4, "james.wilson", "feaa8ff7-9d2e-5daf-b8e3-f3cc17cf4884"),
                (4, 7, "maria.gonzalez", "34cc0a76-1f26-52fd-b018-999c7099a876"))


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
    for n, patient, _username, subject in PORTAL_USERS:
        _ensure(db, "portal_account", sid(PORTAL_ACCOUNT, n), tenant_id=CLINIC_A,
                keycloak_user_id=subject, patient_id=sid(PATIENT, patient), status="active",
                enrolled_at=dt.datetime(2026, 11, 11, tzinfo=dt.UTC))


#: Online booking (A50 (3)) for the portal's booking rehearsal: on, with at least 24 hours'
#: notice (Vimal, 11 Nov), and the follow-up visit bookable at the main office.
MIN_NOTICE_MINUTES = 24 * 60


def _online_booking(db: Session, visits: dict[str, uuid.UUID]) -> None:
    starter._set_clinic(db, CLINIC_A)
    _ensure(db, "online_booking_setting", sid(BOOKING_SETTING, 1), tenant_id=CLINIC_A,
            is_enabled=True, min_notice_minutes=MIN_NOTICE_MINUTES)
    _ensure(db, "online_bookable_type", sid(BOOKABLE_TYPE, 1), tenant_id=CLINIC_A,
            facility_id=FACILITY_A, appointment_type_id=visits["FU"])


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
    if p.n in DEMO_DAY_REASONS:
        appt.reason = [M["appointment_reason"](id=sid(A_REASON, p.n),
                                               reason_code_text=DEMO_DAY_REASONS[p.n])]
    db.add(appt)
    db.flush()


#: Every demo provider is bookable all day, every day, in each facility's own time zone (Vimal,
#: 2 Nov and 5 Nov): one weekly rule per weekday, 00:00 to 23:59 local (never 24:00, which the
#: database refuses, #204), on top of the starter's office hours (free times are keyed by start
#: and provider, so the two never double up). The rules start with the starter's and have no end
#: date, so any day, and a revisit weeks ahead, has free times. The same IDs as the earlier
#: 8-day window, so a database seeded before is moved to these rules, with nothing left over.
ALL_DAY = (dt.time(0, 0), dt.time(23, 59))
ALL_DAY_SLOT_MINUTES = 20
DAYS_OF_WEEK = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _all_day_schedules(db: Session, visits: dict[str, uuid.UUID]) -> None:
    starter._set_clinic(db, CLINIC_A)
    link = M["availability_rule_appointment_type"]
    for i in range(1, len(starter.PROVIDERS) + 1):
        for j in range(1, 3):                   # each provider's schedule at each facility
            n = i * 10 + j
            schedule = db.get_one(M["schedule"], sid(SCHEDULE, n))  # the starter layer's
            facility = db.get_one(M["facility"], schedule.ext_facility_id)
            values = {"tenant_id": CLINIC_A, "schedule_id": schedule.id,
                      "start_time": ALL_DAY[0], "end_time": ALL_DAY[1],
                      "slot_minutes": ALL_DAY_SLOT_MINUTES, "location_id": facility.location_id,
                      "effective_from": starter.EFFECTIVE_FROM, "effective_to": None}
            for d, day in enumerate(DAYS_OF_WEEK, start=1):
                rule = db.get(M["schedule_availability_rule"], sid(ALL_DAY_RULE, n * 10 + d))
                if rule is None:
                    rule = M["schedule_availability_rule"](
                        id=sid(ALL_DAY_RULE, n * 10 + d), day_of_week=day, **values)
                    db.add(rule)
                else:                           # only what differs, so a rerun is a no-op
                    for name, value in values.items():
                        if getattr(rule, name) != value:
                            setattr(rule, name, value)
                db.flush()
                have = set(db.execute(select(link.appointment_type_id)
                                      .where(link.rule_id == rule.id)).scalars())
                db.add_all(link(tenant_id=CLINIC_A, rule_id=rule.id, appointment_type_id=v)
                           for v in visits.values() if v not in have)
    db.flush()


def load_demo(db: Session) -> None:
    """Loads the starter layer, then the demo layer, in the session's transaction."""
    starter.load_starter(db)                    # checks the environment first
    _payers(db)
    _consent_requirements(db)
    visits = {code: sid(VISIT, i) for i, (code, *_) in enumerate(starter.VISIT_TYPES, start=1)}
    for p in PATIENTS + population():
        _patient(db, p)
        _coverage(db, p)
        _ensure(db, "patient_pharmacy", sid(P_PHARMACY, p.n), tenant_id=CLINIC_A,
                patient_id=sid(PATIENT, p.n), pharmacy_id=PHARMACY_ID, is_default=True)
        _appointment(db, p, visits)
    _demo_users(db)
    _online_booking(db, visits)
    _all_day_schedules(db, visits)
    db.flush()
