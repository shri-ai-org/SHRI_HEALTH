"""The six history patients' lab results and imaging reports (Vimal's shape on #85, 13 Nov).

One table, ``STUDIES``, easy to edit: each study is ordered at one of the patient's history
visits by the demo doctor, done at or after the order, reported after that, before the next
visit, all on fixed past dates. It is written through ``app.db.fhir_store`` (``record_order``,
``record_report``) as the history is, in its own transaction after it, and skipped for a patient
who already has their first report, so a second run changes nothing and every reset restores it.

- **Lab results:** a final ``DiagnosticReport`` per panel (category ``LAB``), its analytes as
  ``Observation`` rows (category ``laboratory``) with a UCUM quantity, the adult reference range
  and an ``H`` or ``L`` flag outside it.
- **Imaging reports:** text only. A ``DiagnosticReport`` (category ``RAD``) with the impression in
  ``conclusion`` and the technique and findings as narrative ``Observation`` rows (LOINC 18782-3,
  ``value_string``). No image, no ImagingStudy, no link, no placeholder.
- **Codes:** every LOINC code below was checked against NLM's LOINC data (the Clinical Table
  Search Service, 13 Nov 2026). The two order categories are US Core's SNOMED CT codes, which
  can't be checked here (Q8).

Synthetic data only: invented values that fit each patient's problems, medicines, vitals and
signed notes; nothing from real or de-identified records or any dataset under a data-use
agreement. David Nguyen's chart is restricted, so his results and reports are too (D22, D37).
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
from app.core.deps import CLINIC_A
from app.db import fhir_store as fs
from app.db.models import MAPPERS, systems
from app.db.seed.demo import CLINIC_ZONE, PAST_APPOINTMENT, PATIENT, PATIENTS
from app.db.seed.history import DOCTOR, DOCTOR_USER, HISTORY, _as_user, _exists
from app.db.seed.starter import sid

M = MAPPERS
#: Kinds of fixed ID (app/db/CLAUDE.md's table): an order, its report, and the two performers.
LAB_ORDER, LAB_REPORT, RESULT_ORG = range(63, 66)
LAB, RADIOLOGY = sid(RESULT_ORG, 1), sid(RESULT_ORG, 2)
PERFORMERS = ((LAB, "Example Reference Laboratory (synthetic)"),
              (RADIOLOGY, "Example Radiology Group (synthetic)"))

#: Every LOINC code used, with its name as NLM's LOINC data gives it (checked 13 Nov 2026).
LOINC = {
    "4548-4": "Hemoglobin A1c/Hemoglobin.total in Blood",
    "24331-1": "Lipid 1996 panel - Serum or Plasma",
    "2093-3": "Cholesterol [Mass/volume] in Serum or Plasma",
    "2085-9": "Cholesterol in HDL [Mass/volume] in Serum or Plasma",
    "13457-7": "Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation",
    "2571-8": "Triglyceride [Mass/volume] in Serum or Plasma",
    "24323-8": "Comprehensive metabolic 2000 panel - Serum or Plasma",
    "24321-2": "Basic metabolic 2000 panel - Serum or Plasma",
    "2345-7": "Glucose [Mass/volume] in Serum or Plasma",
    "3094-0": "Urea nitrogen [Mass/volume] in Serum or Plasma",
    "2160-0": "Creatinine [Mass/volume] in Serum or Plasma",
    "2951-2": "Sodium [Moles/volume] in Serum or Plasma",
    "2823-3": "Potassium [Moles/volume] in Serum or Plasma",
    "2075-0": "Chloride [Moles/volume] in Serum or Plasma",
    "2028-9": "Carbon dioxide, total [Moles/volume] in Serum or Plasma",
    "17861-6": "Calcium [Mass/volume] in Serum or Plasma",
    "2885-2": "Protein [Mass/volume] in Serum or Plasma",
    "1751-7": "Albumin [Mass/volume] in Serum or Plasma",
    "1975-2": "Bilirubin.total [Mass/volume] in Serum or Plasma",
    "6768-6": "Alkaline phosphatase [Enzymatic activity/volume] in Serum or Plasma",
    "1742-6": "Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma",
    "1920-8": "Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma",
    "98979-8": "Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by "
               "Creatinine-based formula (CKD-EPI 2021)/1.73 sq M",
    "9318-7": "Albumin/Creatinine [Mass Ratio] in Urine",
    "58410-2": "CBC panel - Blood by Automated count",
    "57021-8": "CBC W Auto Differential panel - Blood",
    "6690-2": "Leukocytes [#/volume] in Blood by Automated count",
    "789-8": "Erythrocytes [#/volume] in Blood by Automated count",
    "718-7": "Hemoglobin [Mass/volume] in Blood",
    "4544-3": "Hematocrit [Volume Fraction] of Blood by Automated count",
    "787-2": "MCV [Entitic mean volume] in Red Blood Cells by Automated count",
    "777-3": "Platelets [#/volume] in Blood by Automated count",
    "711-2": "Eosinophils [#/volume] in Blood by Automated count",
    "713-8": "Eosinophils/Leukocytes in Blood by Automated count",
    "4537-7": "Erythrocyte [Sedimentation Rate] in Blood by Westergren method",
    "1988-5": "C reactive protein [Mass/volume] in Serum or Plasma",
    "3016-3": "Thyrotropin [Units/volume] in Serum or Plasma",
    "6875-9": "Cancer Ag 15-3 [Units/volume] in Serum or Plasma",
    "2039-6": "Carcinoembryonic Ag [Mass/volume] in Serum or Plasma",
    "81459-0": "Spirometry panel",
    "20150-9": "FEV1",
    "19870-5": "Forced vital capacity [Volume] Respiratory system",
    "19926-5": "FEV1/FVC",
    "20152-5": "FEV1 measured/predicted",
    "20155-8": "FEV1 --post bronchodilation",
    "69970-2": "FEV1/FVC --post bronchodilation",
    "19935-6": "Maximum expiratory gas flow Respiratory system airway by Peak flow meter",
    "18782-3": "Radiology Study observation (narrative)",
    "36643-5": "XR Chest 2 Views",
    "30679-5": "MR Lumbar spine WO contrast",
    "30657-1": "MR Brain WO contrast",
    "26346-7": "MG Breast - bilateral Diagnostic",
    "38268-9": "DXA Skeletal system Views for bone density",
    "36310-1": "XR Knee - bilateral 3 Views",
}
#: The clinical short name of each code, the CodeableConcept's `text`, which the screens show
#: (Vimal's A6 on #85); the coding keeps the LOINC code and NLM's long name above as `display`.
SHORT = {
    "4548-4": "Hemoglobin A1c",
    "24331-1": "Lipid panel",
    "2093-3": "Total cholesterol",
    "2085-9": "HDL cholesterol",
    "13457-7": "LDL cholesterol (calculated)",
    "2571-8": "Triglycerides",
    "24323-8": "Comprehensive metabolic panel",
    "24321-2": "Basic metabolic panel",
    "2345-7": "Glucose",
    "3094-0": "Urea nitrogen (BUN)",
    "2160-0": "Creatinine",
    "2951-2": "Sodium",
    "2823-3": "Potassium",
    "2075-0": "Chloride",
    "2028-9": "Carbon dioxide (CO2)",
    "17861-6": "Calcium",
    "2885-2": "Total protein",
    "1751-7": "Albumin",
    "1975-2": "Total bilirubin",
    "6768-6": "Alkaline phosphatase",
    "1742-6": "ALT",
    "1920-8": "AST",
    "98979-8": "eGFR (CKD-EPI 2021)",
    "9318-7": "Urine albumin/creatinine ratio",
    "58410-2": "Complete blood count",
    "57021-8": "Complete blood count with differential",
    "6690-2": "White blood cells",
    "789-8": "Red blood cells",
    "718-7": "Hemoglobin",
    "4544-3": "Hematocrit",
    "787-2": "MCV",
    "777-3": "Platelets",
    "711-2": "Eosinophils (absolute)",
    "713-8": "Eosinophils (%)",
    "4537-7": "ESR (Westergren)",
    "1988-5": "C-reactive protein",
    "3016-3": "TSH",
    "6875-9": "CA 15-3",
    "2039-6": "CEA",
    "81459-0": "Spirometry",
    "20150-9": "FEV1",
    "19870-5": "FVC",
    "19926-5": "FEV1/FVC",
    "20152-5": "FEV1 % predicted",
    "20155-8": "FEV1 after bronchodilator",
    "69970-2": "FEV1/FVC after bronchodilator",
    "19935-6": "Peak expiratory flow",
    "18782-3": "Report text",
    "36643-5": "XR chest, 2 views",
    "30679-5": "MR lumbar spine without contrast",
    "30657-1": "MR brain without contrast",
    "26346-7": "Mammogram, bilateral, diagnostic",
    "38268-9": "DXA bone density",
    "36310-1": "XR knees, bilateral, 3 views",
}


def loinc(code: str) -> fs.Coded:
    """The coding with NLM's long name as display, and the short name as the text."""
    return fs.Coded(systems.LOINC, code, LOINC[code], SHORT[code])


