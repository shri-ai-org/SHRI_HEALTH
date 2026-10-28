"""The duplicate check at registration (matching.py). Synthetic names only (Synthea style)."""

from datetime import date

import pytest

from app.modules.patients.matching import (
    Person,
    match,
    name_similarity,
    normalize,
    possible_duplicates,
    within_one_edit,
)

BIRTH = date(1984, 7, 19)
RAMONA = Person(family="Kuhlman72", given=("Ramona980",), birth_date=BIRTH,
                phones=frozenset({"+12175550123"}))


def person(family: str = "Kuhlman72", given: tuple[str, ...] = ("Ramona980",),
           birth_date: date | None = BIRTH, phones: frozenset[str] = frozenset(),
           previous: tuple[str, ...] = ()) -> Person:
    return Person(family=family, given=given, birth_date=birth_date, phones=phones,
                  previous_families=previous)


def test_normalize_ignores_case_accents_spaces_and_punctuation() -> None:
    assert normalize("  O'Bríen-Smith ") == "obriensmith"


@pytest.mark.parametrize(("a", "b", "expected"), [
    ("kuhlman", "kuhlman", True), ("kuhlman", "kulman", True), ("kuhlman", "kuhlmann", True),
    ("kuhlman", "kuhlmen", True), ("kuhlman", "kohlmen", False), ("kuhlman", "hettinger", False),
])
def test_within_one_edit(a: str, b: str, expected: bool) -> None:
    assert within_one_edit(a, b) is expected
    assert within_one_edit(b, a) is expected


def test_same_name_and_birth_date_is_a_duplicate() -> None:
    found = match(person(), RAMONA)
    assert found is not None
    assert found.matched_on == ("name", "birth-date")
    assert found.score == 0.8


def test_same_name_and_phone_without_birth_date_is_a_duplicate() -> None:
    found = match(person(birth_date=date(1990, 1, 1), phones=frozenset({"+12175550123"})), RAMONA)
    assert found is not None
    assert found.matched_on == ("name", "phone")


def test_same_name_alone_is_not_a_duplicate() -> None:
    assert match(person(birth_date=date(1990, 1, 1)), RAMONA) is None


def test_same_birth_date_and_phone_with_another_name_is_not_a_duplicate() -> None:
    other = person(family="Hettinger94", given=("Alvina56",), phones=frozenset({"+12175550123"}))
    assert match(other, RAMONA) is None


def test_a_typo_in_a_long_family_name_still_matches_but_scores_lower() -> None:
    typo = match(person(family="Kuhlmen72"), RAMONA)
    exact = match(person(), RAMONA)
    assert typo is not None and exact is not None
    assert typo.score < exact.score


def test_short_family_names_must_match_exactly() -> None:
    assert name_similarity(person(family="Lee"), person(family="Lea")) == 0.0


def test_a_previous_name_matches_d57() -> None:
    married = person(family="Ortiz187", previous=("Kuhlman72",))
    assert match(person(), married) is not None


def test_an_initial_matches_its_given_name() -> None:
    assert match(person(given=("R",)), RAMONA) is not None
    assert match(person(given=("T",)), RAMONA) is None


def test_a_missing_given_name_does_not_rule_out_a_match() -> None:
    assert match(person(given=()), RAMONA) is not None


def test_candidates_come_highest_score_first() -> None:
    existing = {
        "b": person(family="Kuhlmen72"),
        "a": RAMONA,
        "c": person(family="Hettinger94", given=("Alvina56",)),
    }
    new = person(phones=frozenset({"+12175550123"}))
    ranked = possible_duplicates(new, existing)
    assert [pid for pid, _ in ranked] == ["a", "b"]
    assert ranked[0][1].matched_on == ("name", "birth-date", "phone")
    assert ranked[0][1].score == 1.0
