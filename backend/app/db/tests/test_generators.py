"""The code generators and the serializer choose the right table for a column, every time.

A column can belong to several foreign keys (its own, the clinic-carrying composite key and
same-patient composite keys), and ``column.foreign_keys`` is a set. Picking any member of it made
the choice depend on hash order: the generator once wrote a touch trigger on patient_link that
updated related_person instead of patient. ``referenced_table()`` makes the choice explicit.
No database needed.
"""

import re
from pathlib import Path

import pytest
from sqlalchemy import ForeignKeyConstraint, inspect

from app.db.constraints import referenced_table
from app.db.models import MAPPERS
from app.db.tools import gen_db_rules

BACKEND = Path(__file__).resolve().parents[3]
FROZEN_0002 = BACKEND / "app/db/alembic/versions/sql_0002/20_fhir_versioning.sql"


def _parent_and_reference_columns() -> list[tuple[str, str]]:
    out = []
    for name, cls in sorted(MAPPERS.items()):
        table = cls.__table__
        out += [(name, col) for col in getattr(cls, "fhir_parent", ())]
        out += [(name, c.name) for c in table.columns
                if c.info.get("fhir_type") == "Reference" and c.foreign_keys]
    return out


def test_referenced_table_is_the_columns_own_foreign_key_target() -> None:
    checked = 0
    for name, col in _parent_and_reference_columns():
        table = MAPPERS[name].__table__
        own = [fk for fk in table.constraints
               if isinstance(fk, ForeignKeyConstraint) and list(fk.columns) == [table.c[col]]]
        assert len(own) == 1, f"{name}.{col} has {len(own)} single-column foreign keys"
        assert referenced_table(table.c[col]) is own[0].referred_table, f"{name}.{col}"
        checked += 1
    assert checked > 0


def test_patient_link_belongs_to_patient() -> None:
    # The case that went wrong: patient_link.patient_id is also part of a same-patient key
    # that points at related_person.
    column = MAPPERS["patient_link"].__table__.c.patient_id
    assert {fk.column.table.name for fk in column.foreign_keys} > {"patient"}
    assert referenced_table(column).name == "patient"


def test_each_fhir_relationship_has_one_key_column() -> None:
    # The serializer takes the one key column of each FHIR relationship; it must be one.
    for name, cls in MAPPERS.items():
        for rel in inspect(cls).relationships:
            if "fhir" in rel.info:
                assert len(rel._calculated_foreign_keys) == 1, f"{name}.{rel.key}"


def test_frozen_touch_triggers_name_the_right_parents() -> None:
    """Every touch trigger in migration 0002's frozen SQL updates the table its column points at."""
    sql = FROZEN_0002.read_text()
    pairs = 0
    pattern = (r"CREATE TRIGGER trg_\w+_touch AFTER [^\n]+ ON \w+\.(\w+)\n\s+FOR EACH ROW "
               r"EXECUTE FUNCTION shri_fhir_touch_parent\(([^)]*)\)")
    for match in re.finditer(pattern, sql):
        table = MAPPERS[match.group(1)].__table__
        args = [a.strip().strip("'") for a in match.group(2).split(",")]
        for column, parent in zip(args[0::3], args[1::3], strict=True):
            assert referenced_table(table.c[column]).name == parent, (match.group(1), column)
            pairs += 1
    assert pairs > 0


def _own_target(table_name: str, column: str) -> str:
    table = MAPPERS[table_name].__table__
    own = [fk for fk in table.constraints
           if isinstance(fk, ForeignKeyConstraint) and list(fk.columns) == [table.c[column]]]
    assert len(own) == 1, f"{table_name}.{column}"
    return str(own[0].referred_table.name)


def test_choice_does_not_depend_on_the_order_of_foreign_keys(
        monkeypatch: pytest.MonkeyPatch) -> None:
    """The patient_link case, forced: in every order of its foreign keys, the column still
    points at patient. Taking the first key, as the generators used to, does not."""
    column = MAPPERS["patient_link"].__table__.c.patient_id
    keys = list(column.foreign_keys)
    orders = [keys, list(reversed(keys)),
              sorted(keys, key=lambda fk: fk.column.table.name != "related_person")]
    first_picks = set()
    for order in orders:
        monkeypatch.setattr(column, "foreign_keys", order)
        assert referenced_table(column).name == "patient"
        first_picks.add(order[0].column.table.name)
    assert "related_person" in first_picks  # the old rule would have been wrong here