#: (unit, low, high) per analyte and sex ("F"/"M"; "" for both): adult reference ranges.
RANGES: dict[tuple[str, str], tuple[str, str | None, str | None]] = {
    ("4548-4", ""): ("%", "4.0", "5.6"),
    ("2093-3", ""): ("mg/dL", None, "199"), ("2085-9", ""): ("mg/dL", "40", None),
    ("13457-7", ""): ("mg/dL", None, "99"), ("2571-8", ""): ("mg/dL", None, "149"),
    ("2345-7", ""): ("mg/dL", "70", "99"), ("3094-0", ""): ("mg/dL", "7", "20"),
    ("2160-0", "M"): ("mg/dL", "0.74", "1.35"), ("2160-0", "F"): ("mg/dL", "0.59", "1.04"),
    ("2951-2", ""): ("mmol/L", "135", "145"), ("2823-3", ""): ("mmol/L", "3.5", "5.1"),
    ("2075-0", ""): ("mmol/L", "98", "107"), ("2028-9", ""): ("mmol/L", "22", "29"),
    ("17861-6", ""): ("mg/dL", "8.6", "10.3"), ("2885-2", ""): ("g/dL", "6.0", "8.3"),
    ("1751-7", ""): ("g/dL", "3.5", "5.0"), ("1975-2", ""): ("mg/dL", "0.1", "1.2"),
    ("6768-6", ""): ("U/L", "44", "147"), ("1742-6", ""): ("U/L", "7", "56"),
    ("1920-8", ""): ("U/L", "10", "40"), ("98979-8", ""): ("mL/min/{1.73_m2}", "60", None),
    ("9318-7", ""): ("mg/g", None, "29"),
    ("6690-2", ""): ("10*3/uL", "4.0", "11.0"),
    ("789-8", "M"): ("10*6/uL", "4.5", "5.9"), ("789-8", "F"): ("10*6/uL", "4.1", "5.1"),
    ("718-7", "M"): ("g/dL", "13.5", "17.5"), ("718-7", "F"): ("g/dL", "12.0", "15.5"),
    ("4544-3", "M"): ("%", "41", "53"), ("4544-3", "F"): ("%", "36", "46"),
    ("787-2", ""): ("fL", "80", "100"), ("777-3", ""): ("10*3/uL", "150", "400"),
    ("711-2", ""): ("10*3/uL", "0.0", "0.5"), ("713-8", ""): ("%", "0", "6"),
    ("4537-7", "F"): ("mm/h", "0", "30"), ("1988-5", ""): ("mg/L", "0.0", "5.0"),
    ("3016-3", ""): ("m[IU]/L", "0.40", "4.00"), ("6875-9", ""): ("U/mL", None, "31"),
    ("2039-6", ""): ("ng/mL", None, "3.0"),
    ("20150-9", ""): ("L", None, None), ("19870-5", ""): ("L", None, None),
    ("19926-5", ""): ("%", "70", None), ("20152-5", ""): ("%", "80", None),
    ("20155-8", ""): ("L", None, None), ("69970-2", ""): ("%", "70", None),
    ("19935-6", ""): ("L/min", None, None),
}


