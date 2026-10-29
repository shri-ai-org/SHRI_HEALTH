"""Permission catalogue and role-to-permission matrix.

Source: contracts/docs/SECURITY_MODEL.md §4.2 (catalogue) and §4.3 (draft matrix), agreed in
issue #3 (T12–T14) with the additions from T13/T34. The matrix is a DRAFT: clinical rows
still need the clinical advisors' review. When the contract's x-permission values are
final, CATALOGUE is checked against them in CI.

Matrix rows the draft does not cover are filled in here and marked "gap" below; they need
Vimal's and the advisors' confirmation.
"""

import re
from collections.abc import Iterable

PERMISSION_FORMAT = re.compile(r"^[a-z][a-z-]*:[a-z][a-z-]*$")

# Special x-permission values (SECURITY_MODEL §1). Only "authenticated" goes through require();
# "public" endpoints have no dependency and "partner-signed" is checked by the hook verifier.
AUTHENTICATED = "authenticated"
SPECIAL_VALUES = frozenset({"public", AUTHENTICATED, "partner-signed"})


def _expand(*groups: str) -> frozenset[str]:
    """"notes:read|create" -> {"notes:read", "notes:create"}."""
    result: set[str] = set()
    for group in groups:
        resource, actions = group.split(":", 1)
        result.update(f"{resource}:{action}" for action in actions.split("|"))
    return frozenset(result)


CATALOGUE: frozenset[str] = _expand(
    # Platform (Thulasi)
    "users:read|create|update", "roles:read", "user-roles:update", "audit-events:read",
    "chart-access-reports:read", "patients:break-glass", "integration-messages:read|replay",
    # Patients (Vimal)
    "patients:search|read|create|update|restrict",
    "coverages:read|create|update|entered-in-error",  # entered-in-error: D45 (T40)
    "consents:read|create", "timeline:read", "duplicates:read|merge|dismiss",  # dismiss: D46
    "patient-merges:read|undo",  # read: D51 (T41)
    "pre-registrations:read|accept|reject",  # the front desk's queue (D96, T47)
    # Scheduling, eligibility (Vimal)
    "slots:read", "status-board:read",
    "appointments:read|create|update|cancel|check-in|undo-check-in|reschedule|status",  # D55, D61
    "scheduling-reference:read",  # booking reference lists (D49, T41)
    "eligibility-checks:read|create",
    # Encounters and notes (Vimal)
    "encounters:read|create|update|close|entered-in-error", "vitals:read|create|entered-in-error",
    "diagnoses:create|remove|entered-in-error", "codes:read",
    "notes:read|create|update|sign|cosign|entered-in-error", "note-addenda:create",
    "favorites:read|update", "after-visit-summaries:create", "cosign-rules:read|create|update",
    # History (Vimal)
    "problems:read|create|update|entered-in-error", "allergies:read|create|update|entered-in-error",
    "family-history:read|create|entered-in-error", "social-history:read|create|entered-in-error",
    "surgical-history:read|create|entered-in-error",
    # AI (Vimal)
    "encounter-audio:create", "transcriptions:read|create", "note-drafts:create",
    "chart-summaries:read|create", "ai-suggestions:decision", "ai-settings:read|update",
    # Medications (Thulasi)
    "medications:read|create|discontinue", "medication-reconciliations:create",
    "prescriptions:read|create|update|safety-check|sign-and-send|cancel|change|entered-in-error",
    "alerts:override", "refill-requests:read|respond", "pharmacies:read",
    "medication-history:fetch",
    # Orders and results (Thulasi)
    "lab-compendium:read",
    "orders:read|create|medical-necessity-check|sign-and-send|cancel|entered-in-error",
    "results:read|acknowledge", "unmatched-results:read|match|reject", "in-office-results:create",
    # Files, setup, billing, documents (Anand)
    "files:create|read", "practice-setup:read|create|update", "onboarding:import",
    # T38: the payer directory (GET /payers, #230–231), read-only, for the roles that add insurance
    # or run eligibility checks: FD, BIL, ADM (SECURITY_MODEL §4.3). Practice payers stay under
    # practice-setup:*.
    "payers:read",
    "lab-providers:read",  # lab providers, read-only (D48, T40)
    "consent-requirements:read",  # D59 (T41); writing them stays under practice-setup:*
    "provider-schedules:create|update",  # schedule blocks, split from practice-setup:* (D66, T41)
    # Note templates (D73, A46, T42): clinicians read the practice's templates to start a note and
    # keep personal ones; practice templates are still written under practice-setup:*.
    "note-templates:read|create-personal",
    "superbills:read|update", "claims:read|create|scrub|submit|status-check|correct|void",
    "payments:create|card-session", "remittances:read|post", "billing-reports:read",
    "documents:read|create|update", "faxes:create", "fax-inbox:read|file", "ccda:import|export",
    "inbox:read|update|complete", "messages:create", "exports:read|create",
    # Communications and dashboard (Minalini)
    "message-templates:read|create|update", "communication-preferences:read|update",
    "communications:read", "operations-dashboard:read",
)

