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
    "recordVisitStatus",
})


# B8a (D89), x-owner Vimal: the patient portal's scheduling operations. Served by
# portal_api.py as they are built.
PORTAL_B8A = frozenset({
    "listPortalAppointments",
    "getPortalAppointment",
    "bookPortalAppointment",
    "cancelPortalAppointment",
    "reschedulePortalAppointment",
    "listPortalBookingFacilities",
    "listPortalBookingAppointmentTypes",
    "listPortalBookingProviders",
    "listPortalBookingSlots",
})
PORTAL_PENDING = PORTAL_B8A - {"listPortalAppointments", "getPortalAppointment"}


def test_batch_1_and_portal_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, BATCH_1 | PORTAL_B8A, PENDING | PORTAL_PENDING) == []