@dataclass(frozen=True)
class Study:
    """One ordered test or study and its report. ``values``: (LOINC, value) per analyte, in
    report order; a radiology study has ``findings`` (technique, findings) and an impression."""
    patient: int                            # the demo patient's n
    ordered_at: dt.date                     # one of the patient's history visits
    code: str                               # the report's LOINC
    done: tuple[dt.date, dt.time]           # collected or studied, in the clinic's zone
    reason: str
    values: tuple[tuple[str, str], ...] = ()
    findings: tuple[str, ...] = ()
    impression: str | None = None

    @property
    def category(self) -> str:
        return "RAD" if self.findings else "LAB"


def _cmp(glucose: str, bun: str, creatinine: str, sodium: str, potassium: str, chloride: str,
         co2: str, calcium: str, protein: str, albumin: str, bilirubin: str, alp: str,
         alt: str, ast: str, egfr: str) -> tuple[tuple[str, str], ...]:
    return (("2345-7", glucose), ("3094-0", bun), ("2160-0", creatinine), ("2951-2", sodium),
            ("2823-3", potassium), ("2075-0", chloride), ("2028-9", co2), ("17861-6", calcium),
            ("2885-2", protein), ("1751-7", albumin), ("1975-2", bilirubin), ("6768-6", alp),
            ("1742-6", alt), ("1920-8", ast), ("98979-8", egfr))


