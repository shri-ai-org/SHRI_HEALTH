"""The whole role matrix: core grants exactly what SECURITY_MODEL §4.3 and §4.4 say (issue #25).

Every (role, permission) pair is checked, so a swapped column or a missed row fails CI. The
matrix is read with Vimal's contracts/scripts/role_matrix.py, which never imports the backend.
"""

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

from app.core.permissions import CATALOGUE, ROLE_PERMISSIONS

REPO = Path(__file__).resolve().parents[4]
SECURITY_MODEL = REPO / "contracts" / "docs" / "SECURITY_MODEL.md"
ROLE_MATRIX_SCRIPT = REPO / "contracts" / "scripts" / "role_matrix.py"


def _load_role_matrix() -> ModuleType:
    spec = importlib.util.spec_from_file_location("role_matrix", ROLE_MATRIX_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


role_matrix = _load_role_matrix()
DOCUMENTED: dict[str, set[str]] = role_matrix.read_matrix(SECURITY_MODEL, CATALOGUE)


def test_the_matrix_has_the_same_roles_as_core() -> None:
    assert set(role_matrix.ROLES) == set(ROLE_PERMISSIONS)


def test_every_permission_is_in_a_matrix_row() -> None:
    assert sorted(CATALOGUE - set().union(*DOCUMENTED.values())) == []


@pytest.mark.parametrize("role", sorted(ROLE_PERMISSIONS))
def test_core_grants_exactly_what_the_matrix_grants(role: str) -> None:
    assert sorted(DOCUMENTED[role] - ROLE_PERMISSIONS[role]) == [], "matrix grants, core does not"
    assert sorted(ROLE_PERMISSIONS[role] - DOCUMENTED[role]) == [], "core grants, matrix does not"


def test_a_swapped_column_would_fail() -> None:
    # Guards the test itself: two roles' columns swapped must show up as differences.
    swapped = {**DOCUMENTED, "FD": DOCUMENTED["MA"], "MA": DOCUMENTED["FD"]}
    assert role_matrix.compare(swapped, ROLE_PERMISSIONS, CATALOGUE)
