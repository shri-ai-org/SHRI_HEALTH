"""The scheduling module's batch 1 operations are built or still pending
(contracts/docs/IMPL_BATCH1_PLAN.md §4.2).
"""

from app.modules.patients.tests.contract_routes import progress_problems

MODULE = "scheduling"

# Batch 1: every P0 operation tagged `scheduling` (IMPL_BATCH1_PLAN.md §2).
BATCH_1 = frozenset({
    "listSlots",
    "listAppointments",
    "bookAppointment",
    "getAppointment",
    "updateAppointment",
    "cancelAppointment",
    "checkInAppointment",
    "recordVisitStatus",
    "getStatusBoard",
    "listBookableFacilities",
    "listBookableLocations",
    "listBookableProviders",
    "listBookableAppointmentTypes",
    "rescheduleAppointment",
    "undoCheckIn",
})

# Not built yet. Each PR removes the operations it builds; the test fails if a built one is
# still listed here.
PENDING = frozenset({
    "updateAppointment",
    "checkInAppointment",
    "recordVisitStatus",
    "undoCheckIn",
})


def test_batch_1_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, BATCH_1, PENDING) == []
