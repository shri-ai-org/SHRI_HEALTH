"""The duplicate check at registration (contracts: POST /patients; API_STANDARDS §9.3).

A registration is a possible duplicate of an existing patient when the names are similar **and** the
date of birth or a phone number is the same. Similar names: the same family name after normalizing
case, accents, spaces and punctuation, or one edit apart once it is at least five letters, or the
new family name matching one of the patient's previous names (D57); and the first given names agree
(the same, one an initial of the other, or one edit apart). Pure functions: the repository fetches
the patients that share a date of birth or a phone, and this module decides and scores.

The score (0 to 1) only orders candidates for review (`duplicate_candidate.match_score`); whether a
pair is a candidate is the rule above, never a threshold on the score.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from datetime import date

NAME_WEIGHT = 0.5
BIRTH_DATE_WEIGHT = 0.3
PHONE_WEIGHT = 0.2
SIMILAR_NAME = 0.8  # a near match counts for less than an exact one


@dataclass(frozen=True)
class Person:
    family: str
    given: tuple[str, ...]
    birth_date: date | None
    phones: frozenset[str] = field(default_factory=frozenset)  # E.164
    previous_families: tuple[str, ...] = ()


@dataclass(frozen=True)
class Match:
    score: float
    matched_on: tuple[str, ...]  # contract values: name, birth-date, phone


def normalize(text: str) -> str:
    """Lower case, accents removed, only letters kept: "O'Brien-Smith " -> "obriensmith"."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed.casefold() if c.isalpha())


def within_one_edit(a: str, b: str) -> bool:
    """True when a and b are equal or differ by one insertion, deletion or substitution."""
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    i = j = 0
    edited = False
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        if edited:
            return False
        edited = True
        if len(a) == len(b):
            i += 1
        j += 1
    return True


def _family_similarity(new: str, existing: Person) -> float:
    target = normalize(new)
    if not target:
        return 0.0
    for candidate in (existing.family, *existing.previous_families):
        if normalize(candidate) == target:
            return 1.0
    for candidate in (existing.family, *existing.previous_families):
        other = normalize(candidate)
        if min(len(target), len(other)) >= 5 and within_one_edit(target, other):
            return SIMILAR_NAME
    return 0.0


def _given_similarity(new: tuple[str, ...], existing: tuple[str, ...]) -> float:
    if not new or not existing:
        return SIMILAR_NAME  # a missing given name neither confirms nor rules out the match
    a, b = normalize(new[0]), normalize(existing[0])
    if not a or not b:
        return SIMILAR_NAME
    if a == b:
        return 1.0
    if len(a) == 1 or len(b) == 1:
        return SIMILAR_NAME if a[0] == b[0] else 0.0
    if within_one_edit(a, b):
        return SIMILAR_NAME
    return 0.0


def name_similarity(new: Person, existing: Person) -> float:
    family = _family_similarity(new.family, existing)
    if family == 0.0:
        return 0.0
    return min(family, _given_similarity(new.given, existing.given))


def match(new: Person, existing: Person) -> Match | None:
    """A Match when `existing` is a possible duplicate of `new`, otherwise None."""
    names = name_similarity(new, existing)
    if names == 0.0:
        return None
    same_birth_date = new.birth_date is not None and new.birth_date == existing.birth_date
    same_phone = bool(new.phones & existing.phones)
    if not (same_birth_date or same_phone):
        return None
    matched = ["name"]
    if same_birth_date:
        matched.append("birth-date")
    if same_phone:
        matched.append("phone")
    score = NAME_WEIGHT * names + BIRTH_DATE_WEIGHT * same_birth_date + PHONE_WEIGHT * same_phone
    return Match(score=round(min(score, 1.0), 4), matched_on=tuple(matched))


def possible_duplicates(new: Person, existing: dict[str, Person]) -> list[tuple[str, Match]]:
    """Every possible duplicate among `existing` (patient ID -> person), highest score first."""
    found = [(pid, m) for pid, person in existing.items() if (m := match(new, person)) is not None]
    return sorted(found, key=lambda pair: (-pair[1].score, pair[0]))
