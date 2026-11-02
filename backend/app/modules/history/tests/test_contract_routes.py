"""The history module's allergy operations (inventory #94-97, #250; demo step 7) are built or
still pending. Problems, family, social and surgical history join this list as their PRs land.
"""

from app.modules.patients.tests.contract_routes import progress_problems

MODULE = "history"

ALLERGIES = frozenset({
    "listAllergies",
    "getAllergy",
    "addAllergy",
    "updateAllergy",
    "markAllergyEnteredInError",
})
PENDING: frozenset[str] = frozenset()


def test_allergy_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, ALLERGIES, PENDING) == []
