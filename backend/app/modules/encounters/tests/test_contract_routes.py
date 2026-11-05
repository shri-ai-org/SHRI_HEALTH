"""The encounters module's rooming operations (demo step 7, IMPL_BATCH1_PLAN §8.3 PR-5), the
doctor's part of the visit (demo step 8) and its check-out ones (demo steps 10-11, D98: the
follow-up request and the after-visit summary) are built or still pending.
"""

from app.core.permissions import is_known_permission
from app.modules.patients.tests.contract_routes import progress_problems

from ..api import PENDING_PERMISSIONS

MODULE = "encounters"

ROOMING = frozenset({
    "getEncounter",
    "updateEncounter",
    "recordVitals",
    "listPatientVitals",
    "markVitalEnteredInError",
    "listPatientEncounters",
})

PENDING: frozenset[str] = frozenset()


# The doctor's part of the visit (demo step 8, IMPL_BATCH1_PLAN §8.3 PR-9).
NOTES = frozenset({
    "addEncounterDiagnosis", "removeEncounterDiagnosis", "markDiagnosisEnteredInError",
    "createNote", "listEncounterNotes", "getNote", "updateNoteDraft", "signNote",
    "addNoteAddendum", "listNoteVersions", "closeEncounter", "cosignNote",
    "markNoteEnteredInError",
})
NOTES_PENDING: frozenset[str] = frozenset()


# Check-out (demo steps 10-11, D98).
CHECK_OUT = frozenset({
    "setFollowUpRequest",
    "withdrawFollowUpRequest",
    "declineFollowUpRequest",
    "createAfterVisitSummary",
    "getAfterVisitSummaryDownloadUrl",
})
# declineFollowUpRequest and getAfterVisitSummaryDownloadUrl are built (api.mount_pending_routes)
# but mounted only once core's catalogue has their permissions (T50); pending until then.
CHECK_OUT_PENDING = frozenset(operation for operation, permission in PENDING_PERMISSIONS.items()
                              if not is_known_permission(permission))


def test_rooming_notes_and_check_out_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, ROOMING | NOTES | CHECK_OUT,
                             PENDING | NOTES_PENDING | CHECK_OUT_PENDING) == []
