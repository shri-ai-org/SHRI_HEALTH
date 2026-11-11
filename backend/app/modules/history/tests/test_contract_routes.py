"""The history module's operations are built or still pending: the allergies (inventory #94-97,
#250; demo step 7) and the reads of problems, family, social and surgical history (#90, #249, #98,
#101, #104; the doctor's record screen). Their writes come after the demo.
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
HISTORY_READS = frozenset({
    "listProblems",
    "getProblem",
    "listFamilyHistory",
    "listSocialHistory",
    "listSurgicalHistory",
})
PENDING: frozenset[str] = frozenset()


def test_history_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, ALLERGIES | HISTORY_READS, PENDING) == []
