"""The demo patients' clinical history and emergency contacts (Vimal's orders, 11 Nov): what the
front desk and the doctor's screens read before the visit.

- Every shown patient (``demo.SHOWN_PATIENTS``) gets an emergency contact (a RelatedPerson).
- The six history patients get a year of care: three or four past visits, each with vitals,
  diagnoses and a signed SOAP note; problems with onset dates; allergies with their reactions;
  current medications with dose, route, frequency, start date and prescriber; and family, social
  and surgical history. Patient 1, the demo visit's new patient, gets none: rooming and the
  doctor record it live. Patients 8 to 12 have no clinical history, by design.
- Patient 6's chart is restricted at the end (D37), with the change's Provenance, as the
  demo admin.

The clinical content is synthetic and needs a clinician's review before it is shown as
realistic; it lives in the tables below so that review can change it in one place.

Every record goes through ``app.db.fhir_store``, the same helpers the API uses, so provenance,
versions and history rows are as the screens expect. It runs after the demo layer, as
shri_migrator with the demo clinic and the demo doctor (demo.doctor) as the current user, in
one transaction. Fictional data only, the same every run: a patient whose emergency contact, or
whose first past visit (at its fixed start time), already exists is skipped, so a second run
changes nothing; a reset starts from an empty database. New rows get the helpers' own IDs; no
existing ID changes. Notes are signed when the seed runs, so their signed time is the load time.

ICD-10-CM (FY2026) and RxNorm (2 Nov 2026) codes are the pinned releases' and were checked
against them; the helpers don't look them up, so this runs before the code load. SNOMED CT isn't
loaded (no UMLS licence yet, Q8), so the SNOMED codes here (reactions, procedures, body sites,
social history answers) are unverified.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.db import TENANT_ID_INFO_KEY
from app.core.deps import CLINIC_A, FACILITY_A
from app.db import fhir_store as fs
from app.db.models import MAPPERS as M
from app.db.models import systems
from app.db.seed.demo import (
    APPOINTMENT,
    DEMO_USER,
    PA_FOLLOW_UP,
    PA_LOCATION,
    PA_PATIENT,
    PA_PROVIDER,
    PA_REASON,
    PA_ROOM,
    PA_STEP,
    PAST_APPOINTMENT,
    PATIENT,
    SHOWN_PATIENTS,
    DemoPatient,
)
from app.db.seed.starter import PRACTITIONER, ROOM, SCHEDULE, SITE, TEMPLATE, VISIT, sid

ICD10 = "http://hl7.org/fhir/sid/icd-10-cm"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
SNOMED = "http://snomed.info/sct"
ROLE_CODE = "http://terminology.hl7.org/CodeSystem/v3-RoleCode"
#: The SOAP progress note template (the starter layer's fourth) and its note type.
SOAP_TEMPLATE = sid(TEMPLATE, 4)
PROGRESS_NOTE = fs.Coded(system=systems.LOINC, code="11506-3", display="Progress note",
                         text="SOAP progress note")
TOBACCO = fs.Coded(system=systems.LOINC, code="72166-2", display="Tobacco smoking status",
                   text="Tobacco use")
ALCOHOL = fs.Coded(system=systems.LOINC, code="11331-6", display="History of Alcohol use",
                   text="Alcohol use")
EMERGENCY_CONTACT = fs.Coded(system=ROLE_CODE, code="EMC", display="emergency contact",
                             text="Emergency contact")
#: The demo doctor (demo.doctor, provider 3): every past visit is theirs, and they sign its note.
DOCTOR_USER = sid(DEMO_USER, 3)
DOCTOR = sid(PRACTITIONER, 3)
FRONT_DESK_USER, MA_USER = sid(DEMO_USER, 1), sid(DEMO_USER, 2)
#: Where past visits happened: the main office, the demo doctor's schedule there, exam 1.
MAIN_OFFICE, DOCTOR_SCHEDULE, EXAM_ROOM = sid(SITE, 11), sid(SCHEDULE, 31), sid(ROOM, 11)
FOLLOW_UP_TYPE = sid(VISIT, 2)              # the starter's FU visit type
#: The demo admin (demo.admin), who restricts a chart.
ADMIN_USER = sid(DEMO_USER, 4)
#: The practice's prescribers, as the medication notes name them (the starter's providers).
DR_HALVORSEN = "Dr. Rowan318 Halvorsen64 (this practice)"
DR_LINDQVIST = "Dr. Avery401 Lindqvist58 (this practice)"
NP_OKONKWO = "Jordan552 Okonkwo73, NP (this practice)"
RESTRICT_REASON = "Restricted at the patient's request (synthetic demo chart)"


def icd(code: str, display: str) -> fs.Coded:
    return fs.Coded(system=ICD10, code=code, display=display, text=display)


def rx(code: str, display: str) -> fs.Coded:
    return fs.Coded(system=RXNORM, code=code, display=display, text=display)


def sct(code: str, display: str) -> fs.Coded:
    return fs.Coded(system=SNOMED, code=code, display=display, text=display)


def role(code: str, display: str) -> fs.Coded:
    return fs.Coded(system=ROLE_CODE, code=code, display=display, text=display)


# ------------------------------------------------------------------------- the codes, once each
I10 = icd("I10", "Essential (primary) hypertension")
E11_9 = icd("E11.9", "Type 2 diabetes mellitus without complications")
E78_5 = icd("E78.5", "Hyperlipidemia, unspecified")
Z87_891 = icd("Z87.891", "Personal history of nicotine dependence")
M54_50 = icd("M54.50", "Low back pain, unspecified")
G89_29 = icd("G89.29", "Other chronic pain")
J45_40 = icd("J45.40", "Moderate persistent asthma, uncomplicated")
J30_2 = icd("J30.2", "Other seasonal allergic rhinitis")
Z85_3 = icd("Z85.3", "Personal history of malignant neoplasm of breast")
Z92_3 = icd("Z92.3", "Personal history of irradiation")
Z79_811 = icd("Z79.811", "Long term (current) use of aromatase inhibitors")
G43_009 = icd("G43.009", "Migraine without aura, not intractable, without status "
                        "migrainosus")
J44_9 = icd("J44.9", "Chronic obstructive pulmonary disease, unspecified")
J44_1 = icd("J44.1", "Chronic obstructive pulmonary disease with (acute) exacerbation")
M17_0 = icd("M17.0", "Bilateral primary osteoarthritis of knee")
NEVER_SMOKED = sct("266919005", "Never smoked tobacco")
EX_SMOKER = sct("8517006", "Ex-smoker")
OCCASIONAL_DRINKER = sct("228276006", "Occasional drinker")
NON_DRINKER = sct("105542008", "Non-drinker")


@dataclass(frozen=True)
class PastVisit:
    day: dt.date
    reason: str                               # the chief complaint
    subjective: str
    objective: str
    assessment: str
    plan: str
    instructions: str
    diagnoses: tuple[fs.Coded, ...]
    #: (systolic, diastolic) mm[Hg], heart rate /min, weight [lb_av], temperature [degF]
    bp: tuple[int, int]
    heart_rate: int
    weight_lb: Decimal
    temperature_f: Decimal = Decimal("98.4")

    @property
    def start(self) -> dt.datetime:           # 09:00 Chicago in winter, 10:00 in summer
        return dt.datetime.combine(self.day, dt.time(15, 0), tzinfo=dt.UTC)


@dataclass(frozen=True)
class Problem:
    code: fs.Coded
    onset: str                                # PartialDate
    note: str


@dataclass(frozen=True)
class Allergy:
    code: fs.Coded                            # an RxNorm ingredient
    type: str                                 # allergy | intolerance
    criticality: str
    manifestation: fs.Coded
    severity: str
    description: str
    onset: dt.date
    note: str


@dataclass(frozen=True)
class Medication:
    product: fs.Coded                         # an RxNorm product
    sig: str                                  # dose, route and frequency
    started: dt.date
    prescriber: str
    why: str

    @property
    def note(self) -> str:
        return f"Started {self.started.isoformat()}. Prescriber: {self.prescriber}. {self.why}"


@dataclass(frozen=True)
class Relative:
    relationship: fs.Coded
    sex: str
    condition: fs.Coded
    onset_age: int
    deceased: bool
    note: str
    contributed_to_death: bool = False        # the condition, to this relative's death


@dataclass(frozen=True)
class Surgery:
    code: fs.Coded
    performed: str                            # PartialDate
    body_site: fs.Coded
    note: str


@dataclass(frozen=True)
class History:
    visits: tuple[PastVisit, ...]
    problems: tuple[Problem, ...]
    allergies: tuple[Allergy, ...]
    medications: tuple[Medication, ...]
    family: tuple[Relative, ...]
    smoking: fs.Coded
    alcohol: fs.Coded
    surgeries: tuple[Surgery, ...]
    height_in: Decimal
    #: Each visit asks for a revisit, booked as the next visit. After the last one it is the
    #: demo-day appointment, or, for a patient with none, declined: (months, the reason).
    last_follow_up: tuple[int, str] | None = None


# ------------------------------------------------------------------ the history, one per patient
HISTORY: dict[int, History] = {
    2: History(  # Robert Miller, 68: type 2 diabetes and hypertension, improving on treatment
        visits=(
            PastVisit(dt.date(2025, 12, 9), "Diabetes and blood pressure follow-up",
                      "Home blood pressure 140s/90s. Eating out more over the holidays. No chest "
                      "pain, no foot numbness. Taking metformin and lisinopril every day.",
                      "Alert, no distress. Heart regular, lungs clear. Feet: pulses present, "
                      "monofilament sensation intact. Point-of-care A1c 7.9%.",
                      "Type 2 diabetes above goal. Hypertension above goal. Hyperlipidemia on "
                      "atorvastatin.",
                      "Increase metformin to 1,000 mg twice daily. Diet review; walk 30 minutes "
                      "five days a week. Home blood pressure log. Revisit in 3 months.",
                      "Take metformin 2 tablets twice a day with meals. Write down your blood "
                      "pressure each morning and bring the log.",
                      (E11_9, I10, E78_5), (148, 90), 78, Decimal("212")),
            PastVisit(dt.date(2026, 3, 10), "Three-month diabetes and blood pressure check",
                      "Log averages 142/88. Mild stomach upset on the higher metformin dose, "
                      "now settled. Walking three days a week.",
                      "Heart regular, lungs clear, no edema. Point-of-care A1c 7.4%.",
                      "Diabetes improving. Hypertension still above goal.",
                      "Increase lisinopril to 20 mg once daily. Basic metabolic panel in two "
                      "weeks at the outside lab. Revisit in 3 months.",
                      "Take lisinopril 2 tablets once a day. Keep the blood pressure log.",
                      (E11_9, I10), (140, 86), 76, Decimal("208")),
            PastVisit(dt.date(2026, 6, 16), "Diabetes and blood pressure follow-up",
                      "Log averages 132/82. Potassium and creatinine normal after the dose "
                      "change. Walking most days.",
                      "Heart regular, lungs clear, no edema. Point-of-care A1c 7.2%. LDL "
                      "92 mg/dL.",
                      "Diabetes near goal. Hypertension improving. Lipids at goal.",
                      "No changes. Diabetic eye exam referral. Revisit in 3 months.",
                      "Keep taking your medicines as you are. Book the eye exam.",
                      (E11_9, I10, E78_5), (132, 82), 74, Decimal("204")),
            PastVisit(dt.date(2026, 9, 15), "Quarterly diabetes and blood pressure visit",
                      "Log averages 126/78. Eye exam done in August: no retinopathy. Feels "
                      "well.",
                      "Heart regular, lungs clear, feet intact. Point-of-care A1c 7.1%.",
                      "Type 2 diabetes at goal (under 7.5% for age). Hypertension at goal.",
                      "Continue metformin, lisinopril and atorvastatin. Influenza vaccine "
                      "given. Revisit in November.",
                      "Same medicines. Next visit in about two months.",
                      (E11_9, I10), (128, 78), 72, Decimal("201")),
        ),
        problems=(
            Problem(I10, "2015", "Home readings 120s to 130s over 70s to 80s since lisinopril "
                                 "20 mg (March 2026)."),
            Problem(E11_9, "2018", "Point-of-care A1c 7.1% in September 2026; goal under 7.5%. "
                                   "No retinopathy (August 2026)."),
            Problem(E78_5, "2016", "LDL 92 mg/dL in June 2026 on atorvastatin 20 mg."),
            Problem(Z87_891, "2005", "Quit smoking in 2005 after about 25 pack-years."),
        ),
        allergies=(
            Allergy(rx("7980", "penicillin G"), "allergy", "low",
                    sct("247472004", "Hives"), "moderate",
                    "Itchy hives over the trunk within hours of the first dose.",
                    dt.date(1979, 6, 1),
                    "Given for strep throat as a teenager. Has taken cephalexin since without a "
                    "reaction."),
        ),
        medications=(
            Medication(rx("861007", "metFORMIN HCl 500 MG Oral Tablet"),
                       "1,000 mg (2 tablets) by mouth twice daily with meals",
                       dt.date(2018, 5, 14), DR_LINDQVIST,
                       "For type 2 diabetes; increased to 1,000 mg twice daily on 2025-12-09."),
            Medication(rx("314076", "lisinopril 10 MG Oral Tablet"),
                       "20 mg (2 tablets) by mouth once daily",
                       dt.date(2015, 9, 3), DR_LINDQVIST,
                       "For hypertension; increased to 20 mg on 2026-03-10 by "
                       f"{DR_HALVORSEN}."),
            Medication(rx("617310", "atorvastatin calcium 20 MG Oral Tablet"),
                       "20 mg (1 tablet) by mouth at bedtime",
                       dt.date(2016, 11, 8), DR_LINDQVIST, "For hyperlipidemia."),
        ),
        family=(
            Relative(role("FTH", "father"), "male",
                     icd("I21.9", "Acute myocardial infarction, unspecified"), 62, True,
                     "Died of a heart attack at 62.", contributed_to_death=True),
            Relative(role("MTH", "mother"), "female", E11_9, 55, False,
                     "Living, 88, diet-controlled diabetes."),
        ),
        smoking=EX_SMOKER, alcohol=OCCASIONAL_DRINKER,
        surgeries=(
            Surgery(sct("80146002", "Appendectomy"), "1985", sct("66754008", "Appendix"),
                    "Open appendectomy for appendicitis; no complications."),
        ),
        height_in=Decimal("70"),
    ),
    3: History(  # Linda Thompson, 57: chronic low back pain
        visits=(
            PastVisit(dt.date(2025, 11, 18), "Low back pain, worse after lifting at work",
                      "Two weeks of aching lower back pain after lifting pallets, worse when "
                      "bending, no leg pain, numbness, weakness, or bladder or bowel change.",
                      "Tender lumbar paraspinal muscles. Straight-leg raise negative both "
                      "sides. Strength, reflexes and sensation normal in both legs.",
                      "Acute on chronic mechanical low back pain; no red flags.",
                      "Naproxen 500 mg twice daily with food for two weeks, then as needed. "
                      "Physical therapy referral. Work note: no lifting over 20 lb for two "
                      "weeks.",
                      "Take naproxen with food. Heat and gentle stretching. Come back sooner "
                      "for leg weakness, numbness, or bladder or bowel changes.",
                      (M54_50,), (126, 80), 74, Decimal("176")),
            PastVisit(dt.date(2026, 2, 24), "Back pain follow-up",
                      "Six physical therapy sessions helped by about half. Night muscle spasm "
                      "wakes her twice a week.",
                      "Mild paraspinal tenderness, full strength, straight-leg raise negative.",
                      "Chronic low back pain, improving with therapy; nocturnal muscle spasm.",
                      "Cyclobenzaprine 10 mg at bedtime as needed. Continue the home exercise "
                      "program.",
                      "Cyclobenzaprine can make you drowsy: take it at bedtime only, and don't "
                      "drive after taking it.",
                      (M54_50, G89_29), (124, 78), 72, Decimal("174")),
            PastVisit(dt.date(2026, 6, 2), "Back pain recheck",
                      "Pain 3 out of 10 most days. Using cyclobenzaprine about once a week. "
                      "Back at full duty.",
                      "Normal gait, full range of motion with mild discomfort at the end of "
                      "flexion. Neurological exam normal.",
                      "Chronic low back pain, stable and functional.",
                      "Continue the home exercises and naproxen as needed. Acetaminophen "
                      "first for mild pain.",
                      "Try acetaminophen first; keep naproxen for worse days.",
                      (G89_29, M54_50), (122, 78), 70, Decimal("172")),
            PastVisit(dt.date(2026, 9, 29), "Back pain flare after moving house",
                      "Flare for five days after moving boxes; no leg symptoms. Improving with "
                      "heat and rest.",
                      "Paraspinal spasm on the right; straight-leg raise negative; neurological "
                      "exam normal.",
                      "Flare of chronic low back pain; no red flags.",
                      "Naproxen twice daily for one week, cyclobenzaprine at night as needed, "
                      "restart the therapy exercises. Revisit in November.",
                      "Short course of naproxen with food. Restart your exercises when the "
                      "spasm settles.",
                      (M54_50, G89_29), (128, 82), 76, Decimal("171")),
        ),
        problems=(
            Problem(M54_50, "2023", "Mechanical low back pain since a lifting injury at work; "
                                    "no radicular symptoms."),
            Problem(G89_29, "2024", "Chronic low back pain managed with exercise, naproxen "
                                    "and cyclobenzaprine; avoids opioids."),
        ),
        allergies=(
            Allergy(rx("2670", "codeine"), "intolerance", "low",
                    sct("422587007", "Nausea"), "moderate",
                    "Nausea and vomiting within an hour of each dose.",
                    dt.date(2018, 4, 10),
                    "After codeine for dental pain. Prefers to avoid opioids."),
        ),
        medications=(
            Medication(rx("198014", "naproxen 500 MG Oral Tablet"),
                       "500 mg (1 tablet) by mouth twice daily with food as needed for back pain",
                       dt.date(2025, 11, 18), DR_HALVORSEN, "For low back pain."),
            Medication(rx("828348", "cyclobenzaprine HCl 10 MG Oral Tablet"),
                       "10 mg (1 tablet) by mouth at bedtime as needed for muscle spasm",
                       dt.date(2026, 2, 24), DR_HALVORSEN, "For night muscle spasm."),
            Medication(rx("198440", "acetaminophen 500 MG Oral Tablet"),
                       "1,000 mg (2 tablets) by mouth every 8 hours as needed for pain; no more "
                       "than 3,000 mg a day",
                       dt.date(2024, 3, 5), NP_OKONKWO, "First choice for mild back pain."),
        ),
        family=(
            Relative(role("MTH", "mother"), "female",
                     icd("M17.9", "Osteoarthritis of knee, unspecified"), 60, False,
                     "Living, 81; knee replacement at 70."),
            Relative(role("FTH", "father"), "male", I10, 45, True,
                     "Died at 74 of pneumonia; hypertension from his 40s."),
        ),
        smoking=NEVER_SMOKED, alcohol=NON_DRINKER,
        surgeries=(
            Surgery(sct("11466000", "Cesarean section"), "1996-05", sct("35039007", "Uterus"),
                    "Low transverse cesarean delivery; no complications."),
        ),
        height_in=Decimal("65"),
    ),
    4: History(  # James Wilson, 45: asthma
        visits=(
            PastVisit(dt.date(2025, 12, 2), "Asthma follow-up, cough at night",
                      "Night cough three times a week and albuterol use most days since a "
                      "cold in October. No fever.",
                      "Scattered expiratory wheeze, no distress, speaking full sentences. "
                      "Peak flow 410 L/min (predicted 560).",
                      "Moderate persistent asthma, not well controlled.",
                      "Start fluticasone/salmeterol 250/50 one inhalation twice daily. "
                      "Albuterol as needed. Inhaler technique reviewed. Revisit in 4 months.",
                      "Use the purple inhaler twice every day, even when well, and rinse your "
                      "mouth after. Use albuterol only for symptoms.",
                      (J45_40,), (122, 78), 76, Decimal("186")),
            PastVisit(dt.date(2026, 3, 31), "Asthma and spring allergies",
                      "Night cough gone. Sneezing and itchy eyes since mid-March; mild "
                      "wheeze with pollen.",
                      "Pale swollen nasal turbinates, clear lungs. Peak flow 500 L/min.",
                      "Moderate persistent asthma, improved; seasonal allergic rhinitis.",
                      "Add montelukast 10 mg each evening for the season. Continue "
                      "fluticasone/salmeterol.",
                      "Take montelukast each evening. Tell us about any mood or sleep changes.",
                      (J45_40, J30_2), (120, 76), 72, Decimal("185")),
            PastVisit(dt.date(2026, 8, 11), "Asthma check",
                      "No night symptoms, albuterol about once a month. Asthma Control Test "
                      "score 22.",
                      "Lungs clear. Peak flow 530 L/min.",
                      "Moderate persistent asthma, well controlled.",
                      "Continue the controller and montelukast. Influenza vaccine in the fall. "
                      "Annual physical in November.",
                      "Keep using your daily inhaler. Get your flu shot this fall.",
                      (J45_40,), (118, 76), 70, Decimal("184")),
        ),
        problems=(
            Problem(J45_40, "1990", "Childhood asthma; moderate persistent since 2015. Aspirin "
                                    "causes wheezing: avoid NSAIDs."),
            Problem(J30_2, "2000", "Spring pollen allergy; montelukast in season."),
        ),
        allergies=(
            Allergy(rx("1191", "aspirin"), "allergy", "high",
                    sct("56018004", "Wheezing"), "severe",
                    "Wheezing and chest tightness within an hour; needed a nebulizer in the "
                    "emergency department.",
                    dt.date(2012, 8, 20),
                    "Avoid aspirin and other NSAIDs (aspirin-exacerbated respiratory disease "
                    "suspected)."),
        ),
        medications=(
            Medication(rx("896209", "fluticasone propionate/salmeterol 250/50 MCG/INHAL Dry "
                                    "Powder Inhaler, 60 Blisters"),
                       "1 inhalation by mouth twice daily; rinse the mouth after use",
                       dt.date(2025, 12, 2), DR_HALVORSEN, "Asthma controller."),
            Medication(rx("801092", "albuterol 90 MCG/INHAL Metered Dose Inhaler, 60 ACTUAT, "
                                    "generic for Ventolin"),
                       "2 puffs by mouth every 4 to 6 hours as needed for wheeze or shortness "
                       "of breath",
                       dt.date(2010, 4, 1), "outside prescriber (previous practice)",
                       "Asthma reliever."),
            Medication(rx("200224", "montelukast sodium 10 MG Oral Tablet"),
                       "10 mg (1 tablet) by mouth every evening",
                       dt.date(2026, 3, 31), DR_HALVORSEN,
                       "For seasonal allergic rhinitis with asthma."),
        ),
        family=(
            Relative(role("MTH", "mother"), "female",
                     icd("J45.909", "Unspecified asthma, uncomplicated"), 10, False,
                     "Living, 72; asthma since childhood."),
            Relative(role("FTH", "father"), "male", I10, 50, False, "Living, 76."),
        ),
        smoking=NEVER_SMOKED, alcohol=OCCASIONAL_DRINKER,
        surgeries=(
            Surgery(sct("173422009", "Tonsillectomy"), "1989",
                    sct("75573002", "Palatine tonsil"), "For recurrent tonsillitis, age 8."),
        ),
        height_in=Decimal("71"),
    ),
    5: History(  # Patricia Davis, 61: breast cancer survivor, oncology follow-up
        visits=(
            PastVisit(dt.date(2026, 1, 13), "Survivorship visit, joint aches",
                      "Aching hands and knees in the morning for three months, about 20 "
                      "minutes. Taking anastrozole daily. No breast changes, no bone pain, no "
                      "weight loss.",
                      "Breasts: healed left lumpectomy scar, no masses, no axillary nodes. "
                      "Joints: no swelling or redness.",
                      "History of left breast cancer on adjuvant anastrozole; arthralgia from "
                      "the aromatase inhibitor.",
                      "Acetaminophen as needed, daily walking. Continue anastrozole as oncology "
                      "advised. Mammogram due in April.",
                      "Acetaminophen up to 2 tablets three times a day for aches. Keep taking "
                      "anastrozole every day.",
                      (Z85_3, Z79_811), (130, 82), 72, Decimal("148")),
            PastVisit(dt.date(2026, 4, 21), "Follow-up after mammogram",
                      "Screening mammogram on 7 April 2026 (outside imaging): no evidence of "
                      "malignancy. Joint aches better with walking.",
                      "No breast masses or nodes. No edema of the left arm.",
                      "No recurrence. Aromatase-inhibitor arthralgia, improving.",
                      "Bone density scan ordered (on anastrozole). Continue current plan.",
                      "Book the bone density scan.",
                      (Z85_3, Z79_811), (128, 80), 70, Decimal("149")),
            PastVisit(dt.date(2026, 7, 28), "Bone density results",
                      "Bone density scan on 9 July 2026: osteopenia, lowest T-score -1.8 at "
                      "the left hip. No fractures. Little dairy in her diet.",
                      "Normal exam; no spinal tenderness.",
                      "Osteopenia on anastrozole; history of breast cancer, no recurrence.",
                      "Calcium 600 mg with vitamin D3 400 units twice daily, weight-bearing "
                      "exercise. Repeat the scan in two years.",
                      "Take calcium with vitamin D twice a day with meals.",
                      (Z85_3, Z79_811), (126, 80), 68, Decimal("150")),
            PastVisit(dt.date(2026, 10, 20), "Review of the oncology follow-up",
                      "Seen by her oncologist on 6 October 2026: no evidence of disease; "
                      "anastrozole extended to seven years in total (to September 2028).",
                      "Normal breast and lymph node exam.",
                      "Breast cancer survivor, no evidence of recurrence, on extended "
                      "anastrozole.",
                      "Continue anastrozole, calcium and vitamin D. Mammogram April 2027. "
                      "Oncology every 6 months.",
                      "Same medicines. Next mammogram in April.",
                      (Z85_3, Z79_811), (128, 78), 70, Decimal("150")),
        ),
        problems=(
            Problem(Z85_3, "2021-03", "Left breast invasive ductal carcinoma, stage IA, ER and "
                                      "PR positive, HER2 negative. Lumpectomy and sentinel node "
                                      "biopsy April 2021, then radiation. No recurrence."),
            Problem(Z92_3, "2021-06", "Whole-breast radiation to the left breast, completed "
                                      "July 2021."),
            Problem(Z79_811, "2021-09", "Anastrozole since September 2021, extended to seven "
                                        "years by oncology (to September 2028)."),
        ),
        allergies=(
            Allergy(rx("10180", "sulfamethoxazole"), "allergy", "low",
                    sct("271807003", "Skin rash"), "moderate",
                    "Itchy red rash over the trunk and arms on day five.",
                    dt.date(2014, 9, 15),
                    "With trimethoprim-sulfamethoxazole for a urinary tract infection."),
        ),
        medications=(
            Medication(rx("199224", "anastrozole 1 MG Oral Tablet"),
                       "1 mg (1 tablet) by mouth once daily",
                       dt.date(2021, 9, 1), "outside oncology practice",
                       "Adjuvant therapy after breast cancer; planned to September 2028."),
            Medication(rx("198440", "acetaminophen 500 MG Oral Tablet"),
                       "1,000 mg (2 tablets) by mouth every 8 hours as needed for joint aches; "
                       "no more than 3,000 mg a day",
                       dt.date(2026, 1, 13), DR_HALVORSEN, "For aromatase-inhibitor joint aches."),
            Medication(rx("428485", "calcium 600 MG / vitamin D3 10 MCG (400 UNT) Oral Tablet, "
                                    "as calcium carbonate"),
                       "1 tablet by mouth twice daily with meals",
                       dt.date(2026, 7, 28), DR_HALVORSEN, "For osteopenia on anastrozole."),
        ),
        family=(
            Relative(role("MTH", "mother"), "female",
                     icd("C50.919", "Malignant neoplasm of unspecified site of unspecified "
                                    "female breast"), 58, True,
                     "Breast cancer at 58; died at 66.", contributed_to_death=True),
            Relative(role("SIS", "sister"), "female",
                     icd("C50.919", "Malignant neoplasm of unspecified site of unspecified "
                                    "female breast"), 52, False,
                     "Breast cancer at 52, living; genetic testing negative."),
        ),
        smoking=NEVER_SMOKED, alcohol=OCCASIONAL_DRINKER,
        surgeries=(
            Surgery(sct("392021009", "Lumpectomy of breast"), "2021-04",
                    sct("80248007", "Left breast"),
                    "Lumpectomy with clear margins, for stage IA breast cancer."),
            Surgery(sct("396487001", "Sentinel lymph node biopsy"), "2021-04",
                    sct("68171009", "Axillary lymph node"),
                    "Left axilla, same operation; nodes negative."),
        ),
        height_in=Decimal("64"),
        last_follow_up=(6, "Will book after her October oncology visit."),
    ),
    6: History(  # David Nguyen, 39: migraine (restricted chart)
        visits=(
            PastVisit(dt.date(2025, 12, 16), "Migraine follow-up",
                      "Four to five migraines a month, each lasting most of a day, with "
                      "nausea and light sensitivity; no aura. Sumatriptan works within two "
                      "hours. Missed three workdays last month.",
                      "Neurological exam normal, fundi normal.",
                      "Migraine without aura, frequent enough for prevention.",
                      "Start propranolol 20 mg twice daily. Headache diary. Limit sumatriptan "
                      "to 9 days a month.",
                      "Take propranolol twice a day, every day. Keep the headache diary.",
                      (G43_009,), (124, 80), 74, Decimal("165")),
            PastVisit(dt.date(2026, 4, 14), "Migraine prevention check",
                      "Two migraines a month by the diary; no missed work. Slight tiredness on "
                      "propranolol in the first weeks, now gone.",
                      "Neurological exam normal.",
                      "Migraine without aura, improved on propranolol.",
                      "Continue propranolol and sumatriptan as needed. Sleep and caffeine "
                      "habits reviewed.",
                      "Keep regular sleep and meals; they help prevent attacks.",
                      (G43_009,), (116, 74), 62, Decimal("166")),
            PastVisit(dt.date(2026, 8, 25), "Migraine follow-up",
                      "One to two mild migraines a month. Sumatriptan used three times since "
                      "the last visit.",
                      "Neurological exam normal.",
                      "Migraine without aura, well controlled.",
                      "No changes. Revisit in 6 months or sooner if attacks increase.",
                      "Same medicines. Call if your headaches change pattern.",
                      (G43_009,), (114, 72), 60, Decimal("165")),
        ),
        problems=(
            Problem(G43_009, "2010", "Migraine without aura since college; propranolol "
                                     "prevention since December 2025."),
        ),
        allergies=(
            Allergy(rx("5640", "ibuprofen"), "intolerance", "low",
                    sct("162059005", "Upset stomach"), "mild",
                    "Stomach pain and heartburn after two or three doses.",
                    dt.date(2019, 2, 4), "Tolerates acetaminophen."),
        ),
        medications=(
            Medication(rx("313161", "SUMAtriptan succinate 50 MG Oral Tablet"),
                       "50 mg (1 tablet) by mouth at migraine onset; may repeat once after 2 "
                       "hours; no more than 200 mg a day",
                       dt.date(2016, 6, 20), "outside prescriber (previous practice)",
                       "Migraine treatment."),
            Medication(rx("856457", "propranolol HCl 20 MG Oral Tablet"),
                       "20 mg (1 tablet) by mouth twice daily",
                       dt.date(2025, 12, 16), DR_HALVORSEN, "Migraine prevention."),
        ),
        family=(
            Relative(role("MTH", "mother"), "female",
                     icd("G43.909", "Migraine, unspecified, not intractable, without status "
                                    "migrainosus"), 20, False, "Living, 64; migraine since 20."),
            Relative(role("FTH", "father"), "male", E11_9, 50, False, "Living, 68."),
        ),
        smoking=NEVER_SMOKED, alcohol=OCCASIONAL_DRINKER,
        surgeries=(
            Surgery(sct("44558001", "Repair of inguinal hernia"), "2015",
                    sct("85119005", "Right inguinal region"),
                    "Laparoscopic repair with mesh; no recurrence."),
        ),
        height_in=Decimal("69"),
        last_follow_up=(6, "Will call to book when the next appointment is due."),
    ),
    7: History(  # Maria Gonzalez, 72: COPD and osteoarthritis
        visits=(
            PastVisit(dt.date(2025, 11, 25), "COPD follow-up and knee pain",
                      "Short of breath climbing one flight of stairs, stable. Uses albuterol "
                      "two or three times a week. Both knees ache after walking, worse in the "
                      "cold.",
                      "Mildly prolonged expiration, no wheeze. Both knees: crepitus, no "
                      "effusion.",
                      "COPD, stable on tiotropium. Bilateral knee osteoarthritis.",
                      "Continue tiotropium and albuterol. Acetaminophen for the knees. "
                      "Pneumococcal vaccine given.",
                      "Use tiotropium every day. Take acetaminophen for knee pain, not "
                      "ibuprofen.",
                      (J44_9, M17_0), (136, 84), 82, Decimal("158")),
            PastVisit(dt.date(2026, 2, 17), "Cough and breathlessness after a cold",
                      "Five days of more cough, green sputum and breathlessness after her "
                      "grandson's cold. No chest pain.",
                      "Temperature 99.1 F. Diffuse wheeze, no crackles.",
                      "COPD exacerbation, moderate.",
                      "Prednisone 40 mg daily for 5 days and doxycycline for 5 days (completed). "
                      "Albuterol every 4 hours while symptomatic. Revisit in 2 weeks if not "
                      "better.",
                      "Finish the prednisone and antibiotic. Go to the emergency department if "
                      "your breathing gets worse.",
                      (J44_1,), (138, 86), 96, Decimal("156"), Decimal("99.1")),
            PastVisit(dt.date(2026, 5, 19), "COPD follow-up",
                      "Back to her usual breathing two weeks after the exacerbation. Albuterol "
                      "twice a week.",
                      "Lungs: mildly prolonged expiration, no wheeze.",
                      "COPD, back to baseline. Knee osteoarthritis, stable.",
                      "Continue tiotropium. Pulmonary rehabilitation referral.",
                      "Book pulmonary rehabilitation. Keep walking daily.",
                      (J44_9, M17_0), (134, 82), 80, Decimal("157")),
            PastVisit(dt.date(2026, 9, 8), "Knee pain follow-up and flu vaccine",
                      "Finished pulmonary rehabilitation; walks 20 minutes a day. Knees ache "
                      "after longer walks.",
                      "Both knees: crepitus, mild medial joint-line tenderness, no effusion.",
                      "Bilateral knee osteoarthritis, stable. COPD, stable.",
                      "Influenza vaccine given. Physical therapy for the knees. Continue "
                      "acetaminophen.",
                      "Book knee physical therapy. Acetaminophen for knee pain.",
                      (M17_0, J44_9), (132, 80), 78, Decimal("158")),
        ),
        problems=(
            Problem(J44_9, "2016", "GOLD 2; FEV1 62% of predicted (2024). One moderate "
                                   "exacerbation in February 2026."),
            Problem(M17_0, "2019", "Both knees; acetaminophen and physical therapy. Avoids "
                                   "NSAIDs."),
            Problem(Z87_891, "2012", "Quit in 2012 after about 40 pack-years."),
        ),
        allergies=(
            Allergy(rx("29046", "lisinopril"), "allergy", "high",
                    sct("41291007", "Angioedema"), "severe",
                    "Swelling of the lips and tongue; treated in the emergency department.",
                    dt.date(2017, 3, 2), "No ACE inhibitors."),
        ),
        medications=(
            Medication(rx("485032", "tiotropium 18 MCG Inhalation Powder"),
                       "inhale the contents of 1 capsule (18 mcg) once daily with the inhaler "
                       "device",
                       dt.date(2016, 10, 4), DR_LINDQVIST, "COPD maintenance."),
            Medication(rx("801092", "albuterol 90 MCG/INHAL Metered Dose Inhaler, 60 ACTUAT, "
                                    "generic for Ventolin"),
                       "2 puffs by mouth every 4 to 6 hours as needed for shortness of breath",
                       dt.date(2016, 10, 4), DR_LINDQVIST, "COPD reliever."),
            Medication(rx("198440", "acetaminophen 500 MG Oral Tablet"),
                       "1,000 mg (2 tablets) by mouth every 8 hours as needed for knee pain; no "
                       "more than 3,000 mg a day",
                       dt.date(2019, 5, 21), NP_OKONKWO, "For knee osteoarthritis."),
        ),
        family=(
            Relative(role("FTH", "father"), "male",
                     icd("C34.90", "Malignant neoplasm of unspecified part of unspecified "
                                   "bronchus or lung"), 65, True,
                     "Lung cancer at 65; died at 67. Smoked.", contributed_to_death=True),
            Relative(role("SIS", "sister"), "female", E11_9, 60, False, "Living, 75."),
        ),
        smoking=EX_SMOKER, alcohol=NON_DRINKER,
        surgeries=(
            Surgery(sct("38102005", "Cholecystectomy"), "2008", sct("28231008", "Gallbladder"),
                    "Laparoscopic, for gallstones."),
        ),
        height_in=Decimal("62"),
        last_follow_up=(3, "Will book after finishing knee physical therapy."),
    ),
}


async def _exists(db: AsyncSession, sql: str, **params: object) -> bool:
    return bool((await db.execute(text(f"SELECT EXISTS ({sql})"), params)).scalar_one())


async def _emergency_contact(store: fs.SqlFhirStore, db: AsyncSession, p: DemoPatient) -> None:
    c = p.emergency
    if c is None:
        return
    await store.create_related_person(db, fs.RelatedPersonIn(
        patient_id=sid(PATIENT, p.n),
        relationships=(EMERGENCY_CONTACT, role(c.relationship, c.relationship_display)),
        names=(fs.Name(use="official", family=c.family, given=(c.given,)),),
        gender=c.gender, birth_date=c.birth_date,
        telecoms=(fs.Telecom(system="phone", value=c.phone, use="mobile", rank=1),
                  fs.Telecom(system="email", value=c.email, use="home", rank=2)),
        addresses=(fs.PostalAddress(lines=(c.street or p.street,), city="Springfield",
                                    state="IL", postal_code="62704", use="home"),)))


async def _appointment(db: AsyncSession, patient_id: uuid.UUID, n: int,
                       visit: PastVisit) -> uuid.UUID:
    """The past visit's booking, fulfilled, as check-in and check-out leave one."""
    appointment = M["appointment"](
        id=sid(PAST_APPOINTMENT, n), status="fulfilled", subject_patient_id=patient_id,
        start=visit.start, end=visit.start + dt.timedelta(minutes=20), minutes_duration=20,
        created=visit.start - dt.timedelta(days=21), ext_appointment_type_id=FOLLOW_UP_TYPE,
        ext_schedule_id=DOCTOR_SCHEDULE, ext_facility_id=FACILITY_A)
    appointment.reason = [M["appointment_reason"](id=sid(PA_REASON, n),
                                                  reason_code_text=visit.reason)]
    appointment.participant = [
        M["appointment_participant"](id=sid(PA_PATIENT, n), actor_patient_id=patient_id,
                                     required="required", status="accepted"),
        M["appointment_participant"](id=sid(PA_PROVIDER, n), actor_practitioner_id=DOCTOR,
                                     required="required", status="accepted"),
        M["appointment_participant"](id=sid(PA_LOCATION, n), actor_location_id=MAIN_OFFICE,
                                     required="required", status="accepted")]
    db.add(appointment)
    await db.flush()
    return sid(PAST_APPOINTMENT, n)