# Reusable groups from the matrix rows.
_PATIENT_LOOKUP = _expand("patients:search|read")
_SCHEDULE_READ = _expand("slots:read", "appointments:read", "status-board:read")
_BOOKING_REFERENCE = _expand("scheduling-reference:read")  # FD, MA, RN, MD, APP, BIL (D49)
# D55, D61, D66: front desk and practice admin run the schedule; clinicians are read-only (D67).
_SCHEDULE_DESK = _expand(
    "appointments:create|update|cancel|check-in|undo-check-in|reschedule",
    "provider-schedules:create|update", "consent-requirements:read",
)
_CHART_READ = _expand(
    "timeline:read", "encounters:read", "notes:read", "vitals:read", "problems:read",
    "allergies:read", "family-history:read", "social-history:read", "surgical-history:read",
)
_CLINICAL_ENTERED_IN_ERROR = _expand(
    "vitals:entered-in-error", "diagnoses:entered-in-error", "notes:entered-in-error",
    "problems:entered-in-error", "allergies:entered-in-error", "family-history:entered-in-error",
    "social-history:entered-in-error", "surgical-history:entered-in-error",
)
_MED_READ = _expand("medications:read", "prescriptions:read", "refill-requests:read",
                    "pharmacies:read")
# gap: the draft matrix has no rows for these; they follow the prescription-draft row.
_RX_DRAFT = _expand("prescriptions:create|update|safety-check|entered-in-error",
                    "medication-reconciliations:create", "medications:create",
                    "medication-history:fetch")
_RX_PRESCRIBE = _expand("prescriptions:sign-and-send|cancel|change", "alerts:override",
                        "refill-requests:respond", "medications:discontinue")
# gap: orders:read, results:read, lab-compendium:read, medical-necessity-check and draft
# entered-in-error are not in the draft matrix; they follow the order-create row.
_ORDER_READ = _expand("orders:read", "results:read", "lab-compendium:read", "lab-providers:read")
_ORDER_DRAFT = _ORDER_READ | _expand(
    "orders:create|medical-necessity-check|entered-in-error", "in-office-results:create"
)
_ORDER_SIGN = _expand("orders:sign-and-send|cancel", "results:acknowledge")
_UNMATCHED = _expand("unmatched-results:read|match|reject")
_DOCUMENTS = _expand("documents:read|create|update", "fax-inbox:read|file", "faxes:create")
_INBOX = _expand("inbox:read|update|complete", "messages:create")
_COMMS = _expand("communication-preferences:read|update", "communications:read")
_FILES = _expand("files:create|read")  # gap: not in the draft matrix
_CLINICIAN_WRITE = _expand(
    "encounters:create|update|close", "diagnoses:create|remove", "notes:create|update|sign",
    "note-addenda:create", "after-visit-summaries:create", "problems:create|update",
    "family-history:create", "social-history:create", "surgical-history:create",
)
_AI_CLINICAL = _expand("encounter-audio:create", "transcriptions:read|create",
                       "note-drafts:create", "chart-summaries:read|create",
                       "ai-suggestions:decision")
# encounters:update: MA and RN record the encounter's reasons at rooming (T52, Minalini on #114);
# the encounters service lets them change `reasons` only, anything else is 403.
_ROOMING = _expand("vitals:create", "allergies:create|update", "appointments:status",
                   "encounters:update")

