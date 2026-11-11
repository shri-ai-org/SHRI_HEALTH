"""The demo patients' clinical history (Vimal's order, 11 Nov): what the doctor's screens read
before the visit (past visits with vitals and a signed note, problems, allergies, current
medications, family, social and surgical history). Patients 2 to 5 get it. Patient 1, the demo
visit's new patient, gets none: rooming and the doctor record it live.

Every record goes through ``app.db.fhir_store``, the same helpers the API uses, so provenance,
versions and history rows are as the screens expect. It runs after the demo layer, as
shri_migrator with the demo clinic and the demo doctor (demo.doctor) as the current user, in
one transaction. Fictional data only, the same every run. A patient whose first past visit (at
its fixed start time) already exists is skipped, so a second run changes nothing; a reset
starts from an empty database. New rows get the helpers' own IDs; no existing ID or name
changes. Notes are signed when the seed runs, so their signed time is the load time.

Codes are ICD-10-CM FY2026 and RxNorm 2 Nov 2026 (the pinned releases), but the helpers don't
look them up, so this runs before the code load.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.db import TENANT_ID_INFO_KEY
from app.core.deps import CLINIC_A, FACILITY_A
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.seed.demo import DEMO_USER, PATIENT
from app.db.seed.starter import PRACTITIONER, sid

ICD10 = "http://hl7.org/fhir/sid/icd-10-cm"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
SNOMED = "http://snomed.info/sct"
ROLE_CODE = "http://terminology.hl7.org/CodeSystem/v3-RoleCode"
PROGRESS_NOTE = fs.Coded(system=systems.LOINC, code="11506-3", display="Progress note")
TOBACCO = fs.Coded(system=systems.LOINC, code="72166-2", display="Tobacco smoking status")
NEVER_SMOKED = fs.Coded(system=SNOMED, code="266919005", display="Never smoked tobacco")
#: The demo doctor (demo.doctor, provider 3): every past visit is theirs, and they sign its note.
DOCTOR_USER = sid(DEMO_USER, 3)
DOCTOR = sid(PRACTITIONER, 3)


def icd(code: str, display: str) -> fs.Coded:
    return fs.Coded(system=ICD10, code=code, display=display)


def rx(code: str, display: str) -> fs.Coded:
    return fs.Coded(system=RXNORM, code=code, display=display)


@dataclass(frozen=True)
class PastVisit:
    start: dt.datetime                        # UTC
    reason: str
    assessment: str
    #: (systolic, diastolic) mm[Hg], heart rate /min, weight [lb_av], temperature [degF]
    bp: tuple[int, int]
    heart_rate: int
    weight_lb: Decimal
    temperature_f: Decimal = Decimal("98.4")


@dataclass(frozen=True)
class History:
    visits: tuple[PastVisit, ...]
    problems: tuple[tuple[fs.Coded, str], ...]          # (code, onset as YYYY or YYYY-MM)
    allergies: tuple[tuple[fs.Coded, str, str], ...] = ()  # (code, type, reaction text)
    medications: tuple[tuple[fs.Coded, str], ...] = ()  # (product, sig)
    family: tuple[tuple[str, str, fs.Coded, int, bool], ...] = ()
    smoking: fs.Coded = NEVER_SMOKED
    surgeries: tuple[tuple[fs.Coded, str], ...] = ()   # (procedure, performed)
    height_in: Decimal = field(default=Decimal("68"))


def _at(day: dt.date) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(15, 0), tzinfo=dt.UTC)  # 09:00 or 10:00 Chicago


HISTORY: dict[int, History] = {
    2: History(  # Marcus217 Okafor904, 68
        visits=(
            PastVisit(_at(dt.date(2026, 5, 12)), "Blood pressure and diabetes follow-up",
                      "Hypertension above goal; lisinopril continued, home readings asked for. "
                      "Diabetes stable on metformin.", (142, 88), 76, Decimal("205")),
            PastVisit(_at(dt.date(2026, 8, 18)), "Three-month follow-up",
                      "Blood pressure improved. Lipids at goal on atorvastatin. Revisit in "
                      "three months.", (134, 84), 72, Decimal("201")),
        ),
        problems=((icd("I10", "Essential (primary) hypertension"), "2015"),
                  (icd("E11.9", "Type 2 diabetes mellitus without complications"), "2018"),
                  (icd("E78.5", "Hyperlipidemia, unspecified"), "2016")),
        allergies=((rx("7980", "penicillin G"), "allergy", "Hives"),),
        medications=((rx("314076", "lisinopril 10 MG Oral Tablet"), "1 tablet by mouth daily"),
                     (rx("861007", "metFORMIN HCl 500 MG Oral Tablet"),
                      "1 tablet by mouth twice daily with meals"),
                     (rx("617310", "atorvastatin calcium 20 MG Oral Tablet"),
                      "1 tablet by mouth at bedtime")),
        family=(("FTH", "father", icd("I21.9", "Acute myocardial infarction, unspecified"), 62,
                 True),
                ("MTH", "mother", icd("E11.9", "Type 2 diabetes mellitus without complications"),
                 55, False)),
        smoking=fs.Coded(system=SNOMED, code="8517006", display="Ex-smoker"),
        surgeries=((fs.Coded(system=SNOMED, code="80146002", display="Appendectomy"), "1985"),),
        height_in=Decimal("70"),
    ),
    3: History(  # Elena88 Vasquez512, 49
        visits=(
            PastVisit(_at(dt.date(2026, 7, 9)), "Asthma check and heartburn",
                      "Asthma well controlled with albuterol as needed. Reflux better on "
                      "omeprazole.", (118, 76), 80, Decimal("152")),
        ),
        problems=((icd("J45.909", "Unspecified asthma, uncomplicated"), "2008"),
                  (icd("K21.9", "Gastro-esophageal reflux disease without esophagitis"),
                   "2019")),
        allergies=((rx("10180", "sulfamethoxazole"), "allergy", "Rash"),),
        medications=((rx("801092", "albuterol 90 MCG/INHAL Metered Dose Inhaler, 60 ACTUAT, "
                                    "generic for Ventolin"),
                      "2 puffs by mouth every 4 to 6 hours as needed for wheezing"),
                     (rx("198051", "omeprazole 20 MG Delayed Release Oral Capsule"),
                      "1 capsule by mouth daily before breakfast")),
        family=(("MTH", "mother", icd("E11.9", "Type 2 diabetes mellitus without complications"),
                 50, False),),
        surgeries=((fs.Coded(system=SNOMED, code="38102005", display="Cholecystectomy"),
                    "2020-03"),),
        height_in=Decimal("64"),
    ),
    4: History(  # Theo343 Brandt27, 25: last year's annual visit
        visits=(
            PastVisit(_at(dt.date(2025, 11, 14)), "Annual physical",
                      "Healthy. Seasonal allergic rhinitis controlled with cetirizine.",
                      (122, 78), 64, Decimal("172")),
        ),
        problems=((icd("J30.2", "Other seasonal allergic rhinitis"), "2015"),),
        medications=((rx("1014678", "cetirizine HCl 10 MG Oral Tablet"),
                      "1 tablet by mouth daily as needed"),),
        height_in=Decimal("71"),
    ),
    5: History(  # Priya765 Raman431, 43
        visits=(
            PastVisit(_at(dt.date(2026, 9, 22)), "Migraine follow-up",
                      "Two to three migraines a month; sumatriptan helps. Headache diary "
                      "started.", (116, 74), 70, Decimal("138")),
        ),
        problems=((icd("G43.909", "Migraine, unspecified, not intractable, without status "
                                  "migrainosus"), "2012"),),
        allergies=((rx("5640", "ibuprofen"), "intolerance", "Stomach upset"),),
        medications=((rx("313161", "SUMAtriptan succinate 50 MG Oral Tablet"),
                      "1 tablet by mouth at migraine onset; may repeat once after 2 hours"),),
        family=(("MTH", "mother", icd("G43.909", "Migraine, unspecified, not intractable, "
                                                "without status migrainosus"), 20, False),),
        height_in=Decimal("63"),
    ),
}


async def _has_history(db: AsyncSession, patient_id: uuid.UUID, first: dt.datetime) -> bool:
    return bool((await db.execute(text(
        "SELECT EXISTS (SELECT 1 FROM clinical.encounter WHERE subject_patient_id = :p "
        "AND period_start = :at)"), {"p": patient_id, "at": first})).scalar_one())


async def _visit(store: fs.SqlFhirStore, db: AsyncSession, patient_id: uuid.UUID,
                 visit: PastVisit, height_in: Decimal) -> None:
    written = await store.create_encounter(db, fs.EncounterIn(
        patient_id=patient_id, facility_id=FACILITY_A, status="arrived", started_at=visit.start,
        participants=(fs.ParticipantIn(practitioner_id=DOCTOR),),
        reasons=(fs.Coded(text=visit.reason),)))
    encounter = written.id
    roomed = visit.start + dt.timedelta(minutes=10)
    await store.set_encounter_status(db, encounter, "in-progress", at=roomed)
    await store.record_vitals(db, patient_id, encounter, (
        fs.VitalIn(type="blood-pressure", systolic=fs.Measured(Decimal(visit.bp[0]), "mm[Hg]"),
                   diastolic=fs.Measured(Decimal(visit.bp[1]), "mm[Hg]")),
        fs.VitalIn(type="heart-rate", value=fs.Measured(Decimal(visit.heart_rate), "/min")),
        fs.VitalIn(type="body-weight", value=fs.Measured(visit.weight_lb, "[lb_av]")),
        fs.VitalIn(type="body-height", value=fs.Measured(height_in, "[in_i]")),
        fs.VitalIn(type="body-temperature", value=fs.Measured(visit.temperature_f, "[degF]")),
    ), effective_at=roomed)
    note = await store.create_note(db, fs.NoteIn(
        encounter_id=encounter, note_type=PROGRESS_NOTE, title="Progress note",
        sections=(fs.SectionIn(code="10154-3", title="Chief complaint", text=visit.reason),
                  fs.SectionIn(code="51847-2", title="Assessment and plan",
                               text=visit.assessment))))
    await store.sign_note(db, note.id, if_version=note.version)
    await store.set_encounter_status(db, encounter, "finished",
                                     at=visit.start + dt.timedelta(minutes=40))


async def _patient_history(store: fs.SqlFhirStore, db: AsyncSession, patient_id: uuid.UUID,
                           h: History) -> None:
    for visit in h.visits:
        await _visit(store, db, patient_id, visit, h.height_in)
    for code, onset in h.problems:
        await store.create_problem(db, fs.ProblemIn(patient_id=patient_id, code=code,
                                                    onset=onset))
    for code, kind, reaction in h.allergies:
        await store.create_allergy(db, fs.AllergyIn(
            patient_id=patient_id, code=code, type=kind, categories=("medication",),
            criticality="low",
            reactions=(fs.ReactionIn(manifestations=(fs.Coded(text=reaction),),
                                     severity="mild"),)))
    for product, sig in h.medications:
        await store.record_medication(db, fs.MedicationIn(patient_id=patient_id,
                                                          medication=product, dosage_text=sig))
    for role, relative, condition, age, died in h.family:
        await store.create_family_history(db, fs.FamilyHistoryIn(
            patient_id=patient_id, relationship=fs.Coded(system=ROLE_CODE, code=role,
                                                         display=relative),
            deceased=True if died else None,
            conditions=(fs.FamilyConditionIn(code=condition, onset_age=age,
                                             contributed_to_death=True if died else None),)))
    await store.record_social_history(db, fs.SocialHistoryIn(
        patient_id=patient_id, code=TOBACCO, value=h.smoking,
        effective=h.visits[0].start.date().isoformat()))
    for procedure, performed in h.surgeries:
        await store.create_surgical_history(db, fs.SurgicalHistoryIn(
            patient_id=patient_id, code=procedure, performed=performed))


async def load_history(engine: AsyncEngine) -> int:
    """Writes the history of every demo patient who doesn't have it yet; returns how many. The
    engine connects as shri_migrator, as the rest of the seed does."""
    store, written = fs.SqlFhirStore(), 0
    async with AsyncSession(engine, expire_on_commit=False) as db, db.begin():
        db.info[TENANT_ID_INFO_KEY] = CLINIC_A
        # As the starter layer: the rule functions name tables without a schema, and a role's
        # search_path applies only at login (the tests use SET ROLE). This transaction only.
        await db.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))
        await db.execute(text(
            "SELECT set_config('app.current_tenant_id', :t, true), "
            "set_config('app.current_user_id', :u, true), "
            "set_config('app.correlation_id', 'seed-history', true)"),
            {"t": str(CLINIC_A), "u": str(DOCTOR_USER)})
        for n, h in HISTORY.items():
            patient_id = sid(PATIENT, n)
            if await _has_history(db, patient_id, h.visits[0].start):
                continue
            await _patient_history(store, db, patient_id, h)
            written += 1
    return written


def run(engine: Engine) -> int:
    """`load_history` for the seed's synchronous callers, on the same database and login."""
    url = engine.url.set(drivername="postgresql+psycopg")
    async_engine = create_async_engine(url, poolclass=NullPool)

    async def go() -> int:
        try:
            return await load_history(async_engine)
        finally:
            await async_engine.dispose()

    return asyncio.run(go())