def _bmp(glucose: str, bun: str, creatinine: str, sodium: str, potassium: str, chloride: str,
         co2: str, calcium: str, egfr: str) -> tuple[tuple[str, str], ...]:
    return (("2345-7", glucose), ("3094-0", bun), ("2160-0", creatinine), ("2951-2", sodium),
            ("2823-3", potassium), ("2075-0", chloride), ("2028-9", co2), ("17861-6", calcium),
            ("98979-8", egfr))


def _cbc(wbc: str, rbc: str, hgb: str, hct: str, mcv: str, plt: str
         ) -> tuple[tuple[str, str], ...]:
    return (("6690-2", wbc), ("789-8", rbc), ("718-7", hgb), ("4544-3", hct), ("787-2", mcv),
            ("777-3", plt))


def _lipids(total: str, hdl: str, ldl: str, tg: str) -> tuple[tuple[str, str], ...]:
    """LDL by the Friedewald calculation: total - HDL - triglycerides / 5, as 13457-7 says."""
    return (("2093-3", total), ("2085-9", hdl), ("13457-7", ldl), ("2571-8", tg))


def _spiro(fev1: str, fvc: str, ratio: str, predicted: str, fev1_post: str, ratio_post: str
           ) -> tuple[tuple[str, str], ...]:
    return (("20150-9", fev1), ("19870-5", fvc), ("19926-5", ratio), ("20152-5", predicted),
            ("20155-8", fev1_post), ("69970-2", ratio_post))


