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


def test_the_nine_roles_exist() -> None:
    assert set(ROLE_PERMISSIONS) == {"FD", "MA", "RN", "MD", "APP", "BIL", "ADM", "CO", "SUP"}


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
    ],
)
def test_matrix_rows(role: str, permission: str, allowed: bool) -> None:
    assert roles_allow({role}, permission) is allowed


def test_permissions_of_several_roles_combine() -> None:
    assert roles_allow({"ADM", "MD"}, "notes:read")
    assert roles_allow({"ADM", "MD"}, "users:create")


def test_authenticated_is_open_to_any_signed_in_user() -> None:
    assert roles_allow(set(), "authenticated")
