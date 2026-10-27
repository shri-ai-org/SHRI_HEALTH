"""The patients module's routes match the contract, and its batch 1 operations are built or pending
(contracts/docs/IMPL_BATCH1_PLAN.md §4.2).
"""

from .contract_routes import progress_problems, route_problems

MODULE = "patients"
TAG = "patients"

# Batch 1: every P0 operation tagged `patients` (IMPL_BATCH1_PLAN.md §2).
BATCH_1 = frozenset({
    "searchPatients",
    "registerPatient",
    "getPatient",
    "updatePatient",
    "listPatientIdentifiers",
    "addPatientIdentifier",
    "listRelatedPersons",
    "addRelatedPerson",
    "updateRelatedPerson",
    "listCoverages",
    "addCoverage",
    "updateCoverage",
    "attachCoverageCardImage",
    "markCoverageEnteredInError",
    "listConsents",
    "recordConsent",
    "setPreferredPharmacy",
    "restrictPatient",
    "unrestrictPatient",
    "listDuplicates",
    "mergeDuplicate",
    "dismissDuplicate",
    "undoPatientMerge",
    "listPatientMerges",
    "getPatientSummaries",
})

# Not built yet. Each PR removes the operations it builds; the test fails if a built one is
# still listed here.
PENDING = BATCH_1


def test_routes_match_the_contract() -> None:
    assert route_problems(MODULE, TAG) == []


def test_batch_1_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, BATCH_1, PENDING) == []
