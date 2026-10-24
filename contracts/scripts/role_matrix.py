"""Read the role matrix from SECURITY_MODEL.md §4.3 and §4.4 and compare it with core.

The matrix is the documented source of who may do what; backend/app/core/permissions.py is
the code. This script reads every row of both tables and turns each cell into the exact set of
permissions it grants, so a backend test can assert that the two agree (issue #25, item 2).

    python3 contracts/scripts/role_matrix.py          # compare with core; exit 1 on any difference

From a test, use read_matrix() and pass the catalogue, so this file never imports the backend:

    from role_matrix import read_matrix
    expected = read_matrix(SECURITY_MODEL_PATH, CATALOGUE)

Cells are read like this:
- "✓" grants the whole row; "–" grants nothing; "R" grants the row's read and search permissions.
- A cell that names permissions in backticks grants exactly those, e.g. R (`superbills:read`).
- Other qualified cells are listed in CELLS below with what they mean, so a new wording fails
  loudly instead of being guessed.
- Text in parentheses in the first column is a remark, never a grant.
"""

from __future__ import annotations

import re
import sys
from collections.abc import Iterable
from pathlib import Path

ROLES = ("FD", "MA", "RN", "MD", "APP", "BIL", "ADM", "CO", "SUP", "DSP")
HISTORY = ("problems", "allergies", "family-history", "social-history", "surgical-history")
READ_ACTIONS = ("read", "search")
REPO = Path(__file__).resolve().parents[2]
SECURITY_MODEL = REPO / "contracts" / "docs" / "SECURITY_MODEL.md"

# Row names written in words rather than as permission names.
ROW_PHRASES: dict[str, set[str]] = {
    "history `:read`": {f"{h}:read" for h in HISTORY},
    "other history writes": {"problems:create", "problems:update", "family-history:create",
                             "social-history:create", "surgical-history:create"},
    "`*:entered-in-error` (clinical)": {"vitals:entered-in-error", "diagnoses:entered-in-error",
                                        "notes:entered-in-error",
                                        *(f"{h}:entered-in-error" for h in HISTORY)},
    "Medications and prescriptions: read": {"medications:read", "prescriptions:read",
                                            "refill-requests:read"},
    "`integration-messages:read` (metadata only), `:replay`": {"integration-messages:replay"},
}

# Qualified cells: "ALL" = the whole row, "READ" = its read part, or the exact permissions.
# Service rules in the wording ("own entries", "checked out") do not change the permission.
CELLS: dict[str, str | set[str]] = {
    "R": "READ",
    "R (investigations)": "READ",
    "R (signed notes, diagnoses)": {"encounters:read", "notes:read"},
    "✓ (checked out)": "ALL",
    "✓ (roomed)": "ALL",
    "✓ (own entries)": "ALL",
    "✓ (only encounters with no signed note)": "ALL",
    "✓ (reconcile)": {"medication-reconciliations:create"},
    "✓ (point-of-care results)": {"in-office-results:create"},
    "✓ (status-board only, shared view; D47)": {"status-board:read"},
    "– (BIL edits coverage only)": set(),
}

_UNESCAPED_PIPE = re.compile(r"(?<!\\)\|")
_NAME = re.compile(r"`([a-z*-]+:[a-z|*-]+)`")


def _names(text: str, catalogue: frozenset[str]) -> set[str]:
    """Permission names in backticks; `x:a|b` expands, `x:*` means every x permission."""
    found: set[str] = set()
    for name in _NAME.findall(text):
        resource, actions = name.split(":", 1)
        if resource == "*":
            continue  # "`*:entered-in-error`" is handled by ROW_PHRASES
        if actions == "*":
            found |= {p for p in catalogue if p.startswith(resource + ":")}
        else:
            found |= {f"{resource}:{a}" for a in actions.split("|")}
    return found


def _rows(markdown: str, start: str, end: str) -> Iterable[list[str]]:
    section = markdown[markdown.index(start):markdown.index(end)]
    for line in section.splitlines():
        if not line.startswith("|") or line.startswith("|---"):
            continue
        cells = [c.strip().replace("\\|", "|")
                 for c in _UNESCAPED_PIPE.split(line.strip().strip("|"))]
        if cells[0].startswith("Permission"):
            continue  # header row
        yield cells


def read_matrix(path: Path, catalogue: Iterable[str]) -> dict[str, set[str]]:
    """Every role's permissions as SECURITY_MODEL §4.3 and §4.4 grant them."""
    catalogue = frozenset(catalogue)
    text = path.read_text(encoding="utf-8")
    granted: dict[str, set[str]] = {role: set() for role in ROLES}
    tables = (("| Permission group |", "Notes on the matrix"), ("### 4.4", "## 5. "))
    for start, end in tables:
        for cells in _rows(text, start, end):
            if len(cells) < 1 + len(ROLES):
                raise ValueError(f"row has {len(cells)} cells, expected at least 11: {cells[0]}")
            row = _names(re.sub(r"\([^)]*\)", "", cells[0]), catalogue)
            row |= set().union(*(p for k, p in ROW_PHRASES.items() if k in cells[0]))
            if not row:
                raise ValueError(f"no permissions found in row: {cells[0]}")
            for role, cell in zip(ROLES, cells[1:1 + len(ROLES)]):
                if cell == "–":
                    continue
                if cell == "✓":
                    granted[role] |= row
                    continue
                meaning = CELLS.get(cell)
                if meaning is None:
                    named = _names(cell, catalogue)
                    if not named:
                        raise ValueError(f"cannot read cell {cell!r} ({role}) in row: {cells[0]}")
                    meaning = named
                if meaning == "ALL":
                    granted[role] |= row
                elif meaning == "READ":
                    granted[role] |= {p for p in row if p.split(":", 1)[1] in READ_ACTIONS}
                else:
                    granted[role] |= set(meaning)
    unknown = set().union(*granted.values()) - catalogue
    if unknown:
        raise ValueError(f"matrix names permissions that are not in the catalogue: {sorted(unknown)}")
    return granted


def compare(documented: dict[str, set[str]], core: dict[str, frozenset[str]],
            catalogue: Iterable[str]) -> list[str]:
    """Human-readable differences; empty when the matrix and core agree."""
    problems = [f"in no matrix row: {p}"
                for p in sorted(set(catalogue) - set().union(*documented.values()))]
    for role in ROLES:
        problems += [f"{role}: matrix grants, core does not: {p}"
                     for p in sorted(documented[role] - core[role])]
        problems += [f"{role}: core grants, matrix does not: {p}"
                     for p in sorted(core[role] - documented[role])]
    return problems


def main() -> int:
    sys.path.insert(0, str(REPO / "backend"))
    from app.core.permissions import CATALOGUE, ROLE_PERMISSIONS

    problems = compare(read_matrix(SECURITY_MODEL, CATALOGUE), ROLE_PERMISSIONS, CATALOGUE)
    for line in problems:
        print(line)
    print(f"{len(problems)} difference(s) between SECURITY_MODEL §4.3/§4.4 and core.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
