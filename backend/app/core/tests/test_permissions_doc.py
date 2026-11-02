"""The generated §4.3 table (core/permissions_doc.py): Vimal's parser reads it back to exactly
core's grants, every permission is in one row, and --check catches a stale copy. It never reads
or writes SECURITY_MODEL itself; a temporary file stands in for it."""

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

from app.core import permissions_doc
from app.core.permissions import CATALOGUE, ROLE_PERMISSIONS
from app.core.permissions_doc import END, START, check, main, rows, section, table, write

REPO = Path(__file__).resolve().parents[4]
ROLE_MATRIX_SCRIPT = REPO / "contracts" / "scripts" / "role_matrix.py"


def _role_matrix() -> ModuleType:
    spec = importlib.util.spec_from_file_location("role_matrix", ROLE_MATRIX_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _model(tmp_path: Path, generated: str) -> Path:
    """A SECURITY_MODEL stand-in with §4.3 (the generated table) and an empty §4.4."""
    path = tmp_path / "SECURITY_MODEL.md"
    path.write_text("### 4.3 Draft role-to-permission matrix\n\n" + generated
                    + "\n\nNotes on the matrix: hand-written prose stays.\n\n"
                    "### 4.4 Gap rows\n\n## 5. Next section\n", encoding="utf-8")
    return path


def test_vimals_parser_reads_the_table_back_to_exactly_cores_grants(tmp_path: Path) -> None:
    documented = _role_matrix().read_matrix(_model(tmp_path, section()), CATALOGUE)
    assert set(documented) == set(permissions_doc.COLUMNS)
    for role in permissions_doc.COLUMNS:
        assert documented[role] == set(ROLE_PERMISSIONS.get(role, frozenset())), role
    assert _role_matrix().compare(documented, ROLE_PERMISSIONS, CATALOGUE) == []


def test_every_permission_is_in_exactly_one_row() -> None:
    named: list[str] = []
    for first, _ in rows():
        resource, actions = first.removeprefix("‡ ").strip("`").split(":", 1)
        named += [f"{resource}:{action}" for action in actions.split("\\|")]
    assert sorted(named) == sorted(CATALOGUE)


def test_every_cell_is_a_tick_or_a_dash_and_the_columns_are_section_4_3s() -> None:
    lines = table().splitlines()
    assert lines[0] == "| Permission group | FD | MA | RN | MD | APP | BIL | ADM | CO | SUP | DSP |"
    for line in lines[2:]:
        cells = [c.strip() for c in line.strip("|").split(" | ")]
        assert len(cells) == 11 and set(cells[1:]) <= {"✓", "–"}, line


def test_clinical_rows_carry_the_advisors_mark() -> None:
    marked = {first for first, _ in rows() if first.startswith("‡ ")}
    assert any(m.startswith("‡ `encounters:") for m in marked)
    assert not any("practice-setup" in m for m in marked)


def test_the_output_is_stable() -> None:
    assert table() == table() and section().startswith(START) and section().endswith(END)


def test_check_passes_on_a_fresh_copy_and_fails_on_a_stale_or_missing_one(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    fresh = _model(tmp_path, section())
    assert check(fresh) == [] and main(["--check", str(fresh)]) == 0
    stale = tmp_path / "stale.md"
    stale.write_text(fresh.read_text(encoding="utf-8").replace("| ✓ |", "| – |", 1),
                     encoding="utf-8")
    assert check(stale) and main(["--check", str(stale)]) == 1
    assert "stale" in capsys.readouterr().err
    missing = tmp_path / "missing.md"
    missing.write_text("### 4.3\n| Permission group | FD |\n", encoding="utf-8")
    assert check(missing) and "no generated permissions table" in check(missing)[0]


def test_a_permission_change_in_core_makes_the_copy_stale(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    copy = _model(tmp_path, section())
    granted = dict(ROLE_PERMISSIONS)
    granted["SUP"] = granted["SUP"] | {"patients:read"}
    monkeypatch.setattr(permissions_doc, "ROLE_PERMISSIONS", granted)
    assert check(copy)  # core changed, the document didn't
    write(copy)
    assert check(copy) == []
    assert "hand-written prose stays" in copy.read_text(encoding="utf-8")


def test_write_refuses_a_file_without_the_markers(tmp_path: Path) -> None:
    plain = tmp_path / "plain.md"
    plain.write_text("no markers here\n", encoding="utf-8")
    with pytest.raises(SystemExit):
        write(plain)
    assert plain.read_text(encoding="utf-8") == "no markers here\n"


def _marked(markdown: str) -> set[str]:
    """The permissions in ‡ rows, read with role_matrix.py's own row parser."""
    import re

    matrix = _role_matrix()
    found: set[str] = set()
    for start, end in (("| Permission group |", "Notes on the matrix"), ("### 4.4", "## 5. ")):
        for cells in matrix._rows(markdown, start, end):  # noqa: SLF001
            if "‡" in cells[0]:
                found |= matrix._names(re.sub(r"\([^)]*\)", "", cells[0]),  # noqa: SLF001
                                       frozenset(CATALOGUE))
                found |= set().union(*(p for k, p in matrix.ROW_PHRASES.items() if k in cells[0]))
    return found


def test_the_marks_are_exactly_today_s_section_4_3() -> None:
    """Vimal's review of #135: ‡ is per permission; generating the table must not change which
    rows wait for the clinical advisors (Q21)."""
    today = _marked((REPO / "contracts" / "docs" / "SECURITY_MODEL.md").read_text(encoding="utf-8"))
    assert permissions_doc.CLINICAL_REVIEW == today


def test_the_generated_table_marks_exactly_those(tmp_path: Path) -> None:
    generated = _marked(_model(tmp_path, section()).read_text(encoding="utf-8"))
    assert generated == permissions_doc.CLINICAL_REVIEW
    assert "appointments:status" in generated and "appointments:create" not in generated
    assert "patients:break-glass" in generated
