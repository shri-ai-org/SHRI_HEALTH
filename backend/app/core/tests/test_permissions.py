import pytest

from app.core.deps import DEV_USERS
from app.core.permissions import CATALOGUE, PERMISSION_FORMAT, ROLE_PERMISSIONS, roles_allow

PHI_RESOURCES = {
    "patients", "timeline", "encounters", "notes", "vitals", "problems", "allergies",
    "medications", "prescriptions", "orders", "results", "documents", "coverages",
}


def test_catalogue_names_follow_the_naming_rule() -> None:
    assert all(PERMISSION_FORMAT.match(p) for p in CATALOGUE)


def test_roles_only_grant_catalogue_permissions() -> None:
    for role, granted in ROLE_PERMISSIONS.items():
        assert granted <= CATALOGUE, (role, granted - CATALOGUE)


def test_the_ten_roles_exist() -> None:
    assert set(ROLE_PERMISSIONS) == {
        "FD", "MA", "RN", "MD", "APP", "BIL", "ADM", "CO", "SUP", "DSP"
    }


def test_shared_display_reads_the_status_board_only() -> None:
    # T39: a waiting-room screen holds no permission beyond the status board.
    assert ROLE_PERMISSIONS["DSP"] == {"status-board:read"}
    assert DEV_USERS["dsp"].is_shared_display
    assert not DEV_USERS["fd"].is_shared_display


def test_one_dev_user_per_role_and_two_clinics() -> None:
    roles = {role for user in DEV_USERS.values() for role in user.roles}
    assert roles == set(ROLE_PERMISSIONS)
    assert len({user.organization_id for user in DEV_USERS.values()}) == 2


def test_support_staff_get_no_phi() -> None:
    assert not {p.split(":")[0] for p in ROLE_PERMISSIONS["SUP"]} & PHI_RESOURCES


