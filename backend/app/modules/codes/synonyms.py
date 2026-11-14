"""ICD-10-CM search synonyms (audit V3): common abbreviations and everyday terms mapped to the
wording ICD-10-CM uses, so "COPD" finds "Chronic obstructive pulmonary disease" and "high blood
pressure" finds I10.

Query expansion only. The search runs the typed words as before and the mapped wording beside
them, and a match is scored by whichever of the two it fits better
(``app.db.terminology.search``). A term expands only when the whole query is that term, ignoring
case and spacing; anything typed around it, and any term not listed here, is searched as typed.
Every mapped wording is words that appear in the names of the codes it is meant to find, so it
adds no code of its own.

``FOR_CLINICAL_REVIEW`` holds the terms whose meaning a clinical advisor should settle (Q23). Those
not in ``SYNONYMS`` are not expanded at all; those in it are expanded to their literal meaning
only, and the question is about what else should come up.
"""
from __future__ import annotations

#: Everyday term or abbreviation, lower case, single-spaced -> ICD-10-CM wording.
SYNONYMS: dict[str, str] = {
    # Circulation
    "hypertension": "essential (primary) hypertension",
    "high blood pressure": "essential (primary) hypertension",
    "htn": "essential (primary) hypertension",
    "heart attack": "acute myocardial infarction",
    "mi": "acute myocardial infarction",
    "heart failure": "heart failure, unspecified",
    "chf": "heart failure, unspecified",
    "afib": "atrial fibrillation",
    "a fib": "atrial fibrillation",
    "a-fib": "atrial fibrillation",
    "dvt": "deep vein thrombosis",
    "stroke": "cerebral infarction",
    "high cholesterol": "hypercholesterolemia",
    # Breathing
    "copd": "chronic obstructive pulmonary disease",
    "flu": "influenza",
    "uri": "acute upper respiratory infection",
    "strep throat": "streptococcal pharyngitis",
    "osa": "obstructive sleep apnea",
    # Metabolism
    "type 2 diabetes": "type 2 diabetes mellitus without complications",
    "diabetes type 2": "type 2 diabetes mellitus without complications",
    "type ii diabetes": "type 2 diabetes mellitus without complications",
    "t2dm": "type 2 diabetes mellitus without complications",
    "dm2": "type 2 diabetes mellitus without complications",
    "t1dm": "type 1 diabetes mellitus without complications",
    "hypothyroid": "hypothyroidism, unspecified",
    # Digestion, kidneys
    "gerd": "gastro-esophageal reflux disease",
    "acid reflux": "gastro-esophageal reflux disease",
    "uti": "urinary tract infection",
    "ckd": "chronic kidney disease",
    "kidney stone": "calculus of kidney",
    "kidney stones": "calculus of kidney",
    # Bones and joints
    "oa": "osteoarthritis",
    "knee osteoarthritis": "osteoarthritis of knee",
    "ra": "rheumatoid arthritis",
    # Cancer: the active disease, literally (see FOR_CLINICAL_REVIEW)
    "breast cancer": "malignant neoplasm of breast",
    "lung cancer": "malignant neoplasm of bronchus or lung",
    "prostate cancer": "malignant neoplasm of prostate",
    "colon cancer": "malignant neoplasm of colon",
    # Mind, symptoms
    "gad": "generalized anxiety disorder",
    "fever": "fever, unspecified",
    "pink eye": "conjunctivitis",
}

#: Terms a clinical advisor should settle, with the question. Not a mapping.
FOR_CLINICAL_REVIEW: dict[str, str] = {
    "breast cancer": "expanded to the active disease (C50); should a past cancer (Z85.3, "
                     "personal history) also come first for some clinics?",
    "lung cancer": "as breast cancer (C34 against Z85.118)",
    "prostate cancer": "as breast cancer (C61 against Z85.46)",
    "colon cancer": "as breast cancer (C18 against Z85.038)",
    "depression": "not expanded: F32.A (depression, unspecified), F32.9 (single episode) or "
                  "F33.9 (recurrent)? The typed word already finds F32.A",
    "stroke": "expanded to cerebral infarction (I63); should a past stroke (Z86.73) or late "
              "effects (I69) also come up?",
    "mi": "expanded to acute myocardial infarction (I21); old MI is I25.2. Also a common "
          "abbreviation of mitral insufficiency",
    "ra": "expanded to rheumatoid arthritis; also right atrium in some notes",
    "chf": "expanded to heart failure, unspecified (I50.9); systolic or diastolic (I50.2x, "
           "I50.3x) need the clinician's choice",
    "osteoarthritis": "not expanded: the typed word lists hip (M16) and knee (M17) first; "
                      "should one joint, or primary osteoarthritis (M19.9x), come first?",
    "hypertension": "expanded to I10 first; hypertensive heart or kidney disease (I11, I12, "
                    "I13) and pregnancy (O10) still come up below it",
}


def normalize(q: str) -> str:
    return " ".join(q.split()).lower()


def expand(system: str, q: str) -> str | None:
    """The ICD-10-CM wording to search beside the query, or None (other systems never expand)."""
    if system != "icd-10-cm":
        return None
    return SYNONYMS.get(normalize(q))
