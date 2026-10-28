"""The patients module's batch 1 operations are built or still pending
(contracts/docs/IMPL_BATCH1_PLAN.md §4.2).
"""

from fastapi import FastAPI

from .contract_routes import make_app, progress_problems, route_walk_problems

MODULE = "patients"

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
# still listed here. PR-1 builds patients core (plan §5).
BUILT_IN_PR_1 = frozenset({
    "searchPatients",
    "registerPatient",
    "getPatient",
    "listPatientIdentifiers",
    "addPatientIdentifier",
    "listRelatedPersons",
    "addRelatedPerson",
    "updateRelatedPerson",
    "updatePatient",
    "getPatientSummaries",
    "restrictPatient",
    "unrestrictPatient",
})
PENDING = BATCH_1 - BUILT_IN_PR_1


def test_batch_1_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, BATCH_1, PENDING) == []


def test_the_route_walk_finds_routes_inside_included_routers() -> None:
    """Fails if the walk ever finds nothing again (the first version of this file did)."""
    assert route_walk_problems(make_app()) == []


def test_the_walk_guard_fails_on_an_app_with_no_routes() -> None:
    empty = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
    assert route_walk_problems(empty) != []
