"""The prescription safety rules (D97, D99): fixed rules in code, each a pure function with its
own tests (tests/test_rules.py). No model produces, ranks or suppresses an alert.

- **Allergy** (``allergy_alerts``): an active allergy, not entered-in-error or refuted, to an
  RxNorm ingredient of the drug. Severity ``high``: signing needs an override with a reason.
- **Duplicate medication** (``duplicate_alerts``): an active entry on the medication list (a
  medication the patient reported, or a signed prescription) with an ingredient of the drug.
  Severity ``warning``.

The facts come from the repository: each drug's, allergy's and list entry's ingredients are its
RxNorm ingredient codes from Anand's terminology tables (``ingredient`` properties of RxNorm
Current Prescribable Content); a code with none stands for itself. A drug written as text alone
has no ingredients, so no rule can match it. Drug classes (a penicillin allergy against
amoxicillin, which share no ingredient) are not in RxNorm's ingredient relations, so they are not
matched here.

The severities are the contract's and the platform rules' (``admin.cds_rule``, migration 0013:
``allergy`` high with a required override, ``duplicate-medication`` moderate, i.e. ``warning``).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from uuid import UUID

ALLERGY = "allergy"  # the cds_rule code and the contract's alert kind
DUPLICATE = "duplicate-medication"
SEVERITY = {ALLERGY: "high", DUPLICATE: "warning"}
MESSAGE_MAX = 500  # SafetyAlert.message maxLength
#: An allergy that doesn't count: entered by mistake, or ruled out.
NOT_AN_ALLERGY = frozenset({"entered-in-error", "refuted"})


@dataclass(frozen=True)
class Drug:
    name: str
    ingredients: frozenset[str]
    ingredient_names: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Allergy:
    id: UUID
    clinical_status: str | None  # active | inactive | resolved
    verification_status: str | None  # unconfirmed | confirmed | refuted | entered-in-error
    name: str
    ingredients: frozenset[str]


@dataclass(frozen=True)
class ListEntry:
    id: UUID
    status: str  # active | completed | stopped | entered-in-error ...
    name: str
    ingredients: frozenset[str]


@dataclass(frozen=True)
class Alert:
    rule_code: str
    kind: str
    severity: str
    message: str
    allergy_id: UUID | None = None
    medication_id: UUID | None = None


def _names(drug: Drug, codes: Iterable[str]) -> str:
    return ", ".join(sorted(drug.ingredient_names.get(c, f"RxNorm {c}") for c in codes))


def _fit(message: str) -> str:
    return message if len(message) <= MESSAGE_MAX else message[:MESSAGE_MAX - 1] + "…"


def counts_as_allergy(allergy: Allergy) -> bool:
    return (allergy.clinical_status == "active"
            and allergy.verification_status not in NOT_AN_ALLERGY)


def allergy_alerts(drug: Drug, allergies: Iterable[Allergy]) -> list[Alert]:
    """One ``high`` alert per active allergy that shares an RxNorm ingredient with the drug."""
    found = []
    for allergy in allergies:
        shared = drug.ingredients & allergy.ingredients
        if shared and counts_as_allergy(allergy):
            found.append(Alert(
                rule_code=ALLERGY, kind=ALLERGY, severity=SEVERITY[ALLERGY],
                message=_fit(f"Active allergy to {allergy.name}; {drug.name} contains "
                             f"{_names(drug, shared)}."),
                allergy_id=allergy.id))
    return found


def duplicate_alerts(drug: Drug, entries: Iterable[ListEntry]) -> list[Alert]:
    """One ``warning`` alert per active list entry that shares an RxNorm ingredient with the
    drug."""
    found = []
    for entry in entries:
        shared = drug.ingredients & entry.ingredients
        if shared and entry.status == "active":
            found.append(Alert(
                rule_code=DUPLICATE, kind=DUPLICATE, severity=SEVERITY[DUPLICATE],
                message=_fit(f"{entry.name} is already on the active medication list "
                             f"(same ingredient: {_names(drug, shared)})."),
                medication_id=entry.id))
    return found


def check(drug: Drug, allergies: Iterable[Allergy], entries: Iterable[ListEntry]
          ) -> list[Alert]:
    """Every rule, allergies first."""
    return allergy_alerts(drug, allergies) + duplicate_alerts(drug, entries)
