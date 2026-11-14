"""The ICD-10-CM search synonyms (audit V3): a curated map, applied to the whole query only."""
from __future__ import annotations

import pytest

from .. import synonyms


def test_every_term_is_stored_as_it_is_looked_up() -> None:
    for term, wording in synonyms.SYNONYMS.items():
        assert term == synonyms.normalize(term), term
        assert wording == " ".join(wording.split()) and wording, term
        assert synonyms.normalize(wording) != term, term       # an expansion adds wording


def test_the_map_stays_small_and_curated() -> None:
    assert 25 <= len(synonyms.SYNONYMS) <= 60


@pytest.mark.parametrize(("q", "wording"), [
    ("COPD", "chronic obstructive pulmonary disease"),
    ("  High   Blood Pressure ", "essential (primary) hypertension"),
    ("heart attack", "acute myocardial infarction"),
    ("breast cancer", "malignant neoplasm of breast"),
])
def test_case_and_spacing_do_not_matter(q: str, wording: str) -> None:
    assert synonyms.expand("icd-10-cm", q) == wording


@pytest.mark.parametrize(("system", "q"), [
    ("icd-10-cm", "copd with exacerbation"),   # only the whole query expands
    ("icd-10-cm", "asthma"),                   # not in the map: searched as typed
    ("icd-10-cm", "depression"),               # for clinical review, deliberately not mapped
    ("rxnorm", "flu"),                         # only ICD-10-CM expands
    ("snomed-ct", "copd"),
])
def test_nothing_else_expands(system: str, q: str) -> None:
    assert synonyms.expand(system, q) is None


def test_every_question_for_review_is_about_a_listed_or_deliberately_missing_term() -> None:
    for term, question in synonyms.FOR_CLINICAL_REVIEW.items():
        assert term == synonyms.normalize(term) and question
    unmapped = set(synonyms.FOR_CLINICAL_REVIEW) - set(synonyms.SYNONYMS)
    assert unmapped == {"depression", "osteoarthritis"}
