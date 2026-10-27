"""The eligibility module's routes match the contract, and its batch 1 operations are built or
pending (contracts/docs/IMPL_BATCH1_PLAN.md §4.2).
"""

from app.modules.patients.tests.contract_routes import progress_problems, route_problems

MODULE = "eligibility"
TAG = "eligibility"

# Batch 1: every P0 operation tagged `eligibility` (IMPL_BATCH1_PLAN.md §2).
BATCH_1 = frozenset({
    "runEligibilityCheck",
    "getEligibilityCheck",
    "listAppointmentEligibilityChecks",
})

# Not built yet. Each PR removes the operations it builds; the test fails if a built one is
# still listed here.
PENDING = BATCH_1


def test_routes_match_the_contract() -> None:
    assert route_problems(MODULE, TAG) == []


def test_batch_1_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, BATCH_1, PENDING) == []