async def _step(db: AsyncSession, appointment: uuid.UUID, n: int, i: int, step: str,
                at: dt.datetime, user: uuid.UUID, room: uuid.UUID | None = None) -> None:
    """One visit step, as the front desk, the MA and the doctor record them (insert-only)."""
    db.add(M["visit_flow_event"](id=sid(PA_STEP, n * 10 + i), appointment_id=appointment,
                                 step=step, occurred_at=at, user_id=user, location_id=room,
                                 created_by_user_id=user, updated_by_user_id=user))
    await db.flush()


async def _visit(store: fs.SqlFhirStore, db: AsyncSession, patient_id: uuid.UUID, n: int,
                 visit: PastVisit, height_in: Decimal, appointment: uuid.UUID,
                 follow_up: tuple[int, uuid.UUID | None, str | None]) -> uuid.UUID:
    """Check-in to check-out, as the live visit writes it: the encounter, the steps, the room,
    vitals, diagnoses, the signed SOAP note and the follow-up request (booked, or declined)."""
    start = visit.start
    await _step(db, appointment, n, 1, "checked-in", start, FRONT_DESK_USER)
    written = await store.create_encounter(db, fs.EncounterIn(
        patient_id=patient_id, facility_id=FACILITY_A, status="arrived", started_at=start,
        appointment_id=appointment, participants=(fs.ParticipantIn(practitioner_id=DOCTOR),),
        reasons=(fs.Coded(text=visit.reason),)))
    encounter = written.id
    roomed = start + dt.timedelta(minutes=10)
    await store.set_encounter_status(db, encounter, "in-progress", at=roomed)
    db.add(M["encounter_location"](id=sid(PA_ROOM, n), encounter_id=encounter,
                                   location_id=EXAM_ROOM, status="completed",
                                   period_start=roomed,
                                   period_end=start + dt.timedelta(minutes=40)))
    await _step(db, appointment, n, 2, "roomed", roomed, MA_USER, EXAM_ROOM)
    await store.record_vitals(db, patient_id, encounter, (
        fs.VitalIn(type="blood-pressure", systolic=fs.Measured(Decimal(visit.bp[0]), "mm[Hg]"),
                   diastolic=fs.Measured(Decimal(visit.bp[1]), "mm[Hg]")),
        fs.VitalIn(type="heart-rate", value=fs.Measured(Decimal(visit.heart_rate), "/min")),
        fs.VitalIn(type="body-weight", value=fs.Measured(visit.weight_lb, "[lb_av]")),
        fs.VitalIn(type="body-height", value=fs.Measured(height_in, "[in_i]")),
        fs.VitalIn(type="body-temperature", value=fs.Measured(visit.temperature_f, "[degF]")),
    ), effective_at=roomed)
    await _step(db, appointment, n, 3, "with-provider", start + dt.timedelta(minutes=15),
                DOCTOR_USER)
    for code in visit.diagnoses:
        await store.add_encounter_diagnosis(db, encounter, fs.DiagnosisIn(code=code))
    note = await store.create_note(db, fs.NoteIn(
        encounter_id=encounter, note_type=PROGRESS_NOTE, title="SOAP progress note",
        template_id=SOAP_TEMPLATE,
        sections=(fs.SectionIn(code="61150-9", title="Subjective",
                               text=f"{visit.reason}. {visit.subjective}"),
                  fs.SectionIn(code="61149-1", title="Objective", text=visit.objective),
                  fs.SectionIn(code="51848-0", title="Assessment", text=visit.assessment),
                  fs.SectionIn(code="18776-5", title="Plan", text=visit.plan),
                  fs.SectionIn(code="69730-0", title="Patient instructions",
                               text=visit.instructions))))
    await store.sign_note(db, note.id, if_version=note.version)
    months, booked, declined = follow_up
    db.add(M["encounter_follow_up"](
        id=sid(PA_FOLLOW_UP, n), encounter_id=encounter, patient_id=patient_id,
        interval_value=months, interval_unit="month", appointment_type_id=FOLLOW_UP_TYPE,
        practitioner_id=DOCTOR, note=f"Revisit in {months} months for {visit.assessment[0].lower()}"
                                     f"{visit.assessment[1:]}",
        status="booked" if booked else "declined", booked_appointment_id=booked,
        status_reason=declined, requested_by_user_id=DOCTOR_USER,
        requested_at=start + dt.timedelta(minutes=35)))
    await db.flush()
    await store.set_encounter_status(db, encounter, "finished",
                                     at=start + dt.timedelta(minutes=40))
    await _step(db, appointment, n, 4, "checked-out", start + dt.timedelta(minutes=45),
                FRONT_DESK_USER)
    return encounter


