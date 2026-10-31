"""The encounters module's rooming operations (demo step 7, IMPL_BATCH1_PLAN §8.3 PR-5) and its
check-out ones (demo steps 10-11, D98: the follow-up request and the after-visit summary) are
built or still pending. The rest of batch 2 (notes, diagnoses, close) joins this list as its PRs
land.
"""

from app.modules.patients.tests.contract_routes import progress_problems

MODULE = "encounters"

PROMISED = frozenset({
    "getEncounter",
    "updateEncounter",
    "recordVitals",
    "listPatientVitals",
    "markVitalEnteredInError",
    "setFollowUpRequest",
    "withdrawFollowUpRequest",
    "declineFollowUpRequest",
    "createAfterVisitSummary",
    "getAfterVisitSummaryDownloadUrl",
})

# Not built yet: markVitalEnteredInError needs a write helper for a vital's entered-in-error
# (with its Provenance), which app.db.fhir_store does not have yet (note for Anand).
# declineFollowUpRequest and getAfterVisitSummaryDownloadUrl are built (api.mount_pending_routes)
# but mounted only once core's catalogue has their permissions (T50, note for Thulasi).
PENDING = frozenset({
    "markVitalEnteredInError",
    "declineFollowUpRequest",
    "getAfterVisitSummaryDownloadUrl",
})


def test_rooming_and_check_out_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, PROMISED, PENDING) == []