_MD = frozenset().union(
    _PATIENT_LOOKUP, _SCHEDULE_READ, _BOOKING_REFERENCE, _CHART_READ, _CLINICIAN_WRITE,
    _ROOMING, _AI_CLINICAL,
    _CLINICAL_ENTERED_IN_ERROR, _MED_READ, _RX_DRAFT, _RX_PRESCRIBE, _ORDER_DRAFT, _ORDER_SIGN,
    _UNMATCHED, _DOCUMENTS, _INBOX, _COMMS, _FILES,
    _expand("coverages:read", "eligibility-checks:read", "consents:read|create",
            "encounters:entered-in-error", "codes:read", "favorites:read|update",
            "superbills:read", "ccda:import|export", "patients:break-glass",
            "operations-dashboard:read", "notes:cosign",
            "note-templates:read|create-personal"),
)

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    # Front desk
    "FD": frozenset().union(
        _PATIENT_LOOKUP, _SCHEDULE_READ, _BOOKING_REFERENCE, _SCHEDULE_DESK, _DOCUMENTS,
        _INBOX, _COMMS, _FILES,
        # No duplicates:read (D64): duplicate review is in the admin portal; the front desk only
        # sees the 409 possible-duplicate warning when registering.
        _expand("patients:create|update", "coverages:read|create|update|entered-in-error",
                "payers:read", "pharmacies:read",
                "eligibility-checks:read|create", "consents:read|create",
                "appointments:status", "codes:read",
                "payments:create|card-session", "ccda:import|export",
                "operations-dashboard:read",
                "pre-registrations:read|accept|reject"),  # D96, T47
    ),
    # Medical assistant (rooming). Orders: point-of-care results only, as in §4.3; no order entry.
    "MA": frozenset().union(
        _PATIENT_LOOKUP, _SCHEDULE_READ, _BOOKING_REFERENCE, _CHART_READ, _ROOMING, _MED_READ,
        _ORDER_READ, _DOCUMENTS, _INBOX, _COMMS, _FILES,
        _expand("coverages:read", "eligibility-checks:read", "consents:read|create",
                "codes:read", "medication-reconciliations:create", "medications:create",
                "medication-history:fetch", "in-office-results:create", "patients:break-glass",
                "note-templates:read"),
    ),
    # Nurse
    "RN": frozenset().union(
        _PATIENT_LOOKUP, _SCHEDULE_READ, _BOOKING_REFERENCE, _CHART_READ, _ROOMING,
        _CLINICAL_ENTERED_IN_ERROR,
        _MED_READ, _RX_DRAFT, _ORDER_DRAFT, _UNMATCHED, _DOCUMENTS, _INBOX, _COMMS, _FILES,
        _expand("coverages:read", "eligibility-checks:read", "consents:read|create",
                # Nursing notes only: the notes service refuses other note types for RN (T42).
                "notes:create|update|sign", "note-addenda:create",
                "note-templates:read|create-personal",
                "codes:read", "favorites:read|update",
                "ccda:import|export", "patients:break-glass", "operations-dashboard:read"),
    ),
    # Physician
    "MD": _MD,
    # Advanced practice provider: as MD, without co-signing or unmatched results
    "APP": _MD - _expand("notes:cosign") - _UNMATCHED,
    # Biller: edits coverage, not demographics (T14)
    "BIL": frozenset().union(
        _PATIENT_LOOKUP, _SCHEDULE_READ, _BOOKING_REFERENCE, _INBOX,
        _expand("coverages:read|create|update|entered-in-error", "payers:read",
                "eligibility-checks:read|create",
                "consents:read", "encounters:read", "notes:read", "codes:read",
                "superbills:read|update",
                "claims:read|create|scrub|submit|status-check|correct|void",
                "payments:create|card-session", "remittances:read|post", "billing-reports:read",
                "documents:read", "files:read", "integration-messages:read",
                "operations-dashboard:read"),
    ),
    # Practice administrator: no clinical access by default
    "ADM": frozenset().union(
        _PATIENT_LOOKUP, _SCHEDULE_READ, _SCHEDULE_DESK, _INBOX, _COMMS,
        _expand("patients:create|update|restrict",
                "coverages:read|create|update|entered-in-error",
                "eligibility-checks:read|create", "consents:read|create",
                "duplicates:read|merge|dismiss", "patient-merges:read|undo",
                "pre-registrations:read|accept|reject",  # D96, T47
                "lab-providers:read", "encounters:entered-in-error",
                "codes:read", "ai-settings:read|update", "cosign-rules:read|create|update",
                "practice-setup:read|create|update", "note-templates:read", "payers:read",
                "onboarding:import",
                "message-templates:read|create|update", "users:read|create|update",
                "roles:read", "user-roles:update", "superbills:read", "claims:read",
                "remittances:read", "billing-reports:read", "exports:read|create",
                "integration-messages:read|replay", "operations-dashboard:read",
                # gap: upload the onboarding import file and download exports; the file
                # service limits which file purposes each role may use.
                "files:create|read"),
    ),
    # Compliance / privacy officer
    "CO": frozenset().union(
        _PATIENT_LOOKUP, _CHART_READ,
        _expand("patients:restrict", "consents:read", "duplicates:read", "patient-merges:read",
                "consent-requirements:read", "ai-settings:read",
                "cosign-rules:read", "practice-setup:read", "note-templates:read",
                "lab-providers:read",
                "message-templates:read",
                "users:read", "roles:read", "exports:read|create", "audit-events:read",
                "chart-access-reports:read", "patients:break-glass",
                "communication-preferences:read", "communications:read",
                "files:read"),  # gap: download exports
    ),
    # Shri platform support: no PHI by default
    "SUP": _expand("users:read", "roles:read", "integration-messages:read|replay"),
    # T39: a shared display (waiting-room or hallway status board), never a person. It reads the
    # status board only, which shows it initials plus appointment time (SECURITY_MODEL §8 rule 11).
    "DSP": _expand("status-board:read"),
}

ROLES = frozenset(ROLE_PERMISSIONS)

SHARED_DISPLAY_ROLE = "DSP"


def is_known_permission(permission: str) -> bool:
    return permission in CATALOGUE or permission == AUTHENTICATED


def roles_allow(roles: Iterable[str], permission: str) -> bool:
    if permission == AUTHENTICATED:
        return True
    return any(permission in ROLE_PERMISSIONS.get(role, frozenset()) for role in roles)