def _noon(day: dt.date) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(12, 0), tzinfo=dt.UTC)


def _months(after: dt.date, until: dt.date) -> int:
    return max(1, round((until - after).days / 30.4))


async def _patient_history(store: fs.SqlFhirStore, db: AsyncSession, p: DemoPatient,
                           h: History) -> None:
    patient_id = sid(PATIENT, p.n)
    booked = [await _appointment(db, patient_id, p.n * 10 + i, v)
              for i, v in enumerate(h.visits, start=1)]
    visits = []
    for i, v in enumerate(h.visits, start=1):
        follow_up: tuple[int, uuid.UUID | None, str | None]
        if i < len(h.visits):               # booked as the next past visit
            follow_up = (_months(v.day, h.visits[i].day), booked[i], None)
        elif h.last_follow_up is None:      # the demo-day appointment books it
            follow_up = (_months(v.day, dt.date(2026, 11, 20)), sid(APPOINTMENT, p.n), None)
        else:
            follow_up = (h.last_follow_up[0], None, h.last_follow_up[1])
        visits.append(await _visit(store, db, patient_id, p.n * 10 + i, v, h.height_in,
                                   booked[i - 1], follow_up))
    first = visits[0]           # where the history was taken and the lists reconciled
    for problem in h.problems:
        await store.create_problem(db, fs.ProblemIn(
            patient_id=patient_id, code=problem.code, onset=problem.onset, note=problem.note,
            encounter_id=first))
    for a in h.allergies:
        await store.create_allergy(db, fs.AllergyIn(
            patient_id=patient_id, code=a.code, type=a.type, categories=("medication",),
            criticality=a.criticality, onset_date_time=_noon(a.onset), encounter_id=first,
            note=a.note,
            reactions=(fs.ReactionIn(manifestations=(a.manifestation,), severity=a.severity,
                                     description=a.description, onset=_noon(a.onset)),)))
    for m in h.medications:
        await store.record_medication(db, fs.MedicationIn(
            patient_id=patient_id, medication=m.product, dosage_text=m.sig, note=m.note,
            encounter_id=first))
    for r in h.family:
        await store.create_family_history(db, fs.FamilyHistoryIn(
            patient_id=patient_id, relationship=r.relationship, sex=r.sex,
            deceased=r.deceased, note=r.note,
            conditions=(fs.FamilyConditionIn(code=r.condition, onset_age=r.onset_age,
                                             contributed_to_death=r.contributed_to_death),)))
    effective = h.visits[0].day.isoformat()
    for question, answer in ((TOBACCO, h.smoking), (ALCOHOL, h.alcohol)):
        await store.record_social_history(db, fs.SocialHistoryIn(
            patient_id=patient_id, code=question, value=answer, effective=effective,
            encounter_id=first))
    for s in h.surgeries:
        await store.create_surgical_history(db, fs.SurgicalHistoryIn(
            patient_id=patient_id, code=s.code, performed=s.performed, body_site=s.body_site,
            note=s.note, encounter_id=first))