def test_generated_touch_triggers_name_the_right_parents() -> None:
    sql = gen_db_rules.versioning_sql()
    pattern = (r"CREATE TRIGGER trg_\w+_touch AFTER [^\n]+ ON \w+\.(\w+)\n\s+FOR EACH ROW "
               r"EXECUTE FUNCTION shri_fhir_touch_parent\(([^)]*)\)")
    pairs = 0
    for match in re.finditer(pattern, sql):
        args = [a.strip().strip("'") for a in match.group(2).split(",")]
        for column, parent in zip(args[0::3], args[1::3], strict=True):
            assert _own_target(match.group(1), column) == parent, (match.group(1), column)
            pairs += 1
    assert pairs > 0


def test_generated_child_map_names_the_right_parents() -> None:
    entries = 0
    for parent, children in gen_db_rules.child_map().items():
        for child, column in children:
            assert _own_target(child, column) == parent, (child, column)
            entries += 1
    assert entries > 0


def test_no_unordered_foreign_key_pick_in_generators_or_serializer() -> None:
    sources = [*sorted((BACKEND / "app/db/tools").glob("*.py")),
               BACKEND / "app/fhir/serializer.py"]
    for source in sources:
        assert not re.search(r"next\(iter\([^)]*\.foreign_keys\b", source.read_text()), source


def test_data_dictionary_is_deterministic_and_covers_every_table() -> None:
    from app.db.tools import gen_docs

    first, second = gen_docs.data_dictionary(), gen_docs.data_dictionary()
    assert first == second
    for name, cls in MAPPERS.items():
        assert f"\n## `{cls.__table__.schema}.{name}`\n" in first, name


def test_tables_cell_cross_references_are_not_the_resources_tables() -> None:
    """Coverage's Tables cell ends "payers in Ad (`payer`, `practice_payer`)": those belong to
    /payers and /practice-payers, not to the patient's Coverage (Vimal, #45)."""
    from app.db.tools import gen_docs

    coverage = next(r for r in gen_docs.ownership() if r.name == "Coverage (insurance)")
    assert coverage.tables[0] == "coverage"
    assert not {"payer", "practice_payer"} & set(coverage.tables)


def test_contract_mapping_overrides_name_real_things() -> None:
    from app.db.tools import gen_docs

    resources, contract = gen_docs.ownership(), gen_docs.Contract()
    mapped = gen_docs.overrides(resources, contract)       # raises on anything unknown
    assert mapped["Coverage (insurance)"]["memberId"]["columns"][0] == "identifier.value"
    section = "\n".join(gen_docs._mapping_section(resources, contract))
    assert "| `undoneAt` | `patient_merge.unmerged_at` | mapped |" in section
    assert "| `visitStatus` |" in section and "computed:" in section


def test_updated_at_of_a_fhir_resource_is_its_meta_last_updated() -> None:
    """A change to child rows only (a phone, a coverage class) moves meta_last_updated, through
    the touch triggers, and leaves updated_at alone, so the contract's updatedAt must come from
    meta_last_updated, as the ETag and Written.last_updated do (Vimal's review of #87)."""
    from app.db.models import MAPPERS
    from app.db.tools import gen_docs

    resources, contract = gen_docs.ownership(), gen_docs.Contract()
    mapped = gen_docs.overrides(resources, contract)
    checked = []
    for r in resources:
        table = r.tables[0] if r.tables else None
        if (table in MAPPERS and "meta_last_updated" in MAPPERS[table].__table__.c
                and "updatedAt" in gen_docs._properties(r, contract)):
            checked.append(r.name)
            assert mapped.get(r.name, {}).get("updatedAt", {}).get("columns") == [
                f"{table}.meta_last_updated"], r.name
    assert "Patient (demographics, contacts)" in checked


@pytest.mark.parametrize(("entry", "complaint"), [
    ('"Consents":\n  signedFormFileId:\n    columns: [consent.no_such_column]\n', "no column"),
    ('"Consents":\n  noSuchProperty:\n    columns: [consent.id]\n', "no contract property"),
    ('"No such resource":\n  id:\n    columns: [consent.id]\n', "not a DATA_OWNERSHIP"),
    ('"Consents":\n  signedFormFileId: {note: nothing stored}\n', "needs columns or computed"),
])
def test_contract_mapping_overrides_cannot_drift(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                 entry: str, complaint: str) -> None:
    from app.db.tools import gen_docs

    override = tmp_path / "contract_mapping.yaml"
    override.write_text(entry)
    monkeypatch.setattr(gen_docs, "OVERRIDES", override)
    with pytest.raises(ValueError, match=complaint):
        gen_docs.overrides(gen_docs.ownership(), gen_docs.Contract())