@pytest.mark.parametrize(
    ("role", "permission", "allowed"),
    [
        ("BIL", "coverages:update", True),
        ("BIL", "patients:update", False),  # T14: biller edits coverage, not demographics
        ("ADM", "notes:read", False),  # admins have no clinical access by default
        ("ADM", "patients:restrict", True),
        ("CO", "audit-events:read", True),
        ("MD", "audit-events:read", False),
        ("MD", "notes:cosign", True),
        ("APP", "notes:cosign", False),
        ("APP", "unmatched-results:match", False),
        ("RN", "unmatched-results:reject", True),
        ("FD", "notes:read", False),
        ("FD", "appointments:check-in", True),
        ("MA", "prescriptions:sign-and-send", False),
        ("MD", "prescriptions:sign-and-send", True),
        ("RN", "encounters:entered-in-error", False),
        # Vimal's two §4.4 differences, settled on PR #10
        ("MA", "orders:create", False),
        ("MA", "orders:medical-necessity-check", False),
        ("MA", "in-office-results:create", True),
        ("MA", "results:read", True),
        ("ADM", "files:create", True),
        ("ADM", "onboarding:import", True),
        ("CO", "files:read", True),
        ("CO", "files:create", False),
        # T38: who may read the payer list
        ("FD", "payers:read", True),
        ("BIL", "payers:read", True),
        ("ADM", "payers:read", True),
        ("CO", "payers:read", False),
        ("MA", "payers:read", False),
        ("MD", "payers:read", False),
        ("FD", "practice-setup:read", False),  # reading payers does not open practice setup
        ("DSP", "patients:read", False),
        ("DSP", "appointments:read", False),
        # T40 (SECURITY_MODEL §4.3, D45, D46, D48)
        ("FD", "coverages:entered-in-error", True),
        ("BIL", "coverages:entered-in-error", True),
        ("ADM", "coverages:entered-in-error", True),
        ("MD", "coverages:entered-in-error", False),
        ("ADM", "duplicates:dismiss", True),
        ("FD", "duplicates:dismiss", False),
        ("CO", "duplicates:dismiss", False),
        ("MA", "lab-providers:read", True),
        ("RN", "lab-providers:read", True),
        ("MD", "lab-providers:read", True),
        ("APP", "lab-providers:read", True),
        ("ADM", "lab-providers:read", True),
        ("CO", "lab-providers:read", True),
        ("FD", "lab-providers:read", False),
        ("BIL", "lab-providers:read", False),
        # T41 (SECURITY_MODEL §4.3 on #20, D49–D67)
        ("FD", "duplicates:read", False),  # D64: admin portal only
        ("ADM", "duplicates:read", True),
        ("ADM", "patient-merges:read", True),
        ("CO", "patient-merges:read", True),  # "R" in the duplicates row
        ("FD", "patient-merges:read", False),
        ("FD", "scheduling-reference:read", True),
        ("MA", "scheduling-reference:read", True),
        ("RN", "scheduling-reference:read", True),
        ("MD", "scheduling-reference:read", True),
        ("APP", "scheduling-reference:read", True),
        ("BIL", "scheduling-reference:read", True),
        ("ADM", "scheduling-reference:read", False),
        ("FD", "pharmacies:read", True),
        ("MA", "pharmacies:read", True),
        ("BIL", "pharmacies:read", False),
        ("FD", "appointments:undo-check-in", True),
        ("ADM", "appointments:reschedule", True),
        ("MD", "appointments:reschedule", False),  # D67: clinicians read-only on appointments
        ("MD", "appointments:create", False),
        ("FD", "consent-requirements:read", True),
        ("ADM", "consent-requirements:read", True),
        ("CO", "consent-requirements:read", True),  # "R" in §4.3
        ("MA", "consent-requirements:read", False),
        ("FD", "provider-schedules:update", True),
        ("ADM", "provider-schedules:create", True),
        ("RN", "provider-schedules:update", False),
        # T42 (D73, A46): nurses sign nursing notes and write addenda; nobody but MD co-signs.
        ("RN", "notes:sign", True),
        ("RN", "note-addenda:create", True),
        ("RN", "notes:cosign", False),
        ("MA", "notes:sign", False),
        ("MA", "note-addenda:create", False),
        # Note templates: clinicians and ADM/CO read them; clinicians keep personal ones.
        ("MA", "note-templates:read", True),
        ("RN", "note-templates:create-personal", True),
        ("APP", "note-templates:create-personal", True),
        ("MA", "note-templates:create-personal", False),
        ("ADM", "note-templates:read", True),
        ("ADM", "note-templates:create-personal", False),
        ("CO", "note-templates:read", True),
        ("FD", "note-templates:read", False),
        ("BIL", "note-templates:read", False),
        ("SUP", "note-templates:read", False),
        # T52: MA and RN update the encounter (its reasons only, the service's rule) at rooming.
        ("MA", "encounters:update", True), ("RN", "encounters:update", True),
        ("MD", "encounters:update", True), ("APP", "encounters:update", True),
        ("FD", "encounters:update", False), ("BIL", "encounters:update", False),
        ("ADM", "encounters:update", False), ("DSP", "encounters:update", False),
        ("MA", "encounters:create", False), ("RN", "encounters:close", False),
    ],
)
def test_matrix_rows(role: str, permission: str, allowed: bool) -> None:
    assert roles_allow({role}, permission) is allowed


# Issue #25 item 1: the appointments rows of SECURITY_MODEL §4.3, every role, not samples.
# Front desk and practice admin run the schedule (D55, D61); clinicians are read-only on
# appointments and ask for changes through inbox tasks (D67); CO has no scheduling writes.
SCHEDULE_WRITES = [
    "appointments:create", "appointments:update", "appointments:cancel",
    "appointments:check-in", "appointments:undo-check-in", "appointments:reschedule",
]
SCHEDULE_WRITERS = {"FD", "ADM"}


@pytest.mark.parametrize("permission", SCHEDULE_WRITES)
@pytest.mark.parametrize("role", sorted(ROLE_PERMISSIONS))
def test_appointments_rows(role: str, permission: str) -> None:
    assert roles_allow({role}, permission) is (role in SCHEDULE_WRITERS), (role, permission)


def test_permissions_of_several_roles_combine() -> None:
    assert roles_allow({"ADM", "MD"}, "notes:read")
    assert roles_allow({"ADM", "MD"}, "users:create")


def test_authenticated_is_open_to_any_signed_in_user() -> None:
    assert roles_allow(set(), "authenticated")