D, T = dt.date, dt.time
MORNING = T(10, 0)   # the visit starts at 09:30; blood is drawn after the visit
#: The order is signed this long after the visit starts; nothing is collected before it.
SIGNED_AFTER = dt.timedelta(minutes=20)
#: The studies, by patient. Robert Miller's A1c, LDL and potassium match his signed notes (A1c
#: 7.9, 7.2, 7.1%; March's 7.4% was point-of-care at the visit; LDL 92 before and 66 after the
#: June atorvastatin increase); James Wilson's peak flows match his (410, 500, 530 L/min);
#: Patricia Davis's studies match hers (the mammogram on 7 April, the bone density scan on 9
#: July, lowest T-score -1.8 at the left hip).
STUDIES: tuple[Study, ...] = (
    # ------------------------------------------------- 2 Robert Miller, 68: diabetes, BP, lipids
    Study(2, D(2025, 12, 9), "4548-4", (D(2025, 12, 9), MORNING), "Type 2 diabetes",
          (("4548-4", "7.9"),)),
    Study(2, D(2025, 12, 9), "24331-1", (D(2025, 12, 9), MORNING), "Hyperlipidemia",
          _lipids("182", "42", "108", "160")),
    Study(2, D(2025, 12, 9), "24323-8", (D(2025, 12, 9), MORNING), "Diabetes and hypertension",
          _cmp("148", "18", "1.02", "139", "4.4", "102", "25", "9.4", "7.0", "4.2", "0.6", "72",
               "24", "22", "80")),
    Study(2, D(2025, 12, 9), "9318-7", (D(2025, 12, 9), MORNING), "Diabetes: kidney screen",
          (("9318-7", "18"),)),
    Study(2, D(2026, 3, 10), "24321-2", (D(2026, 3, 24), T(8, 30)),
          "Potassium and creatinine after the lisinopril increase",
          _bmp("136", "19", "1.05", "140", "4.6", "103", "25", "9.5", "78")),
    Study(2, D(2026, 6, 16), "4548-4", (D(2026, 6, 16), MORNING), "Type 2 diabetes",
          (("4548-4", "7.2"),)),
    Study(2, D(2026, 6, 16), "24331-1", (D(2026, 6, 16), MORNING), "Hyperlipidemia",
          _lipids("168", "44", "92", "158")),
    Study(2, D(2026, 9, 15), "4548-4", (D(2026, 9, 15), MORNING), "Type 2 diabetes",
          (("4548-4", "7.1"),)),
    Study(2, D(2026, 9, 15), "24331-1", (D(2026, 9, 15), MORNING),
          "Hyperlipidemia on atorvastatin 40 mg", _lipids("138", "45", "66", "135")),
    Study(2, D(2026, 9, 15), "24321-2", (D(2026, 9, 15), MORNING), "Diabetes and hypertension",
          _bmp("128", "17", "1.03", "140", "4.5", "102", "26", "9.4", "79")),
    Study(2, D(2026, 9, 15), "9318-7", (D(2026, 9, 15), MORNING), "Diabetes: kidney screen",
          (("9318-7", "16"),)),
    # ------------------------------------------------ 3 Linda Thompson, 57: chronic back pain
    Study(3, D(2025, 11, 18), "24323-8", (D(2025, 11, 18), MORNING),
          "Before regular naproxen",
          _cmp("92", "14", "0.78", "140", "4.1", "104", "26", "9.3", "7.1", "4.3", "0.5", "68",
               "19", "20", "89")),
    Study(3, D(2025, 11, 18), "4537-7", (D(2025, 11, 18), MORNING), "Chronic low back pain",
          (("4537-7", "12"),)),
    Study(3, D(2025, 11, 18), "1988-5", (D(2025, 11, 18), MORNING), "Chronic low back pain",
          (("1988-5", "2.1"),)),
    Study(3, D(2026, 2, 24), "4537-7", (D(2026, 2, 24), MORNING), "Chronic low back pain",
          (("4537-7", "10"),)),
    Study(3, D(2026, 2, 24), "1988-5", (D(2026, 2, 24), MORNING), "Chronic low back pain",
          (("1988-5", "1.8"),)),
    Study(3, D(2026, 2, 24), "30679-5", (D(2026, 3, 10), T(11, 0)),
          "Chronic low back pain for more than 12 weeks",
          findings=("Technique: multiplanar, multisequence MRI of the lumbar spine without "
                    "contrast.",
                    "Findings: normal alignment and vertebral body heights. Disc desiccation "
                    "and mild loss of disc height at L4-L5 and L5-S1, with small broad-based "
                    "disc bulges. No disc extrusion. The spinal canal, lateral recesses and "
                    "neural foramina are patent at every level; no nerve root compression. "
                    "Conus ends normally at L1."),
          impression="Degenerative disc disease at L4-L5 and L5-S1. No spinal stenosis and no "
                     "nerve root compression."),
    # ---------------------------------------------- 4 James Wilson, 45: asthma, allergic rhinitis
    Study(4, D(2025, 12, 2), "57021-8", (D(2025, 12, 2), MORNING), "Asthma",
          _cbc("7.4", "5.0", "15.1", "44.5", "89", "245") + (("711-2", "0.52"), ("713-8", "7.0"))),
    Study(4, D(2025, 12, 2), "81459-0", (D(2025, 12, 2), T(10, 30)), "Asthma, not controlled",
          _spiro("3.02", "4.38", "69", "76", "3.48", "76")),
    Study(4, D(2025, 12, 2), "19935-6", (D(2025, 12, 2), MORNING), "Asthma",
          (("19935-6", "410"),)),
    Study(4, D(2025, 12, 2), "36643-5", (D(2025, 12, 2), T(14, 0)),
          "Asthma with recurrent wheeze",
          findings=("Technique: PA and lateral views of the chest.",
                    "Findings: the lungs are clear, with no consolidation, effusion or "
                    "pneumothorax. Normal heart size and mediastinal contours. No "
                    "hyperinflation."),
          impression="Normal chest radiograph."),
    Study(4, D(2026, 3, 31), "19935-6", (D(2026, 3, 31), MORNING), "Asthma on controller",
          (("19935-6", "500"),)),
    Study(4, D(2026, 8, 11), "81459-0", (D(2026, 8, 11), T(10, 30)), "Asthma on controller",
          _spiro("3.52", "4.45", "79", "88", "3.66", "82")),
    Study(4, D(2026, 8, 11), "19935-6", (D(2026, 8, 11), MORNING), "Asthma on controller",
          (("19935-6", "530"),)),
    # ---------------------------------- 5 Patricia Davis, 61: breast cancer survivor, anastrozole
    Study(5, D(2026, 1, 13), "58410-2", (D(2026, 1, 13), MORNING), "Oncology follow-up",
          _cbc("5.8", "4.4", "13.2", "39.4", "90", "228")),
    Study(5, D(2026, 1, 13), "24323-8", (D(2026, 1, 13), MORNING), "Oncology follow-up",
          _cmp("94", "15", "0.82", "141", "4.2", "104", "26", "9.6", "7.0", "4.3", "0.5", "78",
               "21", "23", "82")),
    Study(5, D(2026, 1, 13), "6875-9", (D(2026, 1, 13), MORNING), "Oncology follow-up",
          (("6875-9", "18"),)),
    Study(5, D(2026, 1, 13), "2039-6", (D(2026, 1, 13), MORNING), "Oncology follow-up",
          (("2039-6", "1.6"),)),
    Study(5, D(2026, 1, 13), "26346-7", (D(2026, 4, 7), T(9, 0)),
          "Personal history of left breast cancer: yearly surveillance",
          findings=("Technique: bilateral diagnostic mammogram, craniocaudal and mediolateral "
                    "oblique views, with digital breast tomosynthesis.",
                    "Findings: scattered areas of fibroglandular density. Post-lumpectomy "
                    "architectural distortion and surgical clips in the upper outer left "
                    "breast, unchanged from the prior study. No suspicious mass, "
                    "calcifications or new distortion in either breast."),
          impression="Benign post-treatment changes in the left breast. BI-RADS 2: benign. "
                     "Yearly mammogram."),
    Study(5, D(2026, 4, 21), "38268-9", (D(2026, 7, 9), T(9, 0)),
          "Bone density on an aromatase inhibitor (anastrozole)",
          findings=("Technique: DXA of the lumbar spine (L1-L4) and both hips.",
                    "Findings: lumbar spine T-score -1.2. Left femoral neck T-score -1.8, left "
                    "total hip -1.5. Right femoral neck -1.6, right total hip -1.3. No prior "
                    "study for comparison."),
          impression="Osteopenia; lowest T-score -1.8 at the left femoral neck. Repeat in two "
                     "years."),
    Study(5, D(2026, 7, 28), "58410-2", (D(2026, 7, 28), MORNING), "Oncology follow-up",
          _cbc("6.1", "4.5", "13.4", "40.1", "89", "235")),
    Study(5, D(2026, 7, 28), "24323-8", (D(2026, 7, 28), MORNING), "Oncology follow-up",
          _cmp("91", "16", "0.80", "140", "4.3", "103", "27", "9.8", "7.1", "4.4", "0.6", "81",
               "20", "22", "84")),
    Study(5, D(2026, 7, 28), "6875-9", (D(2026, 7, 28), MORNING), "Oncology follow-up",
          (("6875-9", "17"),)),
    Study(5, D(2026, 7, 28), "2039-6", (D(2026, 7, 28), MORNING), "Oncology follow-up",
          (("2039-6", "1.5"),)),
    # -------------------------------------------- 6 David Nguyen, 39: migraine (restricted)
    Study(6, D(2025, 12, 16), "58410-2", (D(2025, 12, 16), MORNING), "Migraine work-up",
          _cbc("6.6", "5.1", "15.4", "45.2", "88", "260")),
    Study(6, D(2025, 12, 16), "3016-3", (D(2025, 12, 16), MORNING), "Migraine work-up",
          (("3016-3", "1.8"),)),
    Study(6, D(2025, 12, 16), "30657-1", (D(2026, 1, 6), T(8, 0)),
          "Migraine with a change in headache pattern",
          findings=("Technique: multiplanar, multisequence MRI of the brain without contrast, "
                    "including diffusion-weighted imaging.",
                    "Findings: no acute infarct, hemorrhage or mass. Ventricles and sulci are "
                    "normal for age. No midline shift. Normal flow voids. Paranasal sinuses "
                    "and mastoids are clear."),
          impression="No acute intracranial abnormality. Normal MRI of the brain."),
    Study(6, D(2026, 8, 25), "58410-2", (D(2026, 8, 25), MORNING),
          "Migraine on propranolol prophylaxis",
          _cbc("6.4", "5.0", "15.2", "44.8", "88", "252")),
    # --------------------------------------------- 7 Maria Gonzalez, 72: COPD, knee arthritis
    Study(7, D(2025, 11, 25), "81459-0", (D(2025, 11, 25), T(10, 30)), "COPD",
          _spiro("1.18", "2.12", "56", "57", "1.24", "57")),
    Study(7, D(2025, 11, 25), "36643-5", (D(2025, 11, 25), T(14, 0)), "COPD",
          findings=("Technique: PA and lateral views of the chest.",
                    "Findings: hyperinflated lungs with flattened hemidiaphragms and an "
                    "increased retrosternal air space. No consolidation, effusion or "
                    "pneumothorax. Normal heart size."),
          impression="Hyperinflation in keeping with COPD. No acute cardiopulmonary disease."),
    Study(7, D(2026, 2, 17), "36310-1", (D(2026, 2, 19), T(10, 0)),
          "Bilateral knee pain, primary osteoarthritis",
          findings=("Technique: AP standing, lateral and sunrise views of both knees.",
                    "Findings: moderate narrowing of the medial tibiofemoral joint space in "
                    "both knees, worse on the right, with marginal osteophytes and "
                    "subchondral sclerosis. Mild patellofemoral narrowing. No fracture or "
                    "effusion."),
          impression="Moderate bilateral knee osteoarthritis, medial compartment predominant."),
    Study(7, D(2026, 9, 8), "81459-0", (D(2026, 9, 8), T(10, 30)), "COPD",
          _spiro("1.15", "2.08", "55", "56", "1.21", "57")),
)


