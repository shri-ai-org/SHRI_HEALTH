"""Role-to-permission map. STAND-IN until the contract's x-permission values exist.

Permissions are "<resource>:<action>" (for example "patients:write"). Entries here may use
a trailing wildcard ("patients:*") or "*" for everything. When Vimal's contract lists the
real permission names, this map is replaced with exact names; require() does not change.
"""

import re
from collections.abc import Iterable

PERMISSION_FORMAT = re.compile(r"^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$")

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "platform_admin": frozenset({"*"}),
    "practice_admin": frozenset({
        "practice_setup:*", "users:*", "roles:*", "audit:read", "reports:*", "exports:*",
        "onboarding:*", "message_templates:*", "dashboards:read", "integration:*",
    }),
    "doctor": frozenset({
        "patients:*", "scheduling:read", "eligibility:read", "encounters:*", "notes:*",
        "history:*", "medications:*", "prescriptions:*", "orders:*", "results:*",
        "documents:*", "files:*", "inbox:*", "ai:*", "dashboards:read",
    }),
    "nurse_ma": frozenset({
        "patients:*", "scheduling:*", "eligibility:read", "encounters:read", "encounters:write",
        "notes:read", "history:*", "medications:read", "orders:read", "results:read",
        "documents:*", "files:*", "inbox:*", "dashboards:read",
    }),
    "front_desk": frozenset({
        "patients:*", "scheduling:*", "eligibility:*", "documents:*", "files:*", "inbox:*",
        "communications:*", "dashboards:read",
    }),
    "biller": frozenset({
        "patients:read", "eligibility:*", "billing:*", "documents:read", "files:read",
        "inbox:*", "reports:read",
    }),
}


def is_valid_permission(permission: str) -> bool:
    return bool(PERMISSION_FORMAT.match(permission))


def roles_allow(roles: Iterable[str], permission: str) -> bool:
    resource = permission.split(":", 1)[0]
    for role in roles:
        granted = ROLE_PERMISSIONS.get(role, frozenset())
        if "*" in granted or permission in granted or f"{resource}:*" in granted:
            return True
    return False