async def _as_user(db: AsyncSession, user: uuid.UUID) -> None:
    await db.execute(text("SELECT set_config('app.current_user_id', :u, true)"),
                     {"u": str(user)})


async def load_history(engine: AsyncEngine) -> int:
    """Writes the emergency contacts, the history and the restriction of every shown patient
    who doesn't have them yet; returns how many patients it wrote to. The engine connects as
    shri_migrator, as the rest of the seed does."""
    store, written = fs.SqlFhirStore(), set()
    async with AsyncSession(engine, expire_on_commit=False) as db, db.begin():
        db.info[TENANT_ID_INFO_KEY] = CLINIC_A
        # As the starter layer: the rule functions name tables without a schema, and a role's
        # search_path applies only at login (the tests use SET ROLE). This transaction only.
        await db.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))
        await db.execute(text(
            "SELECT set_config('app.current_tenant_id', :t, true), "
            "set_config('app.correlation_id', 'seed-history', true)"), {"t": str(CLINIC_A)})
        await _as_user(db, DOCTOR_USER)
        for p in SHOWN_PATIENTS:
            patient_id = sid(PATIENT, p.n)
            if not await _exists(db, "SELECT 1 FROM clinical.related_person "
                                     "WHERE patient_id = :p", p=patient_id):
                await _emergency_contact(store, db, p)
                written.add(p.n)
            h = HISTORY.get(p.n)
            if h is not None and not await _exists(
                    db, "SELECT 1 FROM clinical.encounter WHERE subject_patient_id = :p "
                        "AND period_start = :at", p=patient_id, at=h.visits[0].start):
                await _patient_history(store, db, p, h)
                written.add(p.n)
        await _as_user(db, ADMIN_USER)       # who restricts a chart (ADM)
        for p in SHOWN_PATIENTS:
            if p.restricted and not await _exists(
                    db, "SELECT 1 FROM clinical.patient WHERE id = :p "
                        "AND 'R' = ANY(meta_security)", p=sid(PATIENT, p.n)):
                await store.set_patient_security(db, sid(PATIENT, p.n), frozenset({"R"}),
                                                 reason=fs.Reason(RESTRICT_REASON))
                written.add(p.n)
    return len(written)


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