def performed(s: Study) -> dt.datetime:
    return dt.datetime.combine(s.done[0], s.done[1], tzinfo=CLINIC_ZONE)


def issued(s: Study) -> dt.datetime:
    """Reported four hours after collection, six after an imaging study."""
    return performed(s) + dt.timedelta(hours=6 if s.category == "RAD" else 4)


def _sex(n: int) -> str:
    return next("F" if p.gender == "female" else "M" for p in PATIENTS if p.n == n)


def _result(n: int, code: str, value: str) -> fs.ResultIn:
    unit, low, high = RANGES.get((code, _sex(n))) or RANGES[(code, "")]
    v = Decimal(value)
    flag = ("H" if high is not None and v > Decimal(high)
            else "L" if low is not None and v < Decimal(low) else None)
    return fs.ResultIn(loinc(code), fs.Measured(v, unit),
                       low=Decimal(low) if low is not None else None,
                       high=Decimal(high) if high is not None else None, flag=flag)


def _narrative(text_: str) -> fs.ResultIn:
    return fs.ResultIn(loinc("18782-3"), text=text_)


async def _visit(db: AsyncSession, n: int, day: dt.date) -> uuid.UUID:
    """The past visit's encounter, found through its booking's fixed ID (history's numbering),
    never its start time, which moved with the clinic (#329)."""
    i = next(i for i, v in enumerate(HISTORY[n].visits, start=1) if v.day == day)
    found: uuid.UUID = (await db.execute(text(
        "SELECT id FROM clinical.encounter WHERE appointment_id = :a "
        "AND status <> 'entered-in-error'"),
        {"a": sid(PAST_APPOINTMENT, n * 10 + i)})).scalar_one()
    return found


