"""The encounters module's rooming operations (demo step 7, IMPL_BATCH1_PLAN §8.3 PR-5) are built
or still pending. The rest of batch 2 (notes, diagnoses, close, follow-up) joins this list as its
PRs land.
"""

from app.modules.patients.tests.contract_routes import progress_problems

MODULE = "encounters"

ROOMING = frozenset({
    "getEncounter",
    "updateEncounter",
    "recordVitals",
    "listPatientVitals",
    "markVitalEnteredInError",
})

# Not built yet: markVitalEnteredInError needs a write helper for a vital's entered-in-error
# (with its Provenance), which app.db.fhir_store does not have yet (note for Anand).
PENDING = frozenset({
    "markVitalEnteredInError",
})


# The doctor's part of the visit (demo step 8, IMPL_BATCH1_PLAN §8.3 PR-9).
NOTES = frozenset({
    "addEncounterDiagnosis", "removeEncounterDiagnosis", "markDiagnosisEnteredInError",
    "createNote", "listEncounterNotes", "getNote", "updateNoteDraft", "signNote",
    "addNoteAddendum", "listNoteVersions", "closeEncounter", "cosignNote",
    "markNoteEnteredInError",
})
# markDiagnosisEnteredInError keeps the rank link, and app.db.fhir_store has no helper for a
# Condition's entered-in-error (note for Anand); markNoteEnteredInError is not on the demo path
# (D108).
NOTES_PENDING = frozenset({"markDiagnosisEnteredInError", "markNoteEnteredInError"})


def test_rooming_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, ROOMING | NOTES, PENDING | NOTES_PENDING) == []
