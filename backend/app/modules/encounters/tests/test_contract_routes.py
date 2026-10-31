"""The encounters module's patient-portal operations (B8a, D89) are built or still pending."""

from app.modules.patients.tests.contract_routes import progress_problems

MODULE = "encounters"

PORTAL_B8A = frozenset({
    "listPortalVisitSummaries",
    "getPortalVisitSummary",
    "getPortalVisitSummaryDownloadUrl",
})
# The PDF link waits for Anand's after-visit summary (#157) and a patient download route (D105).
PORTAL_PENDING = frozenset({"getPortalVisitSummaryDownloadUrl"})


def test_portal_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, PORTAL_B8A, PORTAL_PENDING) == []