async def load_results(engine: AsyncEngine) -> int:
    """Writes the studies of each history patient who has none yet; returns how many patients
    it wrote to. As shri_migrator, in the demo clinic, as the demo doctor."""
    store, written = fs.SqlFhirStore(), set()
    async with AsyncSession(engine, expire_on_commit=False) as db, db.begin():
        db.info[TENANT_ID_INFO_KEY] = CLINIC_A
        await db.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))
        await db.execute(text(
            "SELECT set_config('app.current_tenant_id', :t, true), "
            "set_config('app.correlation_id', 'seed-results', true)"), {"t": str(CLINIC_A)})
        await _as_user(db, DOCTOR_USER)
        for org_id, name in PERFORMERS:
            if await db.get(M["organization"], org_id) is None:
                db.add(M["organization"](id=org_id, tenant_id=CLINIC_A, name=name,
                                         type_system=systems.ORGANIZATION_TYPE,
                                         type_code="prov"))
        await db.flush()
        for k, s in enumerate(STUDIES, start=1):
            if await _exists(db, "SELECT 1 FROM clinical.diagnostic_report WHERE id = :r",
                             r=sid(LAB_REPORT, k)):
                continue
            encounter = await _visit(db, s.patient, s.ordered_at)
            order_start = next(v.start for v in HISTORY[s.patient].visits
                               if v.day == s.ordered_at)
            await store.record_order(db, fs.OrderIn(
                id=sid(LAB_ORDER, k), patient_id=sid(PATIENT, s.patient),
                encounter_id=encounter, code=loinc(s.code),
                category="imaging" if s.category == "RAD" else "laboratory",
                requester_practitioner_id=DOCTOR,
                signed_at=order_start + SIGNED_AFTER, reason=s.reason))
            results = (tuple(_narrative(t) for t in s.findings) if s.findings
                       else tuple(_result(s.patient, c, v) for c, v in s.values))
            await store.record_report(db, fs.ReportIn(
                id=sid(LAB_REPORT, k), patient_id=sid(PATIENT, s.patient),
                encounter_id=encounter, order_id=sid(LAB_ORDER, k), category=s.category,
                code=loinc(s.code), effective=performed(s),
                issued=issued(s), performer_organization_id=RADIOLOGY if s.findings else LAB,
                results=results, conclusion=s.impression))
            written.add(s.patient)
    return len(written)


def run(engine: Engine) -> int:
    """``load_results`` for the seed's synchronous callers, on the same database and login."""
    async_engine = create_async_engine(engine.url.set(drivername="postgresql+psycopg"),
                                       poolclass=NullPool)

    async def go() -> int:
        try:
            return await load_results(async_engine)
        finally:
            await async_engine.dispose()

    return asyncio.run(go())
